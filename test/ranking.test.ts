import { describe, expect, it } from 'vitest';
import { computePremium, rank, staleness } from '../src/ranking.js';
import type { PremiumTick, StoreEntry } from '../src/types.js';

function entry(symbol: string, premium: number, lastSeen = 0): StoreEntry {
  const tick: PremiumTick = {
    exchange: 'binance',
    symbol,
    premium,
    premiumNative: false,
    timestamp: lastSeen,
  };
  return { tick, lastSeen };
}

describe('computePremium', () => {
  it('computes (mark-index)/index', () => {
    expect(computePremium(101, 100)).toBeCloseTo(0.01, 10);
    expect(computePremium(99, 100)).toBeCloseTo(-0.01, 10);
    expect(computePremium(100, 100)).toBe(0);
  });

  it('rejects unusable inputs', () => {
    expect(computePremium(undefined, 100)).toBeUndefined();
    expect(computePremium(100, undefined)).toBeUndefined();
    expect(computePremium(100, 0)).toBeUndefined();
    expect(computePremium(100, -5)).toBeUndefined();
    expect(computePremium(NaN, 100)).toBeUndefined();
    expect(computePremium(100, Infinity)).toBeUndefined();
  });
});

describe('rank', () => {
  const entries = [entry('A', 0.001), entry('B', -0.002), entry('C', 0.005), entry('D', 0)];

  it('highest = premium descending', () => {
    expect(rank(entries, 'highest', 10).map((e) => e.tick.symbol)).toEqual(['C', 'A', 'D', 'B']);
  });

  it('lowest = premium ascending', () => {
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
