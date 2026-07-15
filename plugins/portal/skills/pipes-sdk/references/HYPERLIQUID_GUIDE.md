# Hyperliquid Fills Indexer Guide

Build Pipes SDK indexers for Hyperliquid perpetual futures trade fills.

## Overview

The Pipes SDK supports Hyperliquid fills via `@subsquid/pipes/hyperliquid`. This is **not documented in the official docs yet** — the support was discovered from the npm package types.

There is **no CLI template** for Hyperliquid. You must scaffold the project manually.

## Manual Project Setup

### 1. Create the project

```bash
mkdir hl-indexer && cd hl-indexer
```

### 2. package.json

```json
{
  "name": "hl-indexer",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "dev": "tsx src/index.ts"
  },
  "dependencies": {
    "@subsquid/pipes": "0.1.0-beta.16",
    "@clickhouse/client": "^1.8.1",
    "dotenv": "^16.4.7",
    "zod": "^3.24.2"
  },
  "devDependencies": {
    "tsx": "^4.19.4",
    "@types/node": "^22.15.2",
    "typescript": "^5.8.3"
  }
}
```

### 3. .env

```env
CLICKHOUSE_URL=http://localhost:8123
CLICKHOUSE_DATABASE=hl_perps
CLICKHOUSE_USER=default
CLICKHOUSE_PASSWORD=default
```

### 4. migrations/001-create-tables.sql

```sql
CREATE TABLE IF NOT EXISTS hl_fills (
    block_number UInt64,
    timestamp DateTime64(3, 'UTC'),
    user LowCardinality(String),
    coin LowCardinality(String),
    px Float64,
    sz Float64,
    side LowCardinality(String),
    dir LowCardinality(String),
    closed_pnl Float64,
    fee Float64,
    fee_token LowCardinality(String),
    crossed Bool,
    start_position Float64,
    notional Float64,
    sign Int8
) ENGINE = CollapsingMergeTree(sign)
ORDER BY (coin, block_number, user, dir)
PARTITION BY toYYYYMM(timestamp);
```

### 5. src/index.ts

```typescript
import 'dotenv/config'
import path from 'node:path'
import { createClient } from '@clickhouse/client'
import { hyperliquidFillsPortalStream, hyperliquidFillsQuery } from '@subsquid/pipes/hyperliquid'
import { clickhouseTarget } from '@subsquid/pipes/targets/clickhouse'
import { z } from 'zod'

const env = z
  .object({
    CLICKHOUSE_USER: z.string(),
    CLICKHOUSE_PASSWORD: z.string(),
    CLICKHOUSE_URL: z.string(),
    CLICKHOUSE_DATABASE: z.string(),
  })
  .parse(process.env)

const query = hyperliquidFillsQuery()
  .addRange({ from: 920000000 })
  .addFields({
    block: { number: true, timestamp: true },
    fill: {
      user: true,
      coin: true,
      px: true,
      sz: true,
      side: true,
      dir: true,
      closedPnl: true,
      fee: true,
      feeToken: true,
      crossed: true,
      startPosition: true,
    },
  })
  .addFill({ range: { from: 920000000 }, request: { coin: ['BTC', 'ETH', 'SOL'] } })

export async function main() {
  await hyperliquidFillsPortalStream({
    id: 'hl-perps-fills',
    portal: 'https://portal.sqd.dev/datasets/hyperliquid-fills',
    outputs: query,
  })
    .pipe((blocks) => {
      const fills = blocks.flatMap((block) =>
        block.fills.map((fill) => ({
          block_number: block.header.number,
          timestamp: new Date(block.header.timestamp).toISOString(),
          user: fill.user,
          coin: fill.coin,
          px: fill.px,
          sz: fill.sz,
          side: fill.side === 'B' ? 'Buy' : 'Sell',
          dir: fill.dir,
          closed_pnl: fill.closedPnl,
          fee: fill.fee,
          fee_token: fill.feeToken,
          crossed: fill.crossed,
          start_position: fill.startPosition,
          notional: fill.px * fill.sz,
          sign: 1,
        })),
      )
      return { fills }
    })
    .pipeTo(
      clickhouseTarget({
        client: createClient({
          username: env.CLICKHOUSE_USER,
          password: env.CLICKHOUSE_PASSWORD,
          url: env.CLICKHOUSE_URL,
          database: env.CLICKHOUSE_DATABASE,
          clickhouse_settings: {
            date_time_input_format: 'best_effort',
            date_time_output_format: 'iso',
          },
        }),
        onStart: async ({ store }) => {
          const migrationsDir = path.join(process.cwd(), 'migrations')
          await store.executeFiles(migrationsDir)
        },
        onData: async ({ data, store }) => {
          if (data.fills.length > 0) {
            await store.insert({
              table: 'hl_fills',
              values: data.fills,
              format: 'JSONEachRow',
            })
          }
        },
        onRollback: async ({ safeCursor, store }) => {
          await store.removeAllRows({
            tables: ['hl_fills'],
            where: 'block_number > {latest:UInt64}',
            params: { latest: safeCursor.number },
          })
        },
      }),
    )
}

void main()
```

