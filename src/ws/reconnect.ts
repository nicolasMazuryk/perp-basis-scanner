import WebSocket from 'ws';
import { log } from '../log.js';

export interface ReconnectingSocketOptions {
  /** Label for logs, e.g. "bybit#0". */
  name: string;
  url: string;
  /** Called on every (re)open — send subscribe messages here. */
  onOpen: (ws: WebSocket) => void;
  onMessage: (data: WebSocket.RawData) => void;
  onStateChange?: (state: 'connected' | 'reconnecting' | 'disconnected') => void;
  /** App-level heartbeat: return the payload to send every `heartbeatMs`. */
  heartbeat?: { intervalMs: number; payload: () => string };
  /** Drop + reconnect if no message (incl. pongs) for this long. 0 disables. */
  silenceTimeoutMs?: number;
  /** Proactive reconnect after this long (Binance 24h rule). 0 disables. */
  maxLifetimeMs?: number;
}

const BACKOFF_MIN_MS = 1000;
const BACKOFF_MAX_MS = 60_000;
/** Connection considered stable (backoff resets) after this long open. */
const STABLE_MS = 30_000;

/**
 * Generic reconnecting WebSocket. Exponential backoff (1s→60s, ×2, ±30%
 * jitter), app-level heartbeat, silence watchdog, optional proactive
 * lifetime reconnect. Failures isolated per socket.
 */
export class ReconnectingSocket {
  private ws: WebSocket | undefined;
  private backoffMs = BACKOFF_MIN_MS;
  private closed = false;
  private timers: NodeJS.Timeout[] = [];
  private openedAt = 0;

  constructor(private readonly opts: ReconnectingSocketOptions) {}

  connect(): void {
    if (this.closed) return;
    this.clearTimers();
    const ws = new WebSocket(this.opts.url);
    this.ws = ws;

    ws.on('open', () => {
      this.openedAt = Date.now();
      log.info('ws open', { name: this.opts.name });
      this.opts.onStateChange?.('connected');
      // Reset backoff only once the connection proves stable.
      this.timers.push(
        setTimeout(() => {
          this.backoffMs = BACKOFF_MIN_MS;
        }, STABLE_MS),
      );
      try {
        this.opts.onOpen(ws);
      } catch (err) {
        log.error('onOpen handler failed', { name: this.opts.name, err: String(err) });
      }
      if (this.opts.heartbeat) {
        const hb = this.opts.heartbeat;
        this.timers.push(
          setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) ws.send(hb.payload());
          }, hb.intervalMs),
        );
      }
      if (this.opts.maxLifetimeMs) {
        this.timers.push(
          setTimeout(() => {
            log.info('ws proactive lifetime reconnect', { name: this.opts.name });
            ws.close();
          }, this.opts.maxLifetimeMs),
        );
      }
      this.armSilenceWatchdog(ws);
    });

    ws.on('message', (data) => {
      this.armSilenceWatchdog(ws);
      try {
        this.opts.onMessage(data);
      } catch (err) {
        log.warn('message handler threw, dropped', { name: this.opts.name, err: String(err) });
      }
    });

    ws.on('error', (err) => {
      log.warn('ws error', { name: this.opts.name, err: String(err) });
    });

    ws.on('close', (code) => {
      log.info('ws close', { name: this.opts.name, code });
      this.scheduleReconnect();
    });
  }

  send(payload: string): boolean {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(payload);
      return true;
    }
    return false;
  }

  close(): void {
    this.closed = true;
    this.clearTimers();
    this.ws?.removeAllListeners('close');
    this.ws?.close();
    this.ws = undefined;
    this.opts.onStateChange?.('disconnected');
  }

  private silenceTimer: NodeJS.Timeout | undefined;

  // Kept out of `timers` — re-armed on every message, pushing there would
  // grow the array unboundedly at high message rates.
  private armSilenceWatchdog(ws: WebSocket): void {
    const timeout = this.opts.silenceTimeoutMs;
    if (!timeout) return;
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    this.silenceTimer = setTimeout(() => {
      log.warn('ws silence timeout, forcing reconnect', { name: this.opts.name, timeout });
      ws.terminate();
    }, timeout);
  }

  private scheduleReconnect(): void {
    this.clearTimers();
    if (this.closed) return;
    this.opts.onStateChange?.('reconnecting');
    const jitter = 1 + (Math.random() * 0.6 - 0.3);
    const delay = Math.round(this.backoffMs * jitter);
    this.backoffMs = Math.min(this.backoffMs * 2, BACKOFF_MAX_MS);
    log.info('ws reconnect scheduled', { name: this.opts.name, delayMs: delay });
    this.timers.push(setTimeout(() => this.connect(), delay));
  }

  private clearTimers(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    this.silenceTimer = undefined;
  }
}
