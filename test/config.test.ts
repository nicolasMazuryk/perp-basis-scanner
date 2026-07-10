import { describe, expect, it } from 'vitest';
import { excludedFor, loadConfig, parseExclude } from '../src/config.js';

const ARGV = (...flags: string[]): string[] => ['node', 'pix', ...flags];

describe('parseExclude', () => {
  it('bare symbols land in the global bucket', () => {
    expect(parseExclude('BTCDOMUSDT,ALLUSDT')).toEqual({ all: ['BTCDOMUSDT', 'ALLUSDT'] });
  });

  it('venue-scoped symbols land in their exchange bucket', () => {
    expect(parseExclude('binance:ALLUSDT,okx:XYZUSDT')).toEqual({
      binance: ['ALLUSDT'],
      okx: ['XYZUSDT'],
    });
  });

  it('normalizes case and whitespace', () => {
    expect(parseExclude(' Binance : btcdomusdt , ethusdt ')).toEqual({
      binance: ['BTCDOMUSDT'],
      all: ['ETHUSDT'],
    });
  });

  it('rejects an unknown exchange', () => {
    expect(() => parseExclude('kraken:BTCUSDT')).toThrow(/unknown exchange "kraken"/);
  });
});

describe('excludedFor', () => {
  it('unions the global bucket with the exchange bucket', () => {
    const config = loadConfig(ARGV('--exchanges', 'binance,okx', '--exclude', 'BTCDOMUSDT,binance:ALLUSDT'));
    expect(excludedFor(config, 'binance')).toEqual(['BTCDOMUSDT', 'ALLUSDT']);
    expect(excludedFor(config, 'okx')).toEqual(['BTCDOMUSDT']);
  });

  it('is empty when nothing is excluded', () => {
    const config = loadConfig(ARGV('--exchanges', 'bybit'));
    expect(excludedFor(config, 'bybit')).toEqual([]);
  });
});

describe('exclude merging across sources', () => {
  it('unions CLI and env rather than letting CLI replace env', () => {
    const config = loadConfig(ARGV('--exchanges', 'binance', '--exclude', 'AAAUSDT'), {
      PIX_EXCLUDE: 'binance:BBBUSDT',
    } as NodeJS.ProcessEnv);
    expect(excludedFor(config, 'binance').sort()).toEqual(['AAAUSDT', 'BBBUSDT']);
  });

  it('dedupes a symbol excluded by two sources', () => {
    const config = loadConfig(ARGV('--exchanges', 'okx', '--exclude', 'okx:DUPUSDT'), {
      PIX_EXCLUDE: 'okx:DUPUSDT',
    } as NodeJS.ProcessEnv);
    expect(excludedFor(config, 'okx')).toEqual(['DUPUSDT']);
  });
});
