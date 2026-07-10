import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BinanceAdapter } from '../src/adapters/binance.js';
import { BybitAdapter } from '../src/adapters/bybit.js';
import { OkxAdapter } from '../src/adapters/okx.js';
import { BitgetAdapter } from '../src/adapters/bitget.js';
import type { PremiumTick } from '../src/types.js';

function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(join(__dirname, 'fixtures', name), 'utf8')) as T;
}

describe('binance normalize', () => {
  const events = fixture<Parameters<BinanceAdapter['normalize']>[0][]>('binance-markprice.json');

  it('produces computed premium ticks', () => {
    const adapter = new BinanceAdapter('all');
    const btc = adapter.normalize(events[0]!);
    expect(btc).toBeDefined();
    expect(btc!.symbol).toBe('BTCUSDT');
    expect(btc!.premium).toBeCloseTo((108250.5 - 108200.1) / 108200.1, 12);
    expect(btc!.premiumNative).toBe(false);
    expect(btc!.markPrice).toBe(108250.5);
    expect(btc!.indexPrice).toBe(108200.1);
    expect(btc!.fundingRate).toBe(0.0001);
    expect(btc!.nextFundingTime).toBe(1751904000000);
    expect(btc!.timestamp).toBe(1751900000123);

    const eth = adapter.normalize(events[1]!);
    expect(eth!.premium).toBeLessThan(0); // mark under index => negative basis
  });

  it('applies allow-list', () => {
    const adapter = new BinanceAdapter(['ETHUSDT']);
    expect(adapter.normalize(events[0]!)).toBeUndefined();
    expect(adapter.normalize(events[1]!)).toBeDefined();
  });

  it('drops malformed events', () => {
    const adapter = new BinanceAdapter('all');
    expect(adapter.normalize({} as never)).toBeUndefined();
    expect(adapter.normalize({ e: 'markPriceUpdate', s: 'BTCUSDT', p: 'x', i: 'y' } as never)).toBeUndefined();
  });

  it('drops excluded symbols from the stream', () => {
    const adapter = new BinanceAdapter('all', ['BTCUSDT']);
    expect(adapter.normalize(events[0]!)).toBeUndefined();
    expect(adapter.normalize(events[1]!)).toBeDefined();
  });

  it('exclusion overrides an explicit allow-list', () => {
    const adapter = new BinanceAdapter(['BTCUSDT', 'ETHUSDT'], ['BTCUSDT']);
    expect(adapter.normalize(events[0]!)).toBeUndefined();
    expect(adapter.normalize(events[1]!)).toBeDefined();
  });
});

describe('bybit normalize (snapshot + delta merge)', () => {
  type Msg = Parameters<BybitAdapter['normalize']>[0];
  const fx = fixture<{ snapshot: Msg; deltaMarkOnly: Msg; deltaUnrelated: Msg }>('bybit-ticker.json');

  it('snapshot then delta: delta overlays only changed fields', () => {
    const adapter = new BybitAdapter('all');
    const snap = adapter.normalize(fx.snapshot);
    expect(snap!.premium).toBeCloseTo((108255 - 108200) / 108200, 12);
    expect(snap!.fundingRate).toBe(0.0001);

    // Delta carries only markPrice — index must persist from snapshot.
    const delta = adapter.normalize(fx.deltaMarkOnly);
    expect(delta).toBeDefined();
    expect(delta!.markPrice).toBe(108310);
    expect(delta!.indexPrice).toBe(108200);
    expect(delta!.premium).toBeCloseTo((108310 - 108200) / 108200, 12);
    expect(delta!.fundingRate).toBe(0.0001); // retained from snapshot
  });

  it('delta without prior snapshot emits nothing until prices known', () => {
    const adapter = new BybitAdapter('all');
    expect(adapter.normalize(fx.deltaUnrelated)).toBeUndefined();
  });

  it('funding-only delta after snapshot keeps last premium inputs', () => {
    const adapter = new BybitAdapter('all');
    adapter.normalize(fx.snapshot);
    const t = adapter.normalize(fx.deltaUnrelated);
    expect(t!.fundingRate).toBe(0.00012);
    expect(t!.premium).toBeCloseTo((108255 - 108200) / 108200, 12);
  });

  it('drops malformed messages', () => {
    const adapter = new BybitAdapter('all');
    expect(adapter.normalize({} as never)).toBeUndefined();
    expect(adapter.normalize({ topic: 'tickers.X' } as never)).toBeUndefined();
  });

  it('drops excluded symbols before touching the merge cache', () => {
    const adapter = new BybitAdapter('all', ['BTCUSDT']);
    expect(adapter.normalize(fx.snapshot)).toBeUndefined();
    expect(adapter.normalize(fx.deltaMarkOnly)).toBeUndefined();
  });
});

