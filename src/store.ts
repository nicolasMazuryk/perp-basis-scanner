import type { ExchangeName, IndexBasket, PremiumTick, StoreEntry } from './types.js';

/**
 * Flat in-memory store keyed `exchange:symbol`. Ingestion is O(1) upsert;
 * no message history is retained, so memory is bounded by universe size.
 * Renderer pulls point-in-time snapshots — fully decoupled from message rate.
 */
export class TickStore {
  private readonly entries = new Map<string, StoreEntry>();

  private key(exchange: ExchangeName, symbol: string): string {
    return `${exchange}:${symbol}`;
  }

  upsertTick(tick: PremiumTick, now: number = Date.now()): void {
    const k = this.key(tick.exchange, tick.symbol);
    const existing = this.entries.get(k);
    if (existing) {
      existing.tick = tick;
      existing.lastSeen = now;
    } else {
      this.entries.set(k, { tick, lastSeen: now });
    }
  }

  upsertBasket(basket: IndexBasket): void {
    const entry = this.entries.get(this.key(basket.exchange, basket.symbol));
    if (entry) entry.basket = basket;
  }

  /** Shallow-copy snapshot of one exchange's entries for rendering/ranking. */
  snapshot(exchange: ExchangeName): StoreEntry[] {
    const prefix = `${exchange}:`;
    const out: StoreEntry[] = [];
    for (const [k, v] of this.entries) {
      if (k.startsWith(prefix)) out.push({ ...v });
    }
    return out;
  }

  size(): number {
    return this.entries.size;
  }
}
