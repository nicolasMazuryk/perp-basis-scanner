import type { EventEmitter } from 'node:events';

/** Canonical exchange identifiers. */
export type ExchangeName = 'binance' | 'bybit' | 'okx' | 'bitget';

export const ALL_EXCHANGES: readonly ExchangeName[] = ['binance', 'bybit', 'okx', 'bitget'];

/**
 * One normalized premium observation for a symbol on an exchange.
 * Symbols are normalized to Binance-style concatenated form, e.g. "BTCUSDT".
 * `premium` is fractional (0.001 = 0.1%). `native` marks exchange-published
 * premium (OKX funding-rate channel) vs locally computed (mark-index)/index.
 */
export interface PremiumTick {
  exchange: ExchangeName;
  symbol: string;
  premium: number;
  premiumNative: boolean;
  markPrice?: number;
  indexPrice?: number;
  fundingRate?: number;
  nextFundingTime?: number;
  /** Exchange event time if provided, else local receive time (ms epoch). */
  timestamp: number;
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
  /** REST: list tradeable USDT linear-perp symbols (normalized), post allow-list filter. */
  fetchSymbols(): Promise<string[]>;
  /** REST: index baskets for given normalized symbols. Unavailable => available:false, constituents:[]. */
  fetchIndexBaskets(symbols: string[]): Promise<IndexBasket[]>;
  /** Open sockets and subscribe. Resolves once first connection established. */
  connect(): Promise<void>;
  disconnect(): void;
}

export interface StoreEntry {
  tick: PremiumTick;
  basket?: IndexBasket;
  lastSeen: number;
}

export type SortDirection = 'highest' | 'lowest';
