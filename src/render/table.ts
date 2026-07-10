import { rank, staleness } from '../ranking.js';
import type { Config } from '../config.js';
import type { ConnState, ExchangeName, StoreEntry } from '../types.js';
import { fmt, pad, truncate } from './screen.js';

const STATE_DOT: Record<ConnState, string> = {
  connected: fmt.green('●'),
  connecting: fmt.yellow('◐'),
  reconnecting: fmt.yellow('○'),
  disconnected: fmt.red('○'),
};

function pct(v: number | undefined, digits = 4): string {
  if (v === undefined) return '—';
  return `${(v * 100).toFixed(digits)}%`;
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

function premiumColored(premium: number, native: boolean, stale: boolean): string {
  const s = `${premium >= 0 ? '+' : ''}${pct(premium)}${native ? '*' : ''}`;
  if (stale) return fmt.dim(s);
  return premium >= 0 ? fmt.green(s) : fmt.red(s);
}

function basketLine(entry: StoreEntry): string {
  const b = entry.basket;
  if (!b) return fmt.dim('    basket: … (pending fetch)');
  if (!b.available) return fmt.dim('    basket: — (constituents not published via API)');
  if (b.constituents.length === 0) return fmt.dim('    basket: — (empty response)');
  const parts = b.constituents.map((c) => `${c.venue}:${c.symbol} ${(c.weight * 100).toFixed(1)}%`);
  return fmt.dim(`    basket: ${parts.join(' | ')}`);
}

/** Render one exchange panel: header, column row, topN entries + basket lines. */
export function renderPanel(
  exchange: ExchangeName,
  entries: StoreEntry[],
  state: ConnState,
  config: Config,
  now: number,
  width: number,
): string[] {
  const lines: string[] = [];
  const title = ` ${STATE_DOT[state]} ${fmt.bold(exchange.toUpperCase())} ${fmt.dim(`(${entries.length} symbols, top ${config.topN} by ${config.sort} premium)`)}`;
  lines.push(truncate(`┌${'─'.repeat(Math.max(0, width - 2))}┐`, width));
  lines.push(truncate(`│${title}`, width));
  lines.push(
    truncate(
      fmt.dim(
        `│ ${pad('#', 3)}${pad('Symbol', 14)}${pad('Premium', 12, 'right')}  ${pad('Mark', 14, 'right')}${pad('Index', 14, 'right')}${pad('Funding', 11, 'right')}${pad('Age', 7, 'right')}`,
      ),
      width,
    ),
  );

  const top = rank(entries, config.sort, config.topN);
  if (top.length === 0) {
    lines.push(truncate(fmt.dim('│   waiting for data…'), width));
  }
  top.forEach((entry, i) => {
    const { ageMs, stale } = staleness(entry, now, config.stalenessMs);
    const t = entry.tick;
    const sym = stale ? fmt.dim(t.symbol) : t.symbol;
    const age = stale ? fmt.yellow(`${ageStr(ageMs)}!`) : fmt.dim(ageStr(ageMs));
    const row = `│ ${pad(String(i + 1), 3)}${pad(sym, 14)}${pad(premiumColored(t.premium, t.premiumNative, stale), 12, 'right')}  ${pad(price(t.markPrice), 14, 'right')}${pad(price(t.indexPrice), 14, 'right')}${pad(pct(t.fundingRate), 11, 'right')}${pad(age, 7, 'right')}`;
    lines.push(truncate(row, width));
    lines.push(truncate(`│${basketLine(entry).slice(0)}`, width));
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
    `premium = (mark−index)/index · * = exchange-native (OKX) · refresh ${config.refreshMs}ms · stale >${config.stalenessMs}ms · read-only, no orders · Ctrl-C to exit`,
  );
  return [truncate(` ${dots}`, width), truncate(` ${legend}`, width)];
}
