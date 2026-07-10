import { readFileSync } from 'node:fs';
import { Command } from 'commander';
import { z } from 'zod';
import { ALL_EXCHANGES, type ExchangeName, type SortDirection } from './types.js';

const exchangeSchema = z.enum(['binance', 'bybit', 'okx', 'bitget']);

/**
 * Symbols to exclude, keyed by exchange. The `all` key applies to every
 * exchange; per-exchange entries add to it. Exclusion beats the allow-list.
 */
const excludeSchema = z
  .object({
    all: z.array(z.string()).optional(),
    binance: z.array(z.string()).optional(),
    bybit: z.array(z.string()).optional(),
    okx: z.array(z.string()).optional(),
    bitget: z.array(z.string()).optional(),
  })
  .default({});

export const configSchema = z.object({
  exchanges: z.array(exchangeSchema).nonempty(),
  topN: z.number().int().min(1).max(100).default(10),
  sort: z.enum(['highest', 'lowest']).default('highest'),
  refreshMs: z.number().int().min(100).default(1000),
  symbols: z.union([z.literal('all'), z.array(z.string()).nonempty()]).default('all'),
  exclude: excludeSchema,
  stalenessMs: z.number().int().min(500).default(5000),
  basketRefreshMs: z.number().int().min(60_000).default(3_600_000),
  logFile: z.string().default('scanner.log'),
});

export type Config = z.infer<typeof configSchema>;
export type ExcludeMap = z.infer<typeof excludeSchema>;

/** Symbols excluded on `exchange`: the global `all` bucket plus its own entry. */
export function excludedFor(config: Config, exchange: ExchangeName): string[] {
  return [...(config.exclude.all ?? []), ...(config.exclude[exchange] ?? [])];
}

interface RawConfig {
  exchanges?: string[];
  topN?: number;
  sort?: string;
  refreshMs?: number;
  symbols?: 'all' | string[];
  exclude?: ExcludeMap;
  stalenessMs?: number;
  basketRefreshMs?: number;
  logFile?: string;
}