### 6. docker-compose.yml (if no existing ClickHouse)

If you don't have a running ClickHouse container, create one:

```yaml
services:
  clickhouse:
    image: clickhouse/clickhouse-server
    container_name: clickhouse
    ports:
      - "8123:8123"
      - "9000:9000"
    environment:
      CLICKHOUSE_PASSWORD: default
    volumes:
      - clickhouse-data:/var/lib/clickhouse
volumes:
  clickhouse-data:
```

```bash
docker compose up -d
```

If you already have a ClickHouse container, skip this step and reuse it — just create a new database for the indexer.

### 7. Install and run

```bash
bun install
# Create database
docker exec clickhouse clickhouse-client --password=default \
  --query "CREATE DATABASE IF NOT EXISTS hl_perps"
npm run dev
```

## API Reference

### hyperliquidFillsQuery

Builder for constructing Hyperliquid fills queries.

| Method | Description |
|--------|-------------|
| `.addRange({ from })` | Set the starting block (dataset starts at 750,000,000) |
| `.addFields({ block, fill })` | Select which fields to include |
| `.addFill({ range, request })` | Add fill filter (**range is required**) |

### addFill request options

| Field | Type | Description |
|-------|------|-------------|
| `coin` | `string[]` | Asset symbols: `['BTC', 'ETH', 'SOL']` |
| `user` | `string[]` | Trader addresses: `['0x...']` |
| `dir` | `string[]` | Directions: `['Open Long', 'Close Short']` |
| `feeToken` | `string[]` | Fee tokens: `['USDC']` |
| `builder` | `string[]` | Builder addresses |
| `cloid` | `string[]` | Client order IDs |

### Fill field types

All numeric values are native JavaScript `number` (float64), NOT BigInt:

| Field | Type | Notes |
|-------|------|-------|
| `px` | number | Execution price |
| `sz` | number | Trade size/quantity |
| `closedPnl` | number | Realized PnL (0 for opens, negative = loss) |
| `fee` | number | Fee (negative = maker rebate) |
| `startPosition` | number | Position before this fill |
| `side` | `'B' \| 'S'` | Buy or Sell |
| `dir` | string | "Open Long", "Close Long", "Open Short", "Close Short", "Long > Short", "Short > Long", "Net Child Vaults" |
| `crossed` | boolean | true = taker (market order) |

## Use Case Examples

### Whale Tracker (filter by user)

Track specific whale addresses to monitor their positions, PnL, and activity:

```typescript
const WHALES = [
  '0xecb63caa47c7c4e77f60f1ce858cf28dc2b82b00',
  '0x0fd468a73084daa6ea77a9261e40fdec3e67e0c7',
  '0xe3b6e3443c8f2080704e7421bad9340f13950acb',
]

const query = hyperliquidFillsQuery()
  .addRange({ from: 920000000 })
  .addFields({
    block: { number: true, timestamp: true },
    fill: {
      user: true, coin: true, px: true, sz: true,
      side: true, dir: true, closedPnl: true, fee: true,
      crossed: true, startPosition: true,
    },
  })
  .addFill({ range: { from: 920000000 }, request: { user: WHALES } })
```

**Tested result:** 894K fills for 5 whales in ~60 seconds. Top whale had $1.19B volume and -$1.47M PnL.

### Two-Phase Whale Discovery Workflow

Whale addresses aren't known upfront — you discover them from trading data. This requires a two-phase approach:

**Phase 1: Broad indexer → discover whales**
1. Create a broad indexer tracking major coins (BTC, ETH, SOL) with all users
2. Wait for it to sync (2-3 minutes for a 7-day window)
3. Query top traders by volume:
   ```sql
   SELECT
     user,
     count() as fills,
     round(sum(notional)/1e6, 0) as volume_M,
     round(sum(closed_pnl), 0) as pnl
   FROM hl_fills
   WHERE sign = 1
   GROUP BY user
   ORDER BY volume_M DESC
   LIMIT 20
   ```
4. Pick the top 5-10 addresses as your whale list

