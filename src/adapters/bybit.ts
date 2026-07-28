import type WebSocket from 'ws';
import { computeBasis } from '../ranking.js';
import { ReconnectingSocket } from '../ws/reconnect.js';
import type { ExchangeName, IndexBasket, PremiumIndexSource, PremiumTick } from '../types.js';
import { BaseAdapter, chunk, num } from './base.js';

const WS_URL = 'wss://stream.bybit.com/v5/public/linear';
const REST = 'https://api.bybit.com';
/** Topics per subscribe message — well under the 21k-char args cap. */
const TOPICS_PER_MSG = 200;

interface TickerData {
  symbol: string;
  markPrice?: string;
  indexPrice?: string;
  fundingRate?: string;
  nextFundingTime?: string;
}

interface TickerMessage {
  topic?: string;
  type?: string; // "snapshot" | "delta"
  ts?: number;
  data?: TickerData;
}

interface InstrumentsResponse {
  result: {
    list: Array<{ symbol: string; quoteCoin: string; contractType: string; status: string }>;
    nextPageCursor?: string;
  };
}

/** Merged per-symbol ticker state (Bybit sends snapshot then partial deltas). */
interface MergedTicker {
  markPrice?: number;
  indexPrice?: number;
  fundingRate?: number;
  nextFundingTime?: number;
}

/**
 * Bybit v5 linear. `tickers.{symbol}` is snapshot+delta: deltas carry only
 * changed fields, so we overlay onto a per-symbol cache before computing
 * basis. App-level {"op":"ping"} every 20s. Publishes neither index
 * constituents nor a premium index, so both are reported unavailable and
 * ranking falls back to basis.
 */
export class BybitAdapter extends BaseAdapter {
  readonly name: ExchangeName = 'bybit';
  readonly premiumIndexSource: PremiumIndexSource = 'none';
  private socket: ReconnectingSocket | undefined;
  private symbols: string[] = [];
  private readonly merged = new Map<string, MergedTicker>();

  async fetchSymbols(): Promise<string[]> {
    const all: string[] = [];
    let cursor = '';
    do {
      const url = `${REST}/v5/market/instruments-info?category=linear&limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const res = await this.getJson<InstrumentsResponse>(url);
      for (const inst of res.result.list) {
        if (inst.quoteCoin === 'USDT' && inst.contractType === 'LinearPerpetual' && inst.status === 'Trading') {
          all.push(inst.symbol);
        }
      }
      cursor = res.result.nextPageCursor ?? '';
    } while (cursor);
    this.symbols = this.filterAllowed(all);
    return this.symbols;
  }

  /** Bybit does not publish index constituents via API. */
  async fetchIndexBaskets(symbols: string[]): Promise<IndexBasket[]> {
    return symbols.map((symbol) => ({
      exchange: this.name,
      symbol,
      available: false,
      constituents: [],
      fetchedAt: Date.now(),
    }));
  }

  async connect(): Promise<void> {
    if (this.symbols.length === 0) await this.fetchSymbols();
    this.socket = new ReconnectingSocket({
      name: 'bybit',
      url: WS_URL,
      onOpen: (ws: WebSocket) => {
        this.merged.clear(); // fresh snapshots will arrive; stale cache must not leak into deltas
        for (const batch of chunk(this.symbols, TOPICS_PER_MSG)) {
          ws.send(JSON.stringify({ op: 'subscribe', args: batch.map((s) => `tickers.${s}`) }));
        }
      },
      onMessage: (data) => this.handleMessage(data.toString()),
      onStateChange: (s) => this.updateSocketState('bybit', s),
      heartbeat: { intervalMs: 20_000, payload: () => JSON.stringify({ op: 'ping' }) },
      silenceTimeoutMs: 60_000,
    });
    this.socket.connect();
  }

  disconnect(): void {
    this.socket?.close();
    this.socket = undefined;
    this.merged.clear();
  }

  private handleMessage(raw: string): void {
    let msg: TickerMessage;
    try {
      msg = JSON.parse(raw) as TickerMessage;
    } catch (err) {
      this.logParseError('json', err);
      return;
    }
    const tick = this.normalize(msg);
    if (tick) this.emitTick(tick);
  }

  /**
   * Merge snapshot/delta into per-symbol cache, emit tick when mark+index
   * known. Snapshot replaces cache; delta overlays changed fields only.
   */
  normalize(msg: TickerMessage): PremiumTick | undefined {
    if (!msg.topic?.startsWith('tickers.') || !msg.data) return undefined;
    const symbol = msg.data.symbol;
    if (typeof symbol !== 'string' || !this.allowed(symbol)) return undefined;

    let state = this.merged.get(symbol);
    if (msg.type === 'snapshot' || !state) {
      state = {};
      this.merged.set(symbol, state);
    }
    const mark = num(msg.data.markPrice);
    const index = num(msg.data.indexPrice);
    const funding = num(msg.data.fundingRate);
    const nft = num(msg.data.nextFundingTime);
    if (mark !== undefined) state.markPrice = mark;
    if (index !== undefined) state.indexPrice = index;
    if (funding !== undefined) state.fundingRate = funding;
    if (nft !== undefined) state.nextFundingTime = nft;

    const basis = computeBasis(state.markPrice, state.indexPrice);
    if (basis === undefined) return undefined;
    const tick: PremiumTick = {
      exchange: this.name,
      symbol,
      basis,
      timestamp: msg.ts ?? Date.now(),
    };
    if (state.markPrice !== undefined) tick.markPrice = state.markPrice;
    if (state.indexPrice !== undefined) tick.indexPrice = state.indexPrice;
    if (state.fundingRate !== undefined) tick.fundingRate = state.fundingRate;
    if (state.nextFundingTime !== undefined) tick.nextFundingTime = state.nextFundingTime;
    return tick;
  }
}
