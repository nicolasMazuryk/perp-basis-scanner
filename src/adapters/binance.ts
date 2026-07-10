import type WebSocket from 'ws';
import { computePremium } from '../ranking.js';
import { ReconnectingSocket } from '../ws/reconnect.js';
import type { ExchangeName, IndexBasket, PremiumTick } from '../types.js';
import { BaseAdapter, num } from './base.js';

// March 2026 WS split: markPrice streams live on the /market endpoint;
// legacy /ws was decommissioned for them on 2026-04-23.
const WS_URL = 'wss://fstream.binance.com/market/ws/!markPrice@arr@1s';
const REST = 'https://fapi.binance.com';
/** Proactively reconnect before Binance's 24h forced disconnect. */
const LIFETIME_MS = 23 * 60 * 60 * 1000;

interface MarkPriceEvent {
  e: string; // "markPriceUpdate"
  E: number; // event time
  s: string; // symbol
  p: string; // mark price
  i: string; // index price
  r: string; // funding rate
  T: number; // next funding time
}

interface ExchangeInfoResponse {
  symbols: Array<{
    symbol: string;
    contractType: string;
    quoteAsset: string;
    status: string;
  }>;
}

interface ConstituentsResponse {
  symbol: string;
  constituents: Array<{ exchange: string; symbol: string; weight?: string | number }>;
}

/**
 * Binance USDⓈ-M futures. Single all-market stream `!markPrice@arr@1s`
 * carries mark, index, funding for every symbol — one subscription total.
 * Premium computed locally as (mark-index)/index.
 */
export class BinanceAdapter extends BaseAdapter {
  readonly name: ExchangeName = 'binance';
  private socket: ReconnectingSocket | undefined;
  private tracked = new Set<string>();

  async fetchSymbols(): Promise<string[]> {
    const info = await this.getJson<ExchangeInfoResponse>(`${REST}/fapi/v1/exchangeInfo`);
    const symbols = info.symbols
      .filter((s) => s.contractType === 'PERPETUAL' && s.quoteAsset === 'USDT' && s.status === 'TRADING')
      .map((s) => s.symbol);
    const filtered = this.filterAllowed(symbols);
    this.tracked = new Set(filtered);
    return filtered;
  }

  async fetchIndexBaskets(symbols: string[]): Promise<IndexBasket[]> {
    const baskets: IndexBasket[] = [];
    for (const symbol of symbols) {
      try {
        const res = await this.getJson<ConstituentsResponse>(
          `${REST}/fapi/v1/constituents?symbol=${symbol}`,
        );
        baskets.push({
          exchange: this.name,
          symbol,
          available: true,
          constituents: (res.constituents ?? [])
            .map((c) => ({ venue: c.exchange, symbol: c.symbol, weight: num(c.weight) ?? 0 }))
            .sort((a, b) => b.weight - a.weight),
          fetchedAt: Date.now(),
        });
      } catch (err) {
        this.logParseError(`constituents ${symbol}`, err);
      }
      await this.sleep(150); // polite REST spacing
    }
    return baskets;
  }

  async connect(): Promise<void> {
    if (this.tracked.size === 0) await this.fetchSymbols();
    this.socket = new ReconnectingSocket({
      name: 'binance',
      url: WS_URL,
      // Stream is in the URL path — nothing to send on open.
      onOpen: (_ws: WebSocket) => {},
      onMessage: (data) => this.handleMessage(data.toString()),
      onStateChange: (s) => this.updateSocketState('binance', s),
      // Binance server pings every 3min; ws lib auto-pongs. Watchdog catches dead pipes.
      silenceTimeoutMs: 5 * 60 * 1000,
      maxLifetimeMs: LIFETIME_MS,
    });
    this.socket.connect();
  }

  disconnect(): void {
    this.socket?.close();
    this.socket = undefined;
  }

  private handleMessage(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      this.logParseError('json', err);
      return;
    }
    if (!Array.isArray(parsed)) return; // subscribe acks etc.
    for (const item of parsed as MarkPriceEvent[]) {
      const tick = this.normalize(item);
      if (tick) this.emitTick(tick);
    }
  }

  /** Normalize one markPriceUpdate event; exported path tested via fixtures. */
  normalize(ev: MarkPriceEvent): PremiumTick | undefined {
    if (ev?.e !== 'markPriceUpdate' || typeof ev.s !== 'string') return undefined;
    if (!this.allowed(ev.s) || (this.tracked.size > 0 && !this.tracked.has(ev.s))) return undefined;
    const mark = num(ev.p);
    const index = num(ev.i);
    const premium = computePremium(mark, index);
    if (premium === undefined) return undefined;
    const tick: PremiumTick = {
      exchange: this.name,
      symbol: ev.s,
      premium,
      premiumNative: false,
      timestamp: num(ev.E) ?? Date.now(),
    };
    if (mark !== undefined) tick.markPrice = mark;
    if (index !== undefined) tick.indexPrice = index;
    const funding = num(ev.r);
    if (funding !== undefined) tick.fundingRate = funding;
    const nft = num(ev.T);
    if (nft !== undefined) tick.nextFundingTime = nft;
    return tick;
  }
}
