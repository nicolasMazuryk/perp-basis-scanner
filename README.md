# premium-index scanner

Real-time terminal scanner for **premium-index basis** across USDT linear perpetuals on four exchanges: Binance USDⓈ-M, Bybit (v5), OKX (v5), Bitget (v2). Streams mark/index prices over WebSocket, ranks the top-N symbols per exchange by premium, and shows each symbol's index-price constituent basket (which spot venues feed the index, at what weight).

**Read-only decision support.** It never places orders and needs no API keys — all feeds are public.

```
┌────────────────────────────────────────────────────────────────────────────┐
│ ● BINANCE (530 symbols, top 10 by highest premium)                         │
│ #  Symbol         Premium         Mark        Index    Funding    Age      │
│ 1  XYZUSDT       +0.4437%       0.0021960   0.0021863   0.0100%   1.5s     │
│    basket: binance:XYZUSDT 43.5% | okex:XYZ-USDT 13.0% | …                 │
└────────────────────────────────────────────────────────────────────────────┘
 ● binance   ● bybit   ● okx   ○ bitget
 premium = (mark−index)/index · * = exchange-native (OKX) · refresh 1000ms
```

## Setup

```bash
npm install
npm test          # unit tests (ranking, staleness, payload normalization)
npm run build     # strict tsc
npm start -- --exchanges binance,bybit,okx,bitget
```

Node ≥ 20 required (uses built-in `fetch`).

## Configuration

Precedence: **CLI flags > `PIX_*` env vars > `--config` JSON file > defaults.** See [config.example.json](config.example.json).

| Option | CLI | Env | Default | Meaning |
|---|---|---|---|---|
| exchanges | `--exchanges binance,okx` | `PIX_EXCHANGES` | *(required)* | Venues to stream |
| topN | `--top-n 5` | `PIX_TOP_N` | 10 | Rows per panel |
| sort | `--sort lowest` | `PIX_SORT` | `highest` | Rank by highest or lowest premium |
| refreshMs | `--refresh-ms 500` | `PIX_REFRESH_MS` | 1000 | Repaint interval |
| symbols | `--symbols BTCUSDT,ETHUSDT` | `PIX_SYMBOLS` | `all` | Allow-list (normalized form) |
| exclude | `--exclude BTCDOMUSDT,binance:ALLUSDT` | `PIX_EXCLUDE` | none | Deny-list, see below |
| stalenessMs | `--staleness-ms 5000` | `PIX_STALENESS_MS` | 5000 | Flag entries older than this (dim + `!`) |
| basketRefreshMs | `--basket-refresh-ms 3600000` | `PIX_BASKET_REFRESH_MS` | 1h | Constituent re-fetch interval |
| logFile | `--log-file scanner.log` | `PIX_LOG_FILE` | `scanner.log` | Structured JSON log (never stdout) |

### Excluding symbols

An excluded symbol is dropped at the adapter boundary, so it never enters the store: no WebSocket tick is kept, no REST basket is fetched for it, and it cannot appear in a panel. Exclusion beats the allow-list — a symbol in both `symbols` and `exclude` stays hidden.

On the command line, a bare symbol hides it on every exchange; `venue:SYMBOL` scopes it to one:

```bash
npm start -- --exchanges binance,okx --exclude BTCDOMUSDT,binance:ALLUSDT
```

In a config file, `all` applies everywhere and each exchange key adds to it:

```json
{
  "exclude": {
    "all": ["BTCDOMUSDT"],
    "binance": ["ALLUSDT"]
  }
}
```

Unlike the other options, exclusions **union** across config file, env and CLI rather than overriding — a CLI flag cannot silently re-admit a symbol the config file hid. Useful targets: synthetic indices with no constituent basket (`BTCDOMUSDT`, `ALLUSDT` on Binance) and illiquid listings whose huge premiums crowd the top-N.

## Reading the screen for basis trades

- **Premium** = `(mark − index) / index`. Positive: perp trades rich to its own index — basis capture is short perp / long spot basket. Negative: perp cheap — long perp / short spot. On OKX the `*` marks the exchange's **native** premium from the funding-rate channel (authoritative, ~1 min cadence); elsewhere it's computed from streamed mark and index.
- **Basket line** shows exactly which spot venues (and weights) the index averages. That's your hedge shopping list and your manipulation-risk check: a thin basket dominated by one venue moves the index (and mark, and funding) with one venue's order book. Bybit and Bitget don't publish constituents via public API — shown as `— (constituents not published via API)`, never guessed.
- **Funding** is the periodic rate; premium is its main input. A persistent premium that funding hasn't caught up to yet is the classic basis entry.
- **Age** = time since last update; entries past the staleness threshold render dim with a yellow `age!` — don't trade stale numbers.
- Footer dots: green `●` connected, yellow `○` reconnecting, red `○` down. Venues fail independently; one dead venue never blocks the others.
- Cross-venue comparison of the same symbol's premium (e.g. BTCUSDT rich on Bitget, flat on Binance) is the cross-exchange leg-in signal — but remember each venue's premium is against **its own** index basket.

Caveats: premiums of a few basis points are normal noise; fees, slippage and funding-interval timing eat small edges. Exotic listings with huge premiums usually have thin books and withdrawal frictions.

## Architecture

```
adapters (binance|bybit|okx|bitget) ──tick──▶ store ──snapshot──▶ ranking ──▶ renderer (1 Hz)
        └─ ReconnectingSocket (backoff+jitter, heartbeat, silence watchdog)
```

- Ingestion is an O(1) upsert into a flat map; no message history is kept, so memory is bounded by universe size.
- The renderer pulls a snapshot on its own clock — fully decoupled from message rate.
- Per-exchange quirks handled: Bybit ticker snapshot+delta merge; OKX dual instId forms and native premium; Binance March-2026 `/market` WS endpoint and proactive pre-24h reconnect; Bitget connection sharding (~50 subs/conn) and subscribe throttling.

## Adding an exchange adapter

1. Create `src/adapters/<name>.ts` extending `BaseAdapter` (see [base.ts](src/adapters/base.ts)).
2. Implement `fetchSymbols()` (REST, return normalized `BTCUSDT`-form symbols, run through `filterAllowed`), `fetchIndexBaskets()` (return `available: false` + empty constituents if the venue doesn't publish them — never fabricate weights), `connect()` using `ReconnectingSocket` (set the venue's heartbeat and a silence timeout), and a pure `normalize(msg)` that maps raw WS payloads to `PremiumTick`.
3. If the venue sends snapshot+delta tickers, keep a per-symbol merge cache (copy the Bybit adapter).
4. Add the exchange name to the `ExchangeName` union in [types.ts](src/types.ts), the factory map in [index.ts](src/index.ts), and the zod enum in [config.ts](src/config.ts).
5. Record a real WS payload as a fixture in `test/fixtures/` and add `normalize` tests (happy path, delta merge if any, malformed input).

## Logs

Structured JSON lines in `scanner.log` (connection events, reconnects, dropped payloads, basket refreshes). Nothing is ever written to stdout except the TUI.
