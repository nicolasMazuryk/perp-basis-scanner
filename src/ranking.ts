import type { SortDirection, StoreEntry } from './types.js';

/** Compute fractional premium; returns undefined when inputs unusable. */
export function computePremium(mark: number | undefined, index: number | undefined): number | undefined {
  if (mark === undefined || index === undefined) return undefined;
  if (!Number.isFinite(mark) || !Number.isFinite(index) || index <= 0) return undefined;
  return (mark - index) / index;
}

/** Rank entries by premium, top N. Pure — does not mutate input. */
export function rank(entries: readonly StoreEntry[], sort: SortDirection, topN: number): StoreEntry[] {
  const sorted = [...entries].sort((a, b) =>
    sort === 'highest' ? b.tick.premium - a.tick.premium : a.tick.premium - b.tick.premium,
  );
  return sorted.slice(0, topN);
}

/** Age in ms and stale flag for an entry. */
export function staleness(
  entry: StoreEntry,
  now: number,
  thresholdMs: number,
): { ageMs: number; stale: boolean } {
  const ageMs = Math.max(0, now - entry.lastSeen);
  return { ageMs, stale: ageMs > thresholdMs };
}
