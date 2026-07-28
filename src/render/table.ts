import { rank, rankedBy, staleness } from '../ranking.js';
import type { Config } from '../config.js';
import type {
  ConnState,
  ExchangeName,
  PremiumIndexSource,
  RankMetric,
  StoreEntry,
} from '../types.js';
import { fmt, pad, truncate } from './screen.js';

const STATE_DOT: Record<ConnState, string> = {
  connected: fmt.green('●'),
  connecting: fmt.yellow('◐'),
  reconnecting: fmt.yellow('○'),
  disconnected: fmt.red('○'),
};

/** How each venue supplies its premium index, shown in the panel header. */
const SOURCE_LABEL: Record<PremiumIndexSource, string> = {
  stream: 'premium index: streamed',
  rest: 'premium index: REST 1m',
  none: 'premium index: not published',
};

function pct(v: number | undefined, digits = 4): string {
  if (v === undefined) return '—';
  return `${v >= 0 ? '+' : ''}${(v * 100).toFixed(digits)}%`;
}

function price(v: number | undefined): string {
  if (v === undefined) return '—';
  if (v >= 1000) return v.toFixed(2);
  if (v >= 1) return v.toFixed(4);
  return v.toPrecision(6);
}

function ageStr(ms: number): string {
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 120_000) return `${Math.round(ms / 1000)}s`;
  return `${Math.round(ms / 60_000)}m`;
}

function signed(v: number | undefined, stale: boolean): string {
  const s = pct(v);
  if (v === undefined) return fmt.dim(s);
  if (stale) return fmt.dim(s);
  return v >= 0 ? fmt.green(s) : fmt.red(s);
}

function basketLine(entry: StoreEntry): string {
  const b = entry.basket;
  if (!b) return fmt.dim('    basket: … (pending fetch)');
  if (!b.available) return fmt.dim('    basket: — (constituents not published via API)');
  if (b.constituents.length === 0) return fmt.dim('    basket: — (empty response)');
  const parts = b.constituents.map((c) => `${c.venue}:${c.symbol} ${(c.weight * 100).toFixed(1)}%`);
  return fmt.dim(`    basket: ${parts.join(' | ')}`);
}

/** The metric a venue's panel ranks by, given what it publishes. */
export function metricFor(source: PremiumIndexSource): RankMetric {
  return source === 'none' ? 'basis' : 'premium-index';
}

/**
 * Render one exchange panel. `PremIdx` is the exchange's own order-book premium
 * index; `Basis` is (mark−index)/index. They differ sharply on illiquid books,
 * so both are shown. A `~` marks a row ranked on basis because its premium
 * index has not arrived yet.
 */
export function renderPanel(
  exchange: ExchangeName,
  source: PremiumIndexSource,
  entries: StoreEntry[],
  state: ConnState,
  config: Config,
  now: number,
  width: number,
): string[] {
  const metric = metricFor(source);
  const metricName = metric === 'premium-index' ? 'premium index' : 'basis';
  // Premium index refreshes on its own (much slower) clock than the tick feed.
  const premiumIndexStaleMs = config.premiumIndexRefreshMs * 3;
  const lines: string[] = [];
  const title = ` ${STATE_DOT[state]} ${fmt.bold(exchange.toUpperCase())} ${fmt.dim(
    `(${entries.length} symbols, top ${config.topN} by ${config.sort} ${metricName} · ${SOURCE_LABEL[source]})`,
  )}`;
  lines.push(truncate(`┌${'─'.repeat(Math.max(0, width - 2))}┐`, width));
  lines.push(truncate(`│${title}`, width));
  lines.push(
    truncate(
      fmt.dim(
        `│ ${pad('#', 3)}${pad('Symbol', 14)}${pad('PremIdx', 12, 'right')}${pad('Basis', 12, 'right')}  ${pad('Mark', 14, 'right')}${pad('Index', 14, 'right')}${pad('Funding', 11, 'right')}${pad('Age', 7, 'right')}`,
      ),
      width,
    ),
  );

  const top = rank(entries, config.sort, config.topN, metric);
  if (top.length === 0) {
    lines.push(truncate(fmt.dim('│   waiting for data…'), width));
  }
  top.forEach((entry, i) => {
    const { ageMs, stale } = staleness(entry, now, config.stalenessMs);
    const t = entry.tick;
    const sym = stale ? fmt.dim(t.symbol) : t.symbol;
    const age = stale ? fmt.yellow(`${ageStr(ageMs)}!`) : fmt.dim(ageStr(ageMs));
    // Mark rows the panel wanted to rank on premium index but could not, and
    // dim a premium index that has outlived a few poll cycles (venue stopped
    // publishing it, or the sweep is falling behind).
    const fellBack = metric === 'premium-index' && rankedBy(entry, metric) === 'basis';
    const premIdxStale =
      entry.premiumIndexAt !== undefined && now - entry.premiumIndexAt > premiumIndexStaleMs;
    const premIdx = fellBack ? fmt.dim('~ —') : signed(entry.premiumIndex, stale || premIdxStale);
    const row = `│ ${pad(String(i + 1), 3)}${pad(sym, 14)}${pad(premIdx, 12, 'right')}${pad(signed(t.basis, stale), 12, 'right')}  ${pad(price(t.markPrice), 14, 'right')}${pad(price(t.indexPrice), 14, 'right')}${pad(pct(t.fundingRate), 11, 'right')}${pad(age, 7, 'right')}`;
    lines.push(truncate(row, width));
    lines.push(truncate(`│${basketLine(entry)}`, width));
  });
  lines.push(truncate(`└${'─'.repeat(Math.max(0, width - 2))}┘`, width));
  return lines;
}

/** Footer: per-exchange status dots, refresh interval, metric legend. */
export function renderFooter(
  states: Map<ExchangeName, ConnState>,
  config: Config,
  width: number,
): string[] {
  const dots = [...states.entries()].map(([ex, st]) => `${STATE_DOT[st]} ${ex}`).join('   ');
  const legend = fmt.dim(
    'PremIdx = exchange order-book premium index (binance REST 1m, okx streamed; bybit/bitget none) · ' +
      'Basis = (mark−index)/index · ~ = ranked on basis, premium index pending',
  );
  const legend2 = fmt.dim(
    `refresh ${config.refreshMs}ms · premium index every ${Math.round(config.premiumIndexRefreshMs / 1000)}s · stale >${config.stalenessMs}ms · read-only, no orders · Ctrl-C to exit`,
  );
  return [truncate(` ${dots}`, width), truncate(` ${legend}`, width), truncate(` ${legend2}`, width)];
}