**Phase 2: Whale tracker → deep monitoring**
1. Create a second indexer with those specific addresses (filter by `user`)
2. This captures ALL their activity across ALL coins, not just the majors
3. The whale tracker is much more efficient (fewer fills to process per block)

**Important:** Whale addresses change over time. Re-run Phase 1 periodically (weekly/monthly) to refresh your whale list. The top whale today may not be the top whale next month.

### Multi-Coin Volume Tracker (10+ coins)

Track fills across many coins including alts and memes:

```typescript
// Note: Use kPEPE/kBONK/kFLOKI (not PEPE/BONK/FLOKI). Discover tickers with a broad query first.
const COINS = ['BTC', 'ETH', 'SOL', 'HYPE', 'DOGE', 'WIF', 'ARB', 'SUI', 'AVAX']

const query = hyperliquidFillsQuery()
  .addRange({ from: 924000000 })
  .addFields({
    block: { number: true, timestamp: true },
    fill: {
      coin: true, px: true, sz: true,
      side: true, dir: true, closedPnl: true, fee: true, crossed: true,
    },
  })
  .addFill({ range: { from: 924000000 }, request: { coin: COINS } })
```

**Tested result:** 2.35M fills for 9 coins in ~60 seconds. BTC dominated with $2.64B, HYPE had $368M.

**Tip:** You can omit fields you don't need (e.g., `user`, `startPosition`, `feeToken`) from `.addFields()` to reduce data transfer and storage. Only request what your use case requires.

## Available Coin Tickers

Hyperliquid uses **uppercase symbol names** as coin identifiers. Common tickers that are confirmed to work:

**Majors:** `BTC`, `ETH`, `SOL`

**L1/L2:** `AVAX`, `SUI`, `ARB`, `OP`, `APT`, `SEI`, `TIA`, `INJ`

**DeFi/Ecosystem:** `HYPE` (Hyperliquid native token), `LINK`, `UNI`, `AAVE`, `MKR`

**Meme coins:** `DOGE`, `WIF`, `FARTCOIN`, `TRUMP`, `MELANIA`

**Prefixed tickers (k-prefix):** Some tokens use a `k` prefix: `kPEPE`, `kBONK`, `kFLOKI`. Using the unprefixed name (e.g., `PEPE`) returns 0 fills. Always verify tickers by running a broad query first.

**Other prefixed tickers:** Some assets use exchange-specific prefixes: `cash:GOLD`, `cash:SILVER`, `cash:TSLA`, `cash:USA500`, `xyz:GOLD`, `xyz:SILVER`, `xyz:XYZ100`, `xyz:PLATINUM`, `xyz:TSLA`. Numbered tickers like `@230`, `@107`, `@156` also exist for newer listings.

**To discover all available coins**, run a broad query without coin filters and aggregate:
```sql
SELECT coin, count() as fills FROM hl_fills GROUP BY coin ORDER BY fills DESC
```

## TradFi Asset Classification

Hyperliquid uniquely lists traditional finance assets (equities, commodities, ETFs) alongside crypto perpetuals. When building indexers that need to distinguish asset classes, use this classification logic:

### Classification rules

| Pattern | Category | Examples |
|---------|----------|----------|
| `cash:*` prefix | TradFi (legacy) | `cash:TSLA`, `cash:GOLD`, `cash:USA500` |
| `xyz:*` prefix | TradFi (newer) | `xyz:GOLD`, `xyz:PLATINUM`, `xyz:XYZ100` |
| `@NNN` format | HIP-3 permissionless | `@230`, `@107`, `@156` |
| Plain name (known TradFi) | TradFi (no prefix) | `HOOD`, `GOOGL`, `TSM`, `NATGAS`, `PLATINUM`, `EWY`, `EWJ` |
| Plain name (everything else) | Crypto | `BTC`, `ETH`, `SOL`, `HYPE`, `kPEPE` |

### Boilerplate classification function

```typescript
// Known plain-name TradFi tickers on Hyperliquid (no cash:/xyz: prefix)
const TRADFI_PLAIN_TICKERS = new Set([
  'HOOD', 'GOOGL', 'TSM', 'NATGAS', 'PLATINUM',
  'EWY', 'EWJ', 'CRWV', 'SNDK', 'SKHX',
])

function classifyAsset(coin: string): 'tradfi' | 'crypto' | 'hip3' {
  if (coin.startsWith('@')) return 'hip3'
  if (coin.startsWith('cash:') || coin.startsWith('xyz:')) return 'tradfi'
  if (TRADFI_PLAIN_TICKERS.has(coin)) return 'tradfi'
  return 'crypto'
}

// Use in .pipe() transform:
// asset_class: classifyAsset(fill.coin),
```