describe('okx normalize (native premium + dual instId)', () => {
  type Msg = Parameters<OkxAdapter['normalize']>[0];
  const fx = fixture<{ markPrice: Msg; indexTicker: Msg; fundingRate: Msg; subscribeAck: Msg }>(
    'okx-messages.json',
  );

  it('computed premium from mark + index (fallback before funding-rate arrives)', () => {
    const adapter = new OkxAdapter('all');
    expect(adapter.normalize(fx.markPrice)).toBeUndefined(); // index unknown yet
    const t = adapter.normalize(fx.indexTicker);
    expect(t).toBeDefined();
    expect(t!.symbol).toBe('BTCUSDT'); // BTC-USDT (index id) normalized
    expect(t!.premiumNative).toBe(false);
    expect(t!.premium).toBeCloseTo((108260.1 - 108210.5) / 108210.5, 12);
  });

  it('native premium becomes authoritative once funding-rate arrives', () => {
    const adapter = new OkxAdapter('all');
    adapter.normalize(fx.markPrice);
    adapter.normalize(fx.indexTicker);
    const t = adapter.normalize(fx.fundingRate);
    expect(t!.premium).toBe(0.00042);
    expect(t!.premiumNative).toBe(true);
    expect(t!.fundingRate).toBe(0.00008);
    // Subsequent mark-price ticks keep native premium.
    const t2 = adapter.normalize(fx.markPrice);
    expect(t2!.premium).toBe(0.00042);
    expect(t2!.premiumNative).toBe(true);
  });

  it('ignores subscribe acks', () => {
    const adapter = new OkxAdapter('all');
    expect(adapter.normalize(fx.subscribeAck)).toBeUndefined();
  });
});

describe('bitget normalize (snapshot + update merge)', () => {
  type Msg = Parameters<BitgetAdapter['normalize']>[0];
  const fx = fixture<{ snapshot: Msg; update: Msg }>('bitget-ticker.json');

  it('snapshot emits computed premium', () => {
    const adapter = new BitgetAdapter('all');
    const ticks: PremiumTick[] = adapter.normalize(fx.snapshot);
    expect(ticks).toHaveLength(1);
    expect(ticks[0]!.premium).toBeCloseTo((108270 - 108220) / 108220, 12);
    expect(ticks[0]!.fundingRate).toBe(0.00009);
  });

  it('update overlays mark, index persists', () => {
    const adapter = new BitgetAdapter('all');
    adapter.normalize(fx.snapshot);
    const ticks = adapter.normalize(fx.update);
    expect(ticks[0]!.markPrice).toBe(108150);
    expect(ticks[0]!.indexPrice).toBe(108220);
    expect(ticks[0]!.premium).toBeCloseTo((108150 - 108220) / 108220, 12);
  });

  it('drops malformed messages', () => {
    const adapter = new BitgetAdapter('all');
    expect(adapter.normalize({} as never)).toEqual([]);
    expect(adapter.normalize({ event: 'subscribe' } as never)).toEqual([]);
  });

  it('drops excluded symbols from the stream', () => {
    const adapter = new BitgetAdapter('all', ['BTCUSDT']);
    expect(adapter.normalize(fx.snapshot)).toEqual([]);
  });
});

describe('okx exclusion covers both instId forms', () => {
  type Msg = Parameters<OkxAdapter['normalize']>[0];
  const fx = fixture<{ markPrice: Msg; indexTicker: Msg; fundingRate: Msg }>('okx-messages.json');

  it('excluding BTCUSDT drops BTC-USDT-SWAP and BTC-USDT messages alike', () => {
    const adapter = new OkxAdapter('all', ['BTCUSDT']);
    expect(adapter.normalize(fx.markPrice)).toBeUndefined();
    expect(adapter.normalize(fx.indexTicker)).toBeUndefined();
    expect(adapter.normalize(fx.fundingRate)).toBeUndefined();
  });
});
