import type { EventEmitter } from 'node:events';

/** Canonical exchange identifiers. */
export type ExchangeName = 'binance' | 'bybit' | 'okx' | 'bitget';

export const ALL_EXCHANGES: readonly ExchangeName[] = ['binance', 'bybit', 'okx', 'bitget'];

/**
 * Where an exchange's true premium index comes from, if anywhere.
 * - `stream`: pushed on the WebSocket feed (OKX funding-rate channel).
 * - `rest`: only available by polling (Binance premiumIndexKlines, 1m).
 * - `none`: exchange does not publish one (Bybit, Bitget).
 */
export type PremiumIndexSource = 'stream' | 'rest' | 'none';

/**
 * One normalized observation for a symbol on an exchange.
 * Symbols are normalized to Binance-style concatenated form, e.g. "BTCUSDT".
 *
 * Two distinct quantities, never conflated:
 * - `basis` = (mark − index) / index, computed from the stream, always present.
 * - `premiumIndex` = the exchange's own order-book premium index, e.g. Binance's
 *   `[Max(0, ImpactBid − Index) − Max(0, Index − ImpactAsk)] / Index`. Present
 *   only where the venue publishes it. It is zero whenever the index sits inside
 *   the impact spread, so it diverges sharply from `basis` on illiquid books.
 *
 * Both are fractional (0.001 = 0.1%).
 */
export interface PremiumTick {
  exchange: ExchangeName;
  symbol: string;
  basis: number;
  /** Set only by adapters whose feed streams a premium index (OKX). */
  premiumIndex?: number;
  markPrice?: number;
  indexPrice?: number;
  fundingRate?: number;
  nextFundingTime?: number;
  /** Exchange event time if provided, else local receive time (ms epoch). */
  timestamp: number;
}

/** A premium index observation fetched out-of-band over REST. */
export interface PremiumIndexSample {
  symbol: string;
  premiumIndex: number;
  /** When the exchange stamped it (ms epoch), not when we received it. */
  at: number;
}

/** One spot-venue component of an index-price basket. */
export interface IndexConstituent {
  venue: string;
  symbol: string;
  /** Fractional weight (0.35 = 35%). */
  weight: number;
}

export interface IndexBasket {
  exchange: ExchangeName;
  symbol: string;
  /** False when the exchange does not publish constituents via API (Bybit, Bitget). */
  available: boolean;
  constituents: IndexConstituent[];
  fetchedAt: number;
}

export type ConnState = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

export interface AdapterEvents {
  tick: [PremiumTick];
  state: [ConnState, string?];
}

/**
 * Contract every exchange adapter implements. Adapters own symbol-form
 * mapping internally and emit only normalized ticks.
 */
export interface ExchangeAdapter extends EventEmitter<AdapterEvents> {
  readonly name: ExchangeName;
  readonly premiumIndexSource: PremiumIndexSource;
  /** REST: list tradeable USDT linear-perp symbols (normalized), post filter. */
  fetchSymbols(): Promise<string[]>;
  /** REST: index baskets for given normalized symbols. Unavailable => available:false, constituents:[]. */
  fetchIndexBaskets(symbols: string[]): Promise<IndexBasket[]>;
  /** REST: premium index for given symbols. Only implemented when source is `rest`. */
  fetchPremiumIndex?(symbols: string[]): Promise<PremiumIndexSample[]>;
  /** Open sockets and subscribe. Resolves once first connection established. */
  connect(): Promise<void>;
  disconnect(): void;
}

export interface StoreEntry {
  tick: PremiumTick;
  /**
   * Latest premium index, whether streamed on the tick or polled over REST.
   * Kept outside `tick` so a 1 Hz stream update never clobbers a 1-minute
   * REST sample.
   */
  premiumIndex?: number;
  premiumIndexAt?: number;
  basket?: IndexBasket;
  lastSeen: number;
}

export type SortDirection = 'highest' | 'lowest';

/** Which quantity a panel is ranked and reported by. */
export type RankMetric = 'premium-index' | 'basis';
