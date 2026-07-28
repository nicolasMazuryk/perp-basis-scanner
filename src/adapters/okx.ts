import type WebSocket from 'ws';
import { computeBasis } from '../ranking.js';
import { ReconnectingSocket } from '../ws/reconnect.js';
import type {
  ExchangeName,
  IndexBasket,
  PremiumIndexSource,
  PremiumTick,
} from '../types.js';
import { BaseAdapter, chunk, num } from './base.js';

const WS_URL = 'wss://ws.okx.com:8443/ws/v5/public';
const REST = 'https://www.okx.com';
/** Channel args per subscribe message; keeps payloads far under 64KB. */
const ARGS_PER_MSG = 200;

interface WsMessage {
  event?: string;
  arg?: { channel: string; instId: string };
  data?: Array<Record<string, unknown>>;
}

interface InstrumentsResponse {
  data: Array<{ instId: string; ctType: string; settleCcy: string; state: string }>;
}

interface IndexComponentsResponse {
  data: { index: string; components: Array<{ exch: string; symbol: string; wgt: string }> };
}

/** Display enrichment cache per normalized symbol. */
interface OkxState {
  markPrice?: number;
  indexPrice?: number;
  fundingRate?: number;
  nextFundingTime?: number;
  /** Order-book premium index streamed on the funding-rate channel. */
  premiumIndex?: number;
}

/**
 * OKX v5. Subscribes `funding-rate` (carries a true `premium` index, ~1min
 * cadence) plus `mark-price` and `index-tickers` (200ms), from which basis is
 * computed. Swap instId "BTC-USDT-SWAP" and index instId "BTC-USDT" both map
 * to normalized "BTCUSDT". Heartbeat: raw "ping" string, expect "pong".
 */
export class OkxAdapter extends BaseAdapter {
  readonly name: ExchangeName = 'okx';
  readonly premiumIndexSource: PremiumIndexSource = 'stream';
  private socket: ReconnectingSocket | undefined;
  /** normalized symbol -> swap instId */
  private readonly instIds = new Map<string, string>();
  private readonly state = new Map<string, OkxState>();

  /** "BTC-USDT-SWAP" or "BTC-USDT" -> "BTCUSDT" */
  private normalizeSymbol(instId: string): string {
    return instId.replace(/-SWAP$/, '').replace(/-/g, '');
  }

  async fetchSymbols(): Promise<string[]> {
    const res = await this.getJson<InstrumentsResponse>(
      `${REST}/api/v5/public/instruments?instType=SWAP`,
    );
    this.instIds.clear();
    for (const inst of res.data) {
      if (inst.ctType !== 'linear' || inst.settleCcy !== 'USDT' || inst.state !== 'live') continue;
      const normalized = this.normalizeSymbol(inst.instId);
      if (this.allowed(normalized)) this.instIds.set(normalized, inst.instId);
    }
    return [...this.instIds.keys()];
  }

  async fetchIndexBaskets(symbols: string[]): Promise<IndexBasket[]> {
    const baskets: IndexBasket[] = [];
    for (const symbol of symbols) {
      const instId = this.instIds.get(symbol);
      if (!instId) continue;
      const indexId = instId.replace(/-SWAP$/, ''); // BTC-USDT-SWAP -> BTC-USDT
      try {
        const res = await this.getJson<IndexComponentsResponse>(
          `${REST}/api/v5/market/index-components?index=${indexId}`,
        );
        baskets.push({
          exchange: this.name,
          symbol,
          available: true,
          constituents: (res.data?.components ?? [])
            .map((c) => ({ venue: c.exch, symbol: c.symbol, weight: num(c.wgt) ?? 0 }))
            .sort((a, b) => b.weight - a.weight),
          fetchedAt: Date.now(),
        });
      } catch (err) {
        this.logParseError(`index-components ${symbol}`, err);
      }
      await this.sleep(150);
    }
    return baskets;
  }

  async connect(): Promise<void> {
    if (this.instIds.size === 0) await this.fetchSymbols();
    this.socket = new ReconnectingSocket({
      name: 'okx',
      url: WS_URL,
      onOpen: (ws: WebSocket) => {
        this.state.clear();
        const ids = [...this.instIds.values()];
        const args = ids.flatMap((instId) => [
          { channel: 'funding-rate', instId },
          { channel: 'mark-price', instId },
          { channel: 'index-tickers', instId: instId.replace(/-SWAP$/, '') },
        ]);
        for (const batch of chunk(args, ARGS_PER_MSG)) {
          ws.send(JSON.stringify({ op: 'subscribe', args: batch }));
        }
      },
      onMessage: (data) => this.handleMessage(data.toString()),
      onStateChange: (s) => this.updateSocketState('okx', s),
      heartbeat: { intervalMs: 25_000, payload: () => 'ping' },
      silenceTimeoutMs: 40_000,
    });
    this.socket.connect();
  }

  disconnect(): void {
    this.socket?.close();
    this.socket = undefined;
    this.state.clear();
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
    const tick = this.normalize(msg);
    if (tick) this.emitTick(tick);
  }

  /** Route channel data into per-symbol state; emit when premium known. */
  normalize(msg: WsMessage): PremiumTick | undefined {
    if (msg.event || !msg.arg || !Array.isArray(msg.data) || msg.data.length === 0) return undefined;
    const { channel, instId } = msg.arg;
    const symbol = this.normalizeSymbol(instId);
    if (!this.allowed(symbol)) return undefined;
    const row = msg.data[msg.data.length - 1];
    if (!row) return undefined;

    let state = this.state.get(symbol);
    if (!state) {
      state = {};
      this.state.set(symbol, state);
    }

    let ts = Date.now();
    if (channel === 'funding-rate') {
      const p = num(row.premium);
      if (p !== undefined) state.premiumIndex = p;
      const fr = num(row.fundingRate);
      if (fr !== undefined) state.fundingRate = fr;
      const nft = num(row.fundingTime);
      if (nft !== undefined) state.nextFundingTime = nft;
      ts = num(row.ts) ?? ts;
    } else if (channel === 'mark-price') {
      const mp = num(row.markPx);
      if (mp !== undefined) state.markPrice = mp;
      ts = num(row.ts) ?? ts;
    } else if (channel === 'index-tickers') {
      const ip = num(row.idxPx);
      if (ip !== undefined) state.indexPrice = ip;
      ts = num(row.ts) ?? ts;
    } else {
      return undefined;
    }

    // Wait for the first mark/index pair (200ms channel) rather than emit a
    // fabricated zero basis alongside a real premium index.
    const basis = computeBasis(state.markPrice, state.indexPrice);
    if (basis === undefined) return undefined;
    const tick: PremiumTick = {
      exchange: this.name,
      symbol,
      basis,
      timestamp: ts,
    };
    if (state.premiumIndex !== undefined) tick.premiumIndex = state.premiumIndex;
    if (state.markPrice !== undefined) tick.markPrice = state.markPrice;
    if (state.indexPrice !== undefined) tick.indexPrice = state.indexPrice;
    if (state.fundingRate !== undefined) tick.fundingRate = state.fundingRate;
    if (state.nextFundingTime !== undefined) tick.nextFundingTime = state.nextFundingTime;
    return tick;
  }
}
