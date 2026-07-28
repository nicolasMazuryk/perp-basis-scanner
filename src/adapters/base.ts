import { EventEmitter } from 'node:events';
import { log } from '../log.js';
import type {
  AdapterEvents,
  ConnState,
  ExchangeAdapter,
  ExchangeName,
  IndexBasket,
  PremiumIndexSource,
  PremiumTick,
} from '../types.js';

/**
 * Shared adapter plumbing: typed events, symbol filtering, aggregate
 * connection-state tracking across sharded sockets, polite REST helpers.
 */
export abstract class BaseAdapter extends EventEmitter<AdapterEvents> implements ExchangeAdapter {
  abstract readonly name: ExchangeName;
  abstract readonly premiumIndexSource: PremiumIndexSource;
  private readonly socketStates = new Map<string, ConnState>();
  private readonly allowSet: Set<string> | undefined;
  private readonly denySet: Set<string>;

  /**
   * @param allowList `'all'` or an explicit set of normalized symbols.
   * @param denyList symbols excluded on this exchange; wins over the allow-list.
   */
  constructor(allowList: 'all' | string[], denyList: readonly string[] = []) {
    super();
    this.allowSet = allowList === 'all' ? undefined : new Set(allowList);
    this.denySet = new Set(denyList);
  }

  abstract fetchSymbols(): Promise<string[]>;
  abstract fetchIndexBaskets(symbols: string[]): Promise<IndexBasket[]>;
  abstract connect(): Promise<void>;
  abstract disconnect(): void;

  /**
   * Single gate for every symbol the adapter touches: stream ticks, REST
   * symbol discovery, basket fetches. Deny-list takes precedence.
   */
  protected allowed(symbol: string): boolean {
    if (this.denySet.has(symbol)) return false;
    return this.allowSet === undefined || this.allowSet.has(symbol);
  }

  protected filterAllowed(symbols: string[]): string[] {
    return symbols.filter((s) => this.allowed(s));
  }

  protected emitTick(tick: PremiumTick): void {
    this.emit('tick', tick);
  }

  /** Aggregate state across shards: any connected => connected; any reconnecting => reconnecting. */
  protected updateSocketState(socketName: string, state: ConnState): void {
    this.socketStates.set(socketName, state);
    const states = [...this.socketStates.values()];
    let agg: ConnState = 'disconnected';
    if (states.includes('connected')) agg = 'connected';
    else if (states.includes('reconnecting') || states.includes('connecting')) agg = 'reconnecting';
    this.emit('state', agg);
  }

  /** GET JSON with timeout; throws on non-2xx. */
  protected async getJson<T>(url: string): Promise<T> {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) {
      throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);
    }
    return (await res.json()) as T;
  }

  protected async sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  protected logParseError(context: string, err: unknown): void {
    log.warn('payload parse failed, dropped', { exchange: this.name, context, err: String(err) });
  }
}

/** Split an array into chunks of at most `size`. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Parse a numeric string field; undefined for missing/empty/NaN. */
export function num(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}
