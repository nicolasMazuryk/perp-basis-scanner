import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { denyListFor, excludedFor, loadConfig, parseExclude } from '../src/config.js';
import { RWA_SYMBOLS } from '../src/rwa.js';

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

describe('config-file auto-discovery', () => {
  const origCwd = process.cwd();
  afterEach(() => process.chdir(origCwd));

  it('auto-loads ./config.json only when autoDiscover is set', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pix-cfg-'));
    writeFileSync(
      join(dir, 'config.json'),
      JSON.stringify({ exclude: { binance: ['GTCUSDT'] } }),
    );
    try {
      process.chdir(dir);
      // Off by default: a stray cwd config.json must not leak into results.
      expect(excludedFor(loadConfig(ARGV('--exchanges', 'binance')), 'binance')).toEqual([]);
      // On for the CLI entrypoint: picks up ./config.json.
      const auto = loadConfig(ARGV('--exchanges', 'binance'), {} as NodeJS.ProcessEnv, {
        autoDiscover: true,
      });
      expect(excludedFor(auto, 'binance')).toContain('GTCUSDT');
    } finally {
      process.chdir(origCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('excludeRwa', () => {
  it('defaults to false', () => {
    const config = loadConfig(ARGV('--exchanges', 'binance'));
    expect(config.excludeRwa).toBe(false);
    expect(denyListFor(config, 'binance')).toEqual([]);
  });

  it('is settable via config file, env, and CLI', () => {
    expect(loadConfig(ARGV('--exchanges', 'binance', '--exclude-rwa')).excludeRwa).toBe(true);
    expect(
      loadConfig(ARGV('--exchanges', 'binance'), {
        PIX_EXCLUDE_RWA: 'true',
      } as NodeJS.ProcessEnv).excludeRwa,
    ).toBe(true);
    expect(
      loadConfig(ARGV('--exchanges', 'binance'), {
        PIX_EXCLUDE_RWA: '1',
      } as NodeJS.ProcessEnv).excludeRwa,
    ).toBe(true);
    expect(
      loadConfig(ARGV('--exchanges', 'binance'), {
        PIX_EXCLUDE_RWA: 'no',
      } as NodeJS.ProcessEnv).excludeRwa,
    ).toBe(false);
  });

  it('denyListFor unions RWA symbols only when enabled, adding to user excludes', () => {
    const off = loadConfig(ARGV('--exchanges', 'binance', '--exclude', 'BTCDOMUSDT'));
    expect(denyListFor(off, 'binance')).toEqual(['BTCDOMUSDT']);

    const on = loadConfig(ARGV('--exchanges', 'binance', '--exclude', 'BTCDOMUSDT', '--exclude-rwa'));
    const deny = denyListFor(on, 'binance');
    expect(deny).toContain('BTCDOMUSDT');
    for (const sym of RWA_SYMBOLS) expect(deny).toContain(sym);
    // No duplicates introduced by the union.
    expect(new Set(deny).size).toBe(deny.length);
  });
});
