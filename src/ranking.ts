import type { RankMetric, SortDirection, StoreEntry } from './types.js';

/** Compute fractional basis (mark−index)/index; undefined when inputs unusable. */
export function computeBasis(mark: number | undefined, index: number | undefined): number | undefined {
  if (mark === undefined || index === undefined) return undefined;
  if (!Number.isFinite(mark) || !Number.isFinite(index) || index <= 0) return undefined;
  return (mark - index) / index;
}

/**
 * Value an entry is ranked by. When the panel ranks on premium index, entries
 * still missing their first REST/stream sample fall back to basis so they are
 * never silently dropped from the ranking — `rankedBy` reports which was used.
 */
export function rankValue(entry: StoreEntry, metric: RankMetric): number {
  if (metric === 'premium-index' && entry.premiumIndex !== undefined) return entry.premiumIndex;
  return entry.tick.basis;
}

export function rankedBy(entry: StoreEntry, metric: RankMetric): RankMetric {
  return metric === 'premium-index' && entry.premiumIndex !== undefined ? 'premium-index' : 'basis';
}

/** Rank entries by the panel's metric, top N. Pure — does not mutate input. */
export function rank(
  entries: readonly StoreEntry[],
  sort: SortDirection,
  topN: number,
  metric: RankMetric = 'basis',
): StoreEntry[] {
  const sorted = [...entries].sort((a, b) => {
    const av = rankValue(a, metric);
    const bv = rankValue(b, metric);
    return sort === 'highest' ? bv - av : av - bv;
  });
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