### Dashboard JavaScript version

```javascript
var TRADFI_PLAIN = ['HOOD','GOOGL','TSM','NATGAS','PLATINUM','EWY','EWJ','CRWV','SNDK','SKHX'];
function classifyAsset(coin) {
  if (coin.startsWith('@')) return 'hip3';
  if (coin.startsWith('cash:') || coin.startsWith('xyz:')) return 'tradfi';
  if (TRADFI_PLAIN.indexOf(coin) !== -1) return 'tradfi';
  return 'crypto';
}
```

### Notes
- The TradFi plain-ticker list is not exhaustive and grows as Hyperliquid adds new markets. When building a TradFi-focused indexer, run a broad discovery query first and manually classify any new plain tickers.
- HIP-3 (`@NNN`) markets can be either crypto or TradFi — the number alone does not indicate asset class. Treat them as a separate category or classify individually if needed.
- TradFi markets typically have lower volume and fewer fills than major crypto pairs. Expect 10-100x fewer fills for `GOOGL` compared to `BTC`.

## Choosing a Start Block

The Hyperliquid dataset starts at block **750,000,000**. Blocks increment at roughly **~1 block per second** (not exactly, but close enough for estimation).

**Estimating a "last N days" start block:**
```
current_block ≈ 750,000,000 + (seconds since dataset start)
blocks_per_day ≈ 86,400
start_block ≈ current_block - (N_days × 86,400)
```

**Reference points (approximate):**
- Block 920,000,000 ≈ early March 2026 (~6 months of data)
- Block 924,000,000 ≈ mid-March 2026 (~last 2-3 weeks)
- Block 930,000,000 ≈ late March 2026

**To find the current head block**, query the Portal or start an indexer and watch the log output — it prints the target block range.

**Tip:** For testing, start with the last 3-7 days of data. For production dashboards, sync a wider range. A 7-day window for BTC/ETH/SOL yields ~6M fills and takes ~2-3 minutes to sync.

## Computed Fields

The `notional` field used in the examples (`notional: fill.px * fill.sz`) is **not a native fill field** — it's computed in the `.pipe()` transform by multiplying price × size. The native fill fields are listed in the API Reference table above. You can add any computed fields you need (e.g., `notional`, `volume_usd`, `is_large_trade`) in the pipe transform.

## Timestamp Handling (Hyperliquid-specific)

Hyperliquid timestamps work differently from EVM indexers:

- `block.header.timestamp` is a **millisecond Unix timestamp** (number)
- The recommended pattern is `new Date(block.header.timestamp).toISOString()` which produces strings like `"2026-03-17T12:00:00.000Z"`
- ClickHouse accepts these ISO strings when configured with `date_time_input_format: 'best_effort'` and a `DateTime64(3, 'UTC')` column

**Do NOT divide by 1000** here — the ISO string approach already carries millisecond precision, and `DateTime64(3, 'UTC')` expects it. Epoch seconds in a `DateTime64(3)` column land in 1970.

