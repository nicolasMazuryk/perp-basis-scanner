import { describe, expect, it } from 'vitest';
import { computeBasis, rank, rankValue, rankedBy, staleness } from '../src/ranking.js';
import type { PremiumTick, StoreEntry } from '../src/types.js';

function entry(symbol: string, basis: number, lastSeen = 0, premiumIndex?: number): StoreEntry {
  const tick: PremiumTick = {
    exchange: 'binance',
    symbol,
    basis,
    timestamp: lastSeen,
  };
  const e: StoreEntry = { tick, lastSeen };
  if (premiumIndex !== undefined) {
    e.premiumIndex = premiumIndex;
    e.premiumIndexAt = lastSeen;
  }
  return e;
}

describe('computeBasis', () => {
  it('computes (mark-index)/index', () => {
    expect(computeBasis(101, 100)).toBeCloseTo(0.01, 10);
    expect(computeBasis(99, 100)).toBeCloseTo(-0.01, 10);
    expect(computeBasis(100, 100)).toBe(0);
  });

  it('rejects unusable inputs', () => {
    expect(computeBasis(undefined, 100)).toBeUndefined();
    expect(computeBasis(100, undefined)).toBeUndefined();
    expect(computeBasis(100, 0)).toBeUndefined();
    expect(computeBasis(100, -5)).toBeUndefined();
    expect(computeBasis(NaN, 100)).toBeUndefined();
    expect(computeBasis(100, Infinity)).toBeUndefined();
  });
});

describe('rank', () => {
  const entries = [entry('A', 0.001), entry('B', -0.002), entry('C', 0.005), entry('D', 0)];

  it('highest = basis descending', () => {
    expect(rank(entries, 'highest', 10).map((e) => e.tick.symbol)).toEqual(['C', 'A', 'D', 'B']);
  });

  it('lowest = basis ascending', () => {
    expect(rank(entries, 'lowest', 10).map((e) => e.tick.symbol)).toEqual(['B', 'D', 'A', 'C']);
  });

  it('respects topN', () => {
    expect(rank(entries, 'highest', 2).map((e) => e.tick.symbol)).toEqual(['C', 'A']);
  });

  it('does not mutate input', () => {
    const copy = [...entries];
    rank(entries, 'highest', 2);
    expect(entries).toEqual(copy);
  });
});

describe('ranking on premium index vs basis', () => {
  // The IDOLUSDT case: a big mark-vs-index basis on an illiquid book whose
  // order-book premium index is clamped to zero. Ranking on basis promotes it;
  // ranking on premium index does not.
  const illiquid = entry('IDOLUSDT', 0.006434, 0, 0);
  const liquid = entry('GTCUSDT', 0.002, 0, 0.0045);

  it('premium-index metric ranks by the exchange premium index, not basis', () => {
    const top = rank([illiquid, liquid], 'highest', 2, 'premium-index');
    expect(top.map((e) => e.tick.symbol)).toEqual(['GTCUSDT', 'IDOLUSDT']);
  });

  it('basis metric ranks the same pair the other way round', () => {
    const top = rank([illiquid, liquid], 'highest', 2, 'basis');
    expect(top.map((e) => e.tick.symbol)).toEqual(['IDOLUSDT', 'GTCUSDT']);
  });

  it('a zero premium index is used, not treated as missing', () => {
    expect(rankValue(illiquid, 'premium-index')).toBe(0);
    expect(rankedBy(illiquid, 'premium-index')).toBe('premium-index');
  });

  it('falls back to basis when the premium index has not arrived yet', () => {
    const pending = entry('NEWUSDT', 0.003);
    expect(rankValue(pending, 'premium-index')).toBe(0.003);
    expect(rankedBy(pending, 'premium-index')).toBe('basis');
  });

  it('basis metric ignores a present premium index', () => {
    expect(rankValue(liquid, 'basis')).toBe(0.002);
    expect(rankedBy(liquid, 'basis')).toBe('basis');
  });
});

describe('staleness', () => {
  it('fresh under threshold', () => {
    const e = entry('A', 0, 1000);
    expect(staleness(e, 3000, 5000)).toEqual({ ageMs: 2000, stale: false });
  });

  it('stale over threshold', () => {
    const e = entry('A', 0, 1000);
    expect(staleness(e, 7001, 5000)).toEqual({ ageMs: 6001, stale: true });
  });

  it('clamps negative age (clock skew)', () => {
    const e = entry('A', 0, 10_000);
    expect(staleness(e, 9000, 5000).ageMs).toBe(0);
  });
});