function parseList(value: string): string[] {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

const EXCLUDE_KEYS = ['all', ...ALL_EXCHANGES] as const;
type ExcludeKey = (typeof EXCLUDE_KEYS)[number];

function isExcludeKey(value: string): value is ExcludeKey {
  return (EXCLUDE_KEYS as readonly string[]).includes(value);
}

/**
 * Parse a flat exclude list: `BTCDOMUSDT,binance:ALLUSDT,okx:XYZUSDT`.
 * A bare symbol excludes it on every exchange; `venue:SYMBOL` scopes it.
 */
export function parseExclude(value: string): ExcludeMap {
  const map: ExcludeMap = {};
  for (const item of parseList(value)) {
    const sep = item.indexOf(':');
    const venue = sep === -1 ? 'all' : item.slice(0, sep).trim().toLowerCase();
    const symbol = (sep === -1 ? item : item.slice(sep + 1)).trim().toUpperCase();
    if (!symbol) continue;
    if (!isExcludeKey(venue)) {
      throw new Error(
        `Invalid --exclude entry "${item}": unknown exchange "${venue}" (expected one of ${EXCLUDE_KEYS.join(', ')})`,
      );
    }
    (map[venue] ??= []).push(symbol);
  }
  return map;
}

/** Union exclude maps from several sources; later sources add, never replace. */
function mergeExclude(...maps: (ExcludeMap | undefined)[]): ExcludeMap {
  const out: ExcludeMap = {};
  for (const map of maps) {
    if (!map) continue;
    for (const key of EXCLUDE_KEYS) {
      const symbols = map[key];
      if (!symbols?.length) continue;
      out[key] = [...new Set([...(out[key] ?? []), ...symbols.map((s) => s.toUpperCase())])];
    }
  }
  return out;
}

function fromEnv(env: NodeJS.ProcessEnv): RawConfig {
  const raw: RawConfig = {};
  if (env.PIX_EXCHANGES) raw.exchanges = parseList(env.PIX_EXCHANGES.toLowerCase());
  if (env.PIX_TOP_N) raw.topN = Number(env.PIX_TOP_N);
  if (env.PIX_SORT) raw.sort = env.PIX_SORT;
  if (env.PIX_REFRESH_MS) raw.refreshMs = Number(env.PIX_REFRESH_MS);
  if (env.PIX_SYMBOLS) {
    raw.symbols = env.PIX_SYMBOLS === 'all' ? 'all' : parseList(env.PIX_SYMBOLS.toUpperCase());
  }
  if (env.PIX_EXCLUDE) raw.exclude = parseExclude(env.PIX_EXCLUDE);
  if (env.PIX_STALENESS_MS) raw.stalenessMs = Number(env.PIX_STALENESS_MS);
  if (env.PIX_BASKET_REFRESH_MS) raw.basketRefreshMs = Number(env.PIX_BASKET_REFRESH_MS);
  if (env.PIX_LOG_FILE) raw.logFile = env.PIX_LOG_FILE;
  return raw;
}

/** Merge precedence: CLI > env > config file > schema defaults. */
export function loadConfig(argv: string[], env: NodeJS.ProcessEnv = process.env): Config {
  const program = new Command()
    .name('pix')
    .description('Real-time premium-index basis scanner (read-only)')
    .option('--config <file>', 'JSON config file')
    .option('--exchanges <list>', `comma list of: ${ALL_EXCHANGES.join(',')}`)
    .option('--top-n <n>', 'rows per exchange panel', Number)
    .option('--sort <dir>', 'highest | lowest')
    .option('--refresh-ms <ms>', 'render interval', Number)
    .option('--symbols <list>', '"all" or comma list e.g. BTCUSDT,ETHUSDT')
    .option(
      '--exclude <list>',
      'symbols to hide: BTCDOMUSDT (all venues) or binance:ALLUSDT (one venue)',
    )
    .option('--staleness-ms <ms>', 'flag entries older than this', Number)
    .option('--basket-refresh-ms <ms>', 'index-basket REST refresh interval', Number)
    .option('--log-file <path>', 'structured log destination')
    .allowExcessArguments(false)
    .parse(argv);

  const opts = program.opts<{
    config?: string;
    exchanges?: string;
    topN?: number;
    sort?: string;
    refreshMs?: number;
    symbols?: string;
    exclude?: string;
    stalenessMs?: number;
    basketRefreshMs?: number;
    logFile?: string;
  }>();

  let fileConf: RawConfig = {};
  if (opts.config) {
    fileConf = JSON.parse(readFileSync(opts.config, 'utf8')) as RawConfig;
  }

  const cliConf: RawConfig = {};
  if (opts.exchanges) cliConf.exchanges = parseList(opts.exchanges.toLowerCase());
  if (opts.topN !== undefined) cliConf.topN = opts.topN;
  if (opts.sort) cliConf.sort = opts.sort;
  if (opts.refreshMs !== undefined) cliConf.refreshMs = opts.refreshMs;
  if (opts.symbols) {
    cliConf.symbols = opts.symbols === 'all' ? 'all' : parseList(opts.symbols.toUpperCase());
  }
  if (opts.exclude) cliConf.exclude = parseExclude(opts.exclude);
  if (opts.stalenessMs !== undefined) cliConf.stalenessMs = opts.stalenessMs;
  if (opts.basketRefreshMs !== undefined) cliConf.basketRefreshMs = opts.basketRefreshMs;
  if (opts.logFile) cliConf.logFile = opts.logFile;

  const envConf = fromEnv(env);
  // Scalars follow CLI > env > file. Exclusions instead union across all three:
  // a symbol excluded anywhere stays excluded, so a CLI flag cannot silently
  // re-admit something the config file hid.
  const merged = {
    ...fileConf,
    ...envConf,
    ...cliConf,
    exclude: mergeExclude(fileConf.exclude, envConf.exclude, cliConf.exclude),
  };
  const result = configSchema.safeParse(merged);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid configuration:\n${issues}\nHint: pass --exchanges binance,bybit,okx,bitget`);
  }
  return result.data;
}

export type { ExchangeName, SortDirection };
