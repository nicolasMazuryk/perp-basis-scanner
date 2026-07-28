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

  it('produces computed basis ticks and never a premium index', () => {
    const adapter = new BinanceAdapter('all');
    const btc = adapter.normalize(events[0]!);
    expect(btc).toBeDefined();
    expect(btc!.symbol).toBe('BTCUSDT');
    expect(btc!.basis).toBeCloseTo((108250.5 - 108200.1) / 108200.1, 12);
    // Binance's premium index is order-book derived and REST-only; the mark
    // price stream cannot supply it.
    expect(btc!.premiumIndex).toBeUndefined();
    expect(adapter.premiumIndexSource).toBe('rest');
    expect(btc!.markPrice).toBe(108250.5);
    expect(btc!.indexPrice).toBe(108200.1);
    expect(btc!.fundingRate).toBe(0.0001);
    expect(btc!.nextFundingTime).toBe(1751904000000);
    expect(btc!.timestamp).toBe(1751900000123);

    const eth = adapter.normalize(events[1]!);
    expect(eth!.basis).toBeLessThan(0); // mark under index => negative basis
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
    expect(snap!.basis).toBeCloseTo((108255 - 108200) / 108200, 12);
    expect(snap!.fundingRate).toBe(0.0001);

    // Delta carries only markPrice — index must persist from snapshot.
    const delta = adapter.normalize(fx.deltaMarkOnly);
    expect(delta).toBeDefined();
    expect(delta!.markPrice).toBe(108310);
    expect(delta!.indexPrice).toBe(108200);
    expect(delta!.basis).toBeCloseTo((108310 - 108200) / 108200, 12);
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
    expect(t!.basis).toBeCloseTo((108255 - 108200) / 108200, 12);
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

describe('okx normalize (streamed premium index + dual instId)', () => {
  type Msg = Parameters<OkxAdapter['normalize']>[0];
  const fx = fixture<{ markPrice: Msg; indexTicker: Msg; fundingRate: Msg; subscribeAck: Msg }>(
    'okx-messages.json',
  );

  it('basis from mark + index; premium index absent until funding-rate arrives', () => {
    const adapter = new OkxAdapter('all');
    expect(adapter.premiumIndexSource).toBe('stream');
    expect(adapter.normalize(fx.markPrice)).toBeUndefined(); // index unknown yet
    const t = adapter.normalize(fx.indexTicker);
    expect(t).toBeDefined();
    expect(t!.symbol).toBe('BTCUSDT'); // BTC-USDT (index id) normalized
    expect(t!.basis).toBeCloseTo((108260.1 - 108210.5) / 108210.5, 12);
    expect(t!.premiumIndex).toBeUndefined();
  });

  it('funding-rate supplies the premium index without overwriting basis', () => {
    const adapter = new OkxAdapter('all');
    adapter.normalize(fx.markPrice);
    adapter.normalize(fx.indexTicker);
    const t = adapter.normalize(fx.fundingRate);
    expect(t!.premiumIndex).toBe(0.00042);
    expect(t!.basis).toBeCloseTo((108260.1 - 108210.5) / 108210.5, 12);
    expect(t!.fundingRate).toBe(0.00008);
    // Later mark-price ticks retain the last streamed premium index.
    const t2 = adapter.normalize(fx.markPrice);
    expect(t2!.premiumIndex).toBe(0.00042);
  });

  it('ignores subscribe acks', () => {
    const adapter = new OkxAdapter('all');
    expect(adapter.normalize(fx.subscribeAck)).toBeUndefined();
  });
});

describe('bybit and bitget publish no premium index', () => {
  it('declare source none and never set premiumIndex', () => {
    const bybit = new BybitAdapter('all');
    const bitget = new BitgetAdapter('all');
    expect(bybit.premiumIndexSource).toBe('none');
    expect(bitget.premiumIndexSource).toBe('none');

    const bybitFx = fixture<{ snapshot: Parameters<BybitAdapter['normalize']>[0] }>('bybit-ticker.json');
    const bitgetFx = fixture<{ snapshot: Parameters<BitgetAdapter['normalize']>[0] }>('bitget-ticker.json');
    expect(bybit.normalize(bybitFx.snapshot)!.premiumIndex).toBeUndefined();
    expect(bitget.normalize(bitgetFx.snapshot)[0]!.premiumIndex).toBeUndefined();
  });
});

describe('bitget normalize (snapshot + update merge)', () => {
  type Msg = Parameters<BitgetAdapter['normalize']>[0];
  const fx = fixture<{ snapshot: Msg; update: Msg }>('bitget-ticker.json');

  it('snapshot emits computed premium', () => {
    const adapter = new BitgetAdapter('all');
    const ticks: PremiumTick[] = adapter.normalize(fx.snapshot);
    expect(ticks).toHaveLength(1);
    expect(ticks[0]!.basis).toBeCloseTo((108270 - 108220) / 108220, 12);
    expect(ticks[0]!.fundingRate).toBe(0.00009);
  });

  it('update overlays mark, index persists', () => {
    const adapter = new BitgetAdapter('all');
    adapter.normalize(fx.snapshot);
    const ticks = adapter.normalize(fx.update);
    expect(ticks[0]!.markPrice).toBe(108150);
    expect(ticks[0]!.indexPrice).toBe(108220);
    expect(ticks[0]!.basis).toBeCloseTo((108150 - 108220) / 108220, 12);
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