For EVM indexers the divisor is not a fixed rule either: it depends on the ClickHouse column precision. See [SCHEMA_GUIDE.md](SCHEMA_GUIDE.md#timestamp-handling) and [TROUBLESHOOTING.md](TROUBLESHOOTING.md#error-pattern-5c-timestamps-show-1970-dates).

## Common Gotchas

### 1. addFill requires range

```typescript
// WRONG — crashes with "Cannot read properties of undefined (reading 'from')"
.addFill({ request: { coin: ['BTC'] } })

// CORRECT
.addFill({ range: { from: 920000000 }, request: { coin: ['BTC'] } })
```

### 2. Dataset starts at block 750,000,000

```typescript
// WRONG — "fromBlock (0) is before dataset start block (750,000,000)"
.addRange({ from: 0 })

// CORRECT
.addRange({ from: 750000000 })
```

### 3. No evmDecoder — use .pipe() directly

Hyperliquid fills don't use `evmDecoder`. `.pipe()` receives `Block[]` directly where each block has `header` and `fills`. Use `.pipe()` to transform the data yourself.

### 4. Portal URL includes the dataset name

```typescript
// CORRECT
portal: 'https://portal.sqd.dev/datasets/hyperliquid-fills'

// WRONG (just the portal root)
portal: 'https://portal.sqd.dev'
```

### 5. Side codes are single characters

`'B'` for buy, `'S'` for sell — not `'buy'`/`'sell'` or `'Buy'`/`'Sell'`. The pipe transform typically maps these to human-readable strings (`'Buy'`/`'Sell'`) before inserting into ClickHouse, so your SQL queries should use the mapped values (e.g., `WHERE side = 'Buy'`), not the raw codes.

## Performance

### Benchmark: BTC + ETH + SOL fills (block 920M to real-time)
- **5M fills** indexed in ~70 seconds
- **$18.4B notional volume** captured
- Ingestion rate: ~70K blocks/second

### Benchmark: Whale tracker (5 addresses, all coins)
- **894K fills** indexed in ~60 seconds
- **$3B+ total whale volume** captured
- User filter efficiently narrows to specific addresses

### Benchmark: Multi-coin tracker (9 coins, block 924M)
- **2.35M fills** indexed in ~60 seconds
- **$5B+ total volume** across BTC, ETH, SOL, HYPE, DOGE, WIF, ARB, SUI, AVAX

### Running multiple indexers
Multiple Hyperliquid indexers can run simultaneously without issues — each with its own ClickHouse database. Tested 2 indexers (whale + multi-coin) running in parallel with no performance degradation.

## Example Queries

### Daily volume by coin
```sql
SELECT
  toDate(timestamp) as day,
  coin,
  count() as fills,
  round(sum(notional)/1e6, 1) as volume_M
FROM hl_fills
WHERE sign = 1
GROUP BY day, coin
ORDER BY day, volume_M DESC
```

### Long vs Short breakdown
```sql
SELECT
  coin,
  dir,
  count() as fills,
  round(sum(notional)/1e6, 1) as volume_M,
  round(sum(closed_pnl), 0) as pnl
FROM hl_fills
WHERE sign = 1
GROUP BY coin, dir
ORDER BY coin, volume_M DESC
```

### Top traders by volume
```sql
SELECT
  user,
  count() as fills,
  round(sum(notional)/1e6, 1) as volume_M,
  round(sum(closed_pnl), 0) as total_pnl
FROM hl_fills
WHERE sign = 1
GROUP BY user
ORDER BY volume_M DESC
LIMIT 20
```

### Whale PnL leaderboard
```sql
SELECT
  user,
  count() as fills,
  round(sum(notional)/1e6, 1) as volume_M,
  round(sum(closed_pnl), 0) as pnl,
  round(sum(fee), 0) as fees,
  round(sum(closed_pnl) - sum(fee), 0) as net_pnl
FROM whale_fills
WHERE sign = 1
GROUP BY user
ORDER BY net_pnl DESC
```

### Whale position changes over time
```sql
-- Note: side values in ClickHouse are 'Buy'/'Sell' (mapped from raw 'B'/'S' in the pipe)
SELECT
  toStartOfHour(timestamp) as hour,
  user,
  coin,
  sumIf(sz, side = 'Buy') as bought,
  sumIf(sz, side = 'Sell') as sold,
  round(sumIf(sz, side = 'Buy') - sumIf(sz, side = 'Sell'), 4) as net_flow
FROM whale_fills
WHERE coin = 'BTC' AND sign = 1
GROUP BY hour, user, coin
ORDER BY hour DESC
LIMIT 50
```

### Win rate and PnL leaderboard
```sql
-- Win rate requires filtering to only closing trades (closedPnl != 0)
SELECT
  user,
  count() as fills,
  round(sum(notional)/1e6, 2) as volume_M,
  round(sum(closed_pnl), 0) as pnl,
  round(sum(closed_pnl) - sum(fee), 0) as net_pnl,
  round(countIf(closed_pnl > 0) * 100.0 / countIf(closed_pnl != 0), 1) as win_rate
FROM hl_fills
WHERE sign = 1
GROUP BY user
HAVING countIf(closed_pnl > 0) + countIf(closed_pnl < 0) > 0
ORDER BY volume_M DESC
LIMIT 20
```

### Long vs Short volume by direction labels
```sql
-- Use dir values for long/short breakdown (not side)
SELECT
  coin,
  round(sum(CASE WHEN dir IN ('Open Long', 'Close Short', 'Long > Short') THEN notional ELSE 0 END)/1e6, 2) as long_volume_M,
  round(sum(CASE WHEN dir IN ('Open Short', 'Close Long', 'Short > Long') THEN notional ELSE 0 END)/1e6, 2) as short_volume_M
FROM hl_fills
WHERE sign = 1
GROUP BY coin
ORDER BY long_volume_M + short_volume_M DESC
```

### Maker vs Taker split
```sql
SELECT
  coin,
  if(crossed, 'Taker', 'Maker') as type,
  count() as fills,
  round(sum(fee), 2) as total_fees
FROM hl_fills
GROUP BY coin, type
ORDER BY coin, type
```
