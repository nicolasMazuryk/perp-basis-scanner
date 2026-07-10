# Prompt: Real-Time Premium-Index Basis Arbitrage Scanner

## Role

You are a top-tier crypto market-microstructure engineer and a senior Node.js / TypeScript developer with deep, hands-on experience in perpetual-futures funding mechanics, exchange WebSocket APIs, and low-latency terminal tooling. You write strongly-typed, resilient, well-structured code.

## Objective

Build a command-line **scanner** that connects to the real-time **premium index** feeds of a configurable set of perpetual-futures exchanges and continuously surfaces **basis-trading arbitrage opportunities**.

Every ~1 second the terminal refreshes to show, **per exchange**, the **top N symbols** ranked by premium index (highest or lowest, configurable). For each surfaced symbol it also displays the **index-price basket** — i.e. the list of `[spot exchange, weight]` constituents that feed that symbol's index price — so the trader can see *where the spot leg would actually be executed*.

The scanner is a **monitoring / decision-support tool**. It does **not** place orders. A human trader reads it and opens basis trades manually.

---

## Domain background (implement to these definitions)

**Premium Index** — a normalized measure of how far a perpetual trades above (premium) or below (discount) its underlying index price.

**Index Price** — a weighted composite of spot prices sampled across several constituent spot venues (e.g. an exchange's BTC perp index may draw from Coinbase, Kraken, Bitstamp, Binance-spot, …). Each constituent carries a **weight**. This basket is the heart of the "where does the spot price come from" requirement.

**Basis trade** — long the cheap leg, short the rich leg, capture convergence + funding. A high positive premium ⇒ perp rich ⇒ *short perp / long spot*. A deeply negative premium ⇒ perp cheap ⇒ *long perp / short spot*. Surfacing extreme premium-index values on either tail is the scanner's core value.

---

## Functional requirements

1. **Real-time ingestion.** Subscribe over WebSocket to each configured exchange's premium-index channel. Prefer native premium-index streams. Never poll REST for the hot path if a stream exists (REST is acceptable for slow-changing metadata like constituents).

2. **Per-exchange leaderboard.** For each exchange independently, maintain a live-sorted view of all tracked symbols and render the **top N** (default 10) by the chosen metric.

3. **Sort direction, configurable.** `highest` (perp-rich tail) or `lowest` (perp-cheap / most-negative tail).

4. **Index-price basket per symbol.** For each displayed symbol show its constituent list as `[exchange, weight]`, sorted by weight descending. Fetch/refresh this from each exchange's index-constituents endpoint (see notes). If an exchange does not publish weights, show the constituents with weight `N/A`, or `—` if the basket is entirely unavailable, and clearly label it. **Do not fabricate weights.**

5. **1 Hz refresh.** Recompute rankings and repaint the terminal on a fixed cadence (default 1000 ms, configurable), decoupled from the raw message rate so a busy socket can't thrash the UI.

6. **Multi-exchange layout.** Render one panel/section per exchange so opportunities can be compared side by side. Keep the layout stable (no flicker, no scrolling spam) — repaint in place.

7. **Staleness handling.** Flag symbols whose last update exceeds a configurable threshold (e.g. dim/grey them and show an age indicator). Never show a stale premium as if it were live.

---

## Configuration (all via config file + CLI overrides)

| Param | Default | Meaning |
|---|---|---|
| `exchanges` | *(required, see note)* | List of exchanges to connect to |
| `topN` | `10` | Rows shown per exchange |
| `sort` | `highest` | `highest` \| `lowest` |
| `refreshMs` | `1000` | Terminal repaint cadence |
| `symbols` | `all` (USDT-margined linear perps) | Optional allow-list / quote-asset filter |
| `stalenessMs` | `5000` | Age beyond which a symbol is flagged stale |
| `basketRefreshMs` | `3600000` | How often to re-pull index constituents |

The system must be exchange-agnostic behind an adapter interface. Ship with adapters for at least: **Binance USDⓈ-M Futures, Bybit (v5 linear), OKX (v5), Bitget**, and structure the code so **Gate.io, KuCoin Futures, MEXC, HTX** can be added by writing one adapter each.

Symbol universe: all USDT linear perps.

---

## Exchange adapter notes (verify against current docs at build time)

Treat these as starting points; **check each exchange's live API docs**, as channel names and payloads change.
- **General**: not every venue publishes basket **weights** — design for partial availability rather than assuming a uniform schema.

Each adapter must normalize into a common internal shape, e.g.:

```ts
interface PremiumTick {
  exchange: string;
  symbol: string;          // normalized, e.g. "BTCUSDT"
  premiumIndex?: number;   // %, percent
  fundingRate?: number;
  nextFundingTime?: number;
  ts: number;              // exchange event time (ms)
}

interface IndexConstituent { exchange: string; symbol?: string; weight?: number; }
interface IndexBasket { exchange: string; symbol: string; constituents: IndexConstituent[]; fetchedAt: number; }
```

---

## Architecture / technical requirements

- **Language/runtime:** Node.js (LTS) + TypeScript, strict mode. No `any` on public boundaries.
- **Adapter pattern:** one `ExchangeAdapter` interface; each exchange implements `connect()`, `subscribe(symbols)`, emits normalized `PremiumTick`s, and provides `fetchIndexBaskets()`.
- **Central store:** an in-memory store keyed by `(exchange, symbol)` holding the latest tick + basket + last-seen timestamp. O(1) updates; ranking computed on the render tick, not per message.
- **Resilience (mandatory):** auto-reconnect with exponential backoff + jitter; respond to ping/pong / heartbeat per exchange rules; resubscribe on reconnect; handle partial disconnects (one exchange down must not kill the process); guard against malformed messages.
- **Rate/latency:** decouple ingestion from rendering (e.g. render on a timer reading a snapshot). Throttle/coalesce bursts.
- **Terminal UI:** use a TUI library (e.g. `blessed` / `blessed-contrib`, `ink`, or `cli-table3` + ANSI repaint). Stable in-place panels, color coding (green = positive premium, red = negative, dim = stale), clear headers per exchange, and a footer with connection status per exchange and last-refresh time.
- **Logging:** separate structured log stream (file or stderr) so logs never corrupt the live table.
- **Config:** typed config loader (e.g. `zod`-validated) from file + env + CLI flags.
- **Tests:** unit tests for metric math (premium, ranking, staleness) and for adapter payload normalization using recorded sample messages.

---

## Terminal output (illustrative)

```
┌─ BINANCE USDⓈ-M ──────────────── sort: HIGHEST ── 12:00:03 ─┐
│ #  Symbol     Premium%   Mark        Index       Funding  Age │
│ 1  XYZUSDT   +0.842%   1.2345      1.2242      +0.031%   0.4s │
│      basket: [binance 0.34] [coinbase 0.33] [kraken 0.33]     │
│ 2  ...                                                        │
└──────────────────────────────────────────────────────────────┘
┌─ BYBIT ───────────────────────── sort: HIGHEST ── 12:00:03 ─┐
│ ...                                                          │
└─────────────────────────────────────────────────────────────┘
status: binance ● bybit ● okx ○(reconnecting)   refresh 1000ms
```

Show the metric label (native premium) somewhere unambiguous. The basket line lists `[exchange weight]` sorted by weight; show `weight N/A` where the venue doesn't publish weights.

---

## Non-functional requirements

- Single long-running process; graceful shutdown on SIGINT (close sockets, restore terminal).
- Sub-second end-to-end freshness under normal conditions.
- Memory-stable over multi-day runs (no unbounded buffers).
- Cross-platform terminal (macOS/Linux at minimum).

---

## Deliverables

1. Full TypeScript project: `package.json`, `tsconfig` (strict), source, and a `README`.
2. `ExchangeAdapter` interface + the concrete adapters agreed in the exchange list.
3. Central store, ranking engine, staleness logic, and the TUI renderer.
4. Config schema + sample config + documented CLI flags.
5. Unit tests for the metric/ranking/normalization logic.
6. README covering setup, run, config, how to add a new exchange adapter, and a plain-language explanation of how to read the screen for basis trades.

---

## Constraints & disclaimers to encode

- **Read-only.** No order placement, no API secrets required for public market data.
- **Verify APIs live.** Channel names/payloads above are indicative; confirm against current docs (use context7).
- **Never invent basket weights.** Missing data is shown as `N/A`, not guessed.