# perp-basis-scanner

[![CI](https://github.com/nicolasMazuryk/perp-basis-scanner/actions/workflows/ci.yml/badge.svg)](https://github.com/nicolasMazuryk/perp-basis-scanner/actions/workflows/ci.yml)

Real-time terminal scanner for **premium-index basis** across USDT linear perpetuals on four exchanges: Binance USDⓈ-M, Bybit (v5), OKX (v5), Bitget (v2). Streams mark/index prices over WebSocket, ranks the top-N symbols per exchange by the exchange's own premium index where it publishes one (and by mark-vs-index basis where it doesn't), and shows each symbol's index-price constituent basket (which spot venues feed the index, at what weight).

**Read-only decision support.** It never places orders and needs no API keys — all feeds are public.

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ ● BINANCE (528 symbols, top 10 by highest premium index · REST 1m)           │
│ #  Symbol        PremIdx     Basis        Mark        Index   Funding   Age  │
│ 1  PRLUSDT      +0.4084%  +0.2585%    0.174700     0.174250  +0.0050%  0.8s  │
│    basket: binance:PRLUSDT 43.5% | okex:PRL-USDT 13.0% | …                   │
└──────────────────────────────────────────────────────────────────────────────┘
 ● binance   ● bybit   ● okx   ○ bitget
 PremIdx = exchange order-book premium index · Basis = (mark−index)/index
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

Precedence: **CLI flags > `PIX_*` env vars > config JSON file > defaults.** The config file is `--config <file>`, or `./config.json` auto-loaded when the flag is omitted. Copy [config.example.json](config.example.json) to `config.json` to have your settings applied on every run without passing a flag.

| Option | CLI | Env | Default | Meaning |
|---|---|---|---|---|
| exchanges | `--exchanges binance,okx` | `PIX_EXCHANGES` | *(required)* | Venues to stream |
| topN | `--top-n 5` | `PIX_TOP_N` | 10 | Rows per panel |
| sort | `--sort lowest` | `PIX_SORT` | `highest` | Rank by highest or lowest value of the panel metric |
| refreshMs | `--refresh-ms 500` | `PIX_REFRESH_MS` | 1000 | Repaint interval |
| symbols | `--symbols BTCUSDT,ETHUSDT` | `PIX_SYMBOLS` | `all` | Allow-list (normalized form) |
| exclude | `--exclude BTCDOMUSDT,binance:ALLUSDT` | `PIX_EXCLUDE` | none | Deny-list, see below |
| excludeRwa | `--exclude-rwa` | `PIX_EXCLUDE_RWA` | `false` | Hide tokenized-equity / RWA perps, see below |
| stalenessMs | `--staleness-ms 5000` | `PIX_STALENESS_MS` | 5000 | Flag entries older than this (dim + `!`) |
| basketRefreshMs | `--basket-refresh-ms 3600000` | `PIX_BASKET_REFRESH_MS` | 1h | Constituent re-fetch interval |
| premiumIndexRefreshMs | `--premium-index-refresh-ms 60000` | `PIX_PREMIUM_INDEX_REFRESH_MS` | 60s | Premium-index poll (Binance only) |
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

### Filtering RWA / stock tokens

Set `excludeRwa` (off by default) to hide tokenized-equity / real-world-asset perps — `AAPLUSDT`, `TSLAUSDT`, `COINUSDT`, and similar — which are noise for a crypto premium-index tool:

```bash
npm start -- --exchanges binance,bybit --exclude-rwa
```

No exchange API reliably tags equities across all four venues, so the set is a **curated list maintained in [`src/rwa.ts`](src/rwa.ts)** — add new listings (and venue-specific variants like `X`-suffixed xStock tickers) there. When enabled, those symbols are unioned into each exchange's deny-list, so they are dropped at the adapter boundary exactly like a manual `exclude`.

## Two different numbers: PremIdx vs Basis

The screen shows both, because they are **not the same quantity** and diverge exactly where it matters.

**`Basis` = `(mark − index) / index`.** Derived from the streamed mark and index prices, real-time on every venue. It answers: *how far has the mark price drifted from the index?*

**`PremIdx` = the exchange's own premium index**, computed from the order book. Binance's definition:

```
Premium Index = [ Max(0, ImpactBid − Index) − Max(0, Index − ImpactAsk) ] / Index
```

Impact bid/ask are the average fill prices for the Impact Margin Notional. Note both terms are clamped at zero: **when the index sits inside the impact spread, the premium index is exactly 0**, no matter where the mark price is. It answers: *how far would you actually have to pay through the book, right now, relative to index?* This is the number Binance charts under Market Info → Index → Premium Index, and the number that feeds funding.

On deep books the two nearly coincide (BTCUSDT: −0.0419% vs −0.0386% mean over 3h). On thin books they diverge violently — over the same window IDOLUSDT averaged **0.0713% premium index against 0.5376% basis**, and its premium index was exactly zero in 57 of 180 minutes while its basis never once touched zero. Rank on basis and illiquid symbols whose *mark* has drifted crowd out symbols whose *book* is genuinely rich. That is a trap: the basis is not capturable if the book doesn't offer it.

So each panel **ranks on the premium index where the venue publishes one**, and on basis where it doesn't:

| Venue | Premium index source | Latency | Ranked by |
|---|---|---|---|
| Binance | REST `premiumIndexKlines` 1m (no WS stream exists) | up to 60s | premium index |
| OKX | streamed on `funding-rate` channel | ~1 min | premium index |
| Bybit | not published | — | basis |
| Bitget | not published | — | basis |

A `~ —` in the PremIdx column means that row was ranked on basis because its premium index hasn't arrived yet (first sweep still running). A dimmed PremIdx means the sample is older than three poll cycles.

## Reading the screen for basis trades

- **Sign.** Positive: perp rich to its own index — basis capture is short perp / long spot basket. Negative: perp cheap — long perp / short spot.
- **PremIdx vs Basis gap.** A large basis with a near-zero premium index is the classic illiquidity tell: the mark has wandered but the book won't let you trade it. Prefer setups where both agree.
- **Basket line** shows exactly which spot venues (and weights) the index averages. That's your hedge shopping list and your manipulation-risk check: a thin basket dominated by one venue moves the index (and mark, and funding) with one venue's order book. Bybit and Bitget don't publish constituents via public API — shown as `— (constituents not published via API)`, never guessed.
- **Funding** is the periodic rate; the premium index is its main input. A persistent premium index that funding hasn't caught up to yet is the classic basis entry.
- **Age** = time since last update; entries past the staleness threshold render dim with a yellow `age!` — don't trade stale numbers.
- Footer dots: green `●` connected, yellow `○` reconnecting, red `○` down. Venues fail independently; one dead venue never blocks the others.
- Cross-venue comparison of the same symbol (e.g. BTCUSDT rich on Bitget, flat on Binance) is the cross-exchange leg-in signal — but each venue's numbers are against **its own** index basket, and Bybit/Bitget columns are basis while Binance/OKX are premium index. Compare like with like.

Caveats: values of a few basis points are normal noise; fees, slippage and funding-interval timing eat small edges. Exotic listings with huge premiums usually have thin books and withdrawal frictions. Binance's PremIdx lags up to a minute — it is a 1-minute REST poll, not a stream.

## Architecture

```
adapters (binance|bybit|okx|bitget) ──tick──▶ store ──snapshot──▶ ranking ──▶ renderer (1 Hz)
        └─ ReconnectingSocket (backoff+jitter, heartbeat, silence watchdog)
```

- Ingestion is an O(1) upsert into a flat map; no message history is kept, so memory is bounded by universe size.
- The renderer pulls a snapshot on its own clock — fully decoupled from message rate.
- Per-exchange quirks handled: Bybit ticker snapshot+delta merge; OKX dual instId forms and streamed premium index; Binance March-2026 `/market` WS endpoint and proactive pre-24h reconnect; Bitget connection sharding (~50 subs/conn) and subscribe throttling.

## Adding an exchange adapter

1. Create `src/adapters/<name>.ts` extending `BaseAdapter` (see [base.ts](src/adapters/base.ts)).
2. Implement `fetchSymbols()` (REST, return normalized `BTCUSDT`-form symbols, run through `filterAllowed`), `fetchIndexBaskets()` (return `available: false` + empty constituents if the venue doesn't publish them — never fabricate weights), `connect()` using `ReconnectingSocket` (set the venue's heartbeat and a silence timeout), and a pure `normalize(msg)` that maps raw WS payloads to `PremiumTick`.
3. Declare `premiumIndexSource`. Set `stream` and populate `tick.premiumIndex` if the feed carries the venue's own premium index; set `rest` and implement `fetchPremiumIndex(symbols)` if it is poll-only; set `none` otherwise, and the panel ranks on basis. **Never** put `(mark−index)/index` in `premiumIndex` — that is `basis`, a different quantity, and conflating them silently corrupts the ranking.
4. If the venue sends snapshot+delta tickers, keep a per-symbol merge cache (copy the Bybit adapter).
5. Add the exchange name to the `ExchangeName` union in [types.ts](src/types.ts), the factory map in [index.ts](src/index.ts), and the zod enum in [config.ts](src/config.ts).
6. Record a real WS payload as a fixture in `test/fixtures/` and add `normalize` tests (happy path, delta merge if any, malformed input).

## Logs

Structured JSON lines in `scanner.log` (connection events, reconnects, dropped payloads, basket refreshes). Nothing is ever written to stdout except the TUI.

## License

[MIT](LICENSE)
