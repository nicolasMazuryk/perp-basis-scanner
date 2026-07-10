#!/usr/bin/env node
import { excludedFor, loadConfig } from './config.js';
import { log } from './log.js';
import { TickStore } from './store.js';
import { Screen } from './render/screen.js';
import { renderFooter, renderPanel } from './render/table.js';
import { BinanceAdapter } from './adapters/binance.js';
import { BybitAdapter } from './adapters/bybit.js';
import { OkxAdapter } from './adapters/okx.js';
import { BitgetAdapter } from './adapters/bitget.js';
import type { ConnState, ExchangeAdapter, ExchangeName } from './types.js';

async function main(): Promise<void> {
  const config = loadConfig(process.argv);
  log.init(config.logFile);
  log.info('scanner starting', { config: { ...config } });

  const store = new TickStore();
  const states = new Map<ExchangeName, ConnState>();
  const factories: Record<ExchangeName, (deny: string[]) => ExchangeAdapter> = {
    binance: (deny) => new BinanceAdapter(config.symbols, deny),
    bybit: (deny) => new BybitAdapter(config.symbols, deny),
    okx: (deny) => new OkxAdapter(config.symbols, deny),
    bitget: (deny) => new BitgetAdapter(config.symbols, deny),
  };

  const adapters: ExchangeAdapter[] = config.exchanges.map((name) => {
    const excluded = excludedFor(config, name);
    if (excluded.length > 0) log.info('symbols excluded', { exchange: name, symbols: excluded });
    const adapter = factories[name](excluded);
    states.set(name, 'connecting');
    adapter.on('tick', (tick) => store.upsertTick(tick));
    adapter.on('state', (s) => states.set(name, s));
    return adapter;
  });

  // Connect all venues in parallel; one failing must not block others.
  await Promise.allSettled(
    adapters.map(async (a) => {
      try {
        await a.connect();
      } catch (err) {
        log.error('adapter connect failed', { exchange: a.name, err: String(err) });
        states.set(a.name, 'disconnected');
        // Retry whole adapter bootstrap (symbol fetch may have failed).
        setTimeout(function retry() {
          a.disconnect(); // drop any partial state before rebootstrapping
          a.connect().catch((e: unknown) => {
            log.error('adapter reconnect failed', { exchange: a.name, err: String(e) });
            setTimeout(retry, 15_000);
          });
        }, 15_000);
      }
    }),
  );

  // Basket refresh: parallel across adapters (independent hosts), polite
  // spacing inside each adapter's own fetch loop.
  const refreshBaskets = async (): Promise<void> => {
    await Promise.allSettled(
      adapters.map(async (adapter) => {
        try {
          // Only symbols with no basket yet or one nearing expiry — keeps the
          // 60s catch-up pass from re-fetching what the first pass covered.
          const cutoff = Date.now() - config.basketRefreshMs * 0.9;
          const symbols = [
            ...new Set(
              store
                .snapshot(adapter.name)
                .filter((e) => !e.basket || e.basket.fetchedAt < cutoff)
                .map((e) => e.tick.symbol),
            ),
          ];
          if (symbols.length === 0) return;
          // Fetch in chunks and upsert per chunk so baskets appear on screen
          // incrementally (a full-universe fetch takes minutes on Binance/OKX).
          let count = 0;
          for (let i = 0; i < symbols.length; i += 25) {
            const baskets = await adapter.fetchIndexBaskets(symbols.slice(i, i + 25));
            for (const b of baskets) store.upsertBasket(b);
            count += baskets.length;
          }
          log.info('baskets refreshed', { exchange: adapter.name, count });
        } catch (err) {
          log.warn('basket refresh failed', { exchange: adapter.name, err: String(err) });
        }
      }),
    );
  };
  // First pass once sockets populate the store; second pass catches venues
  // whose streams were still empty at the first (slow REST bootstrap).
  const initialBasketTimers = [
    setTimeout(() => void refreshBaskets(), 5000),
    setTimeout(() => void refreshBaskets(), 60_000),
  ];
  const basketInterval = setInterval(() => void refreshBaskets(), config.basketRefreshMs);

  const screen = new Screen();
  screen.enter();

  const paint = (): void => {
    const now = Date.now();
    const width = screen.width();
    const lines: string[] = [];
    for (const adapter of adapters) {
      lines.push(
        ...renderPanel(
          adapter.name,
          store.snapshot(adapter.name),
          states.get(adapter.name) ?? 'disconnected',
          config,
          now,
          width,
        ),
      );
    }
    lines.push(...renderFooter(states, config, width));
    screen.paint(lines);
  };

  const renderTimer = setInterval(paint, config.refreshMs);
  paint();
  process.stdout.on('resize', paint);

  const shutdown = (): void => {
    clearInterval(renderTimer);
    clearInterval(basketInterval);
    for (const t of initialBasketTimers) clearTimeout(t);
    for (const a of adapters) a.disconnect();
    screen.leave();
    log.info('scanner stopped');
    log.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err: unknown) => {
  process.stderr.write(`fatal: ${String(err)}\n`);
  process.exit(1);
});
