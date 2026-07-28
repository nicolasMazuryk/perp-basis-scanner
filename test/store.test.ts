import { describe, expect, it } from 'vitest';
import { TickStore } from '../src/store.js';
import type { PremiumTick } from '../src/types.js';

const tick = (basis: number, premiumIndex?: number, ts = 1000): PremiumTick => {
  const t: PremiumTick = { exchange: 'binance', symbol: 'BTCUSDT', basis, timestamp: ts };
  if (premiumIndex !== undefined) t.premiumIndex = premiumIndex;
  return t;
};

describe('TickStore premium index handling', () => {
  it('a REST sample survives subsequent stream ticks that carry no premium index', () => {
    const store = new TickStore();
    store.upsertTick(tick(0.006));
    store.upsertPremiumIndex('binance', { symbol: 'BTCUSDT', premiumIndex: 0.0004, at: 2000 });

    // Binance streams mark/index once a second; none of those carry a premium
    // index, and they must not wipe the polled one.
    store.upsertTick(tick(0.0061));
    store.upsertTick(tick(0.0062));

    const [entry] = store.snapshot('binance');
    expect(entry!.premiumIndex).toBe(0.0004);
    expect(entry!.premiumIndexAt).toBe(2000);
    expect(entry!.tick.basis).toBe(0.0062);
  });

  it('a streamed premium index (OKX) promotes onto the entry', () => {
    const store = new TickStore();
    store.upsertTick(tick(0.001, 0.0009, 5000));
    const [entry] = store.snapshot('binance');
    expect(entry!.premiumIndex).toBe(0.0009);
    expect(entry!.premiumIndexAt).toBe(5000);
  });

  it('a zero premium index overwrites a previous non-zero one', () => {
    const store = new TickStore();
    store.upsertTick(tick(0.006));
    store.upsertPremiumIndex('binance', { symbol: 'BTCUSDT', premiumIndex: 0.0004, at: 2000 });
    store.upsertPremiumIndex('binance', { symbol: 'BTCUSDT', premiumIndex: 0, at: 3000 });
    expect(store.snapshot('binance')[0]!.premiumIndex).toBe(0);
  });

  it('a premium index for an unknown symbol is dropped, not resurrected as an entry', () => {
    const store = new TickStore();
    store.upsertPremiumIndex('binance', { symbol: 'GHOSTUSDT', premiumIndex: 0.01, at: 1 });
    expect(store.size()).toBe(0);
  });
});
