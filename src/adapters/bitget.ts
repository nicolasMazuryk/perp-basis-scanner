import type WebSocket from 'ws';
import { computeBasis } from '../ranking.js';
import { ReconnectingSocket } from '../ws/reconnect.js';
import type { ExchangeName, IndexBasket, PremiumIndexSource, PremiumTick } from '../types.js';
import { BaseAdapter, chunk, num } from './base.js';

const WS_URL = 'wss://ws.bitget.com/v2/ws/public';
const REST = 'https://api.bitget.com';
/** Docs recommend <50 subscriptions per connection — shard accordingly. */
const SYMBOLS_PER_CONN = 50;
/** Inbound message limit is 10/s — space subscribe sends. */
const SUB_SPACING_MS = 120;

interface TickerData {
  instId: string;
  markPrice?: string;
  indexPrice?: string;
  fundingRate?: string;
  nextFundingTime?: string;
  ts?: string;
}

interface WsMessage {
  event?: string;
  action?: string; // "snapshot" | "update"
  arg?: { instType: string; channel: string; instId: string };
  data?: TickerData[];
}

interface ContractsResponse {
  data: Array<{ symbol: string; quoteCoin: string; symbolStatus: string; symbolType: string }>;
}

interface MergedTicker {
  markPrice?: number;
  indexPrice?: number;
  fundingRate?: number;
  nextFundingTime?: number;
}

/**
 * Bitget v2 USDT-FUTURES. `ticker` channel is snapshot+update; merge like
 * Bybit. Universe sharded across connections (~50 symbols each, per docs
 * recommendation). Raw "ping" heartbeat every 30s. Publishes neither index
 * constituents nor a premium index, so both are reported unavailable and
 * ranking falls back to basis.
 */
export class BitgetAdapter extends BaseAdapter {
  readonly name: ExchangeName = 'bitget';
  readonly premiumIndexSource: PremiumIndexSource = 'none';
  private sockets: ReconnectingSocket[] = [];
  private symbols: string[] = [];
  private readonly merged = new Map<string, MergedTicker>();

  async fetchSymbols(): Promise<string[]> {
    const res = await this.getJson<ContractsResponse>(
      `${REST}/api/v2/mix/market/contracts?productType=usdt-futures`,
    );
    const all = res.data
      .filter((c) => c.quoteCoin === 'USDT' && c.symbolStatus === 'normal' && c.symbolType === 'perpetual')
      .map((c) => c.symbol);
    this.symbols = this.filterAllowed(all);
    return this.symbols;
  }

  /** Bitget does not publish index constituents via API. */
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
    const shards = chunk(this.symbols, SYMBOLS_PER_CONN);
    this.sockets = shards.map((shard, i) => {
      const name = `bitget#${i}`;
      const socket: ReconnectingSocket = new ReconnectingSocket({
        name,
        url: WS_URL,
        onOpen: (ws: WebSocket) => {
          for (const s of shard) this.merged.delete(s);
          this.subscribeShard(ws, shard).catch((err: unknown) => {
            this.logParseError('subscribe shard', err);
          });
        },
        onMessage: (data) => this.handleMessage(data.toString()),
        onStateChange: (s) => this.updateSocketState(name, s),
        heartbeat: { intervalMs: 30_000, payload: () => 'ping' },
        silenceTimeoutMs: 60_000,
      });
      return socket;
    });
    // Stagger connection opens (3 conn/s/IP style limits are common).
    for (const [i, socket] of this.sockets.entries()) {
      setTimeout(() => socket.connect(), i * 400);
    }
  }

  private async subscribeShard(ws: WebSocket, shard: string[]): Promise<void> {
    // One batch per message keeps well under limits; space sends ≤10 msg/s.
    for (const batch of chunk(shard, 25)) {
      if (ws.readyState !== ws.OPEN) return;
      ws.send(
        JSON.stringify({
          op: 'subscribe',
          args: batch.map((instId) => ({ instType: 'USDT-FUTURES', channel: 'ticker', instId })),
        }),
      );
      await this.sleep(SUB_SPACING_MS);
    }
  }

  disconnect(): void {
    for (const s of this.sockets) s.close();
    this.sockets = [];
    this.merged.clear();
  }

  private handleMessage(raw: string): void {
    if (raw === 'pong') return;
    let msg: WsMessage;
    try {
      msg = JSON.parse(raw) as WsMessage;
    } catch (err) {
      this.logParseError('json', err);
      return;
    }
    const ticks = this.normalize(msg);
    for (const tick of ticks) this.emitTick(tick);
  }

  /** Merge snapshot/update rows; emit ticks with computed basis. */
  normalize(msg: WsMessage): PremiumTick[] {
    if (msg.event || msg.arg?.channel !== 'ticker' || !Array.isArray(msg.data)) return [];
    const out: PremiumTick[] = [];
    for (const row of msg.data) {
      const symbol = row.instId;
      if (typeof symbol !== 'string' || !this.allowed(symbol)) continue;
      let state = this.merged.get(symbol);
      if (msg.action === 'snapshot' || !state) {
        state = {};
        this.merged.set(symbol, state);
      }
      const mark = num(row.markPrice);
      const index = num(row.indexPrice);
      const funding = num(row.fundingRate);
      const nft = num(row.nextFundingTime);
      if (mark !== undefined) state.markPrice = mark;
      if (index !== undefined) state.indexPrice = index;
      if (funding !== undefined) state.fundingRate = funding;
      if (nft !== undefined) state.nextFundingTime = nft;

      const basis = computeBasis(state.markPrice, state.indexPrice);
      if (basis === undefined) continue;
      const tick: PremiumTick = {
        exchange: this.name,
        symbol,
        basis,
        timestamp: num(row.ts) ?? Date.now(),
      };
      if (state.markPrice !== undefined) tick.markPrice = state.markPrice;
      if (state.indexPrice !== undefined) tick.indexPrice = state.indexPrice;
      if (state.fundingRate !== undefined) tick.fundingRate = state.fundingRate;
      if (state.nextFundingTime !== undefined) tick.nextFundingTime = state.nextFundingTime;
      out.push(tick);
    }
    return out;
  }
}
