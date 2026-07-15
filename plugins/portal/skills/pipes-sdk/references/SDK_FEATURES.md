# SDK 1.0 Features & Testing

Reference for SDK 1.0+ APIs: time-based ranges, `defineAbi`, query builder shorthands, typed errors, the testing library, Tron/Bitcoin streams, BigQuery/Parquet targets, and cursor keying (current line: `@subsquid/pipes@1.0.0-alpha.16`).

## Time-Based Ranges

Ranges accept ISO date strings and `Date` objects. Dates are auto-resolved to block numbers via the Portal API.

```typescript
evmDecoder({
  range: { from: '2024-01-01' },  // ISO date → block number
  events: { transfers: erc20.events.Transfer },
})

// Date objects
evmDecoder({
  range: { from: new Date('2024-01-01'), to: new Date('2024-02-01') },
  events: { ... },
})

// Formatted block numbers (underscores OK)
evmDecoder({ range: { from: '18_908_900' }, ... })

// Latest block (only for `from`)
evmDecoder({ range: { from: 'latest' }, ... })
```

**Validation:** Inverted ranges (`from > to`) and unresolvable timestamps throw `BlockRangeConfigurationError` (E0002).

## `defineAbi` — Use JSON ABIs Without Codegen

`defineAbi()` converts a standard JSON ABI into decoder objects at runtime — no `squid-evm-typegen` step needed.

```typescript
import erc20Json from './erc20.json'
import { defineAbi } from '@subsquid/pipes'

const erc20 = defineAbi(erc20Json)

evmDecoder({
  events: {
    transfers: erc20.events.Transfer,
    approvals: erc20.events.Approval,
  },
})
```

Accepts: plain ABI array, `as const` literal (full type inference), or Hardhat/Foundry artifact with `.abi` field. Uses `@subsquid/evm-codec` (~10x faster than viem).

## Query Builder Shorthands

Factory functions replace `new *QueryBuilder()`:

| Old | New |
|-----|-----|
| `new EvmQueryBuilder()` | `evmQuery()` |
| `new SolanaQueryBuilder()` | `solanaQuery()` |
| `new HyperliquidFillsQueryBuilder()` | `hyperliquidFillsQuery()` |
| `new TronQueryBuilder()` | `tronQuery()` |
| `new BitcoinQueryBuilder()` | `bitcoinQuery()` |

## Tron Portal Streams

`@subsquid/pipes/tron` streams `tron-mainnet` with a native Tron data model (alpha.15+).

```typescript
import { TronQueryBuilder, tronPortalStream } from '@subsquid/pipes/tron'

const stream = tronPortalStream({
  id: 'tron-usdt-transfers',
  portal: 'https://portal.sqd.dev/datasets/tron-mainnet',
  outputs: new TronQueryBuilder()
    .addFields({
      block: { number: true, hash: true, timestamp: true },
      transaction: { transactionIndex: true, hash: true, type: true, energyUsageTotal: true, result: true },
      log: { transactionIndex: true, logIndex: true, address: true, topics: true, data: true },
    })
    // USDT transfer(...) calls + the logs they emit
    .addTriggerSmartContractTransaction({
      request: {
        contract: ['41a614f803b6fd780986a42c78ec9c7f77e6ded13c'], // USDT, bare hex
        sighash: ['a9059cbb'],                                    // transfer(address,uint256)
        logs: true,
      },
      range: { from: 84_000_000 },
    }),
})

for await (const { data } of stream) {
  for (const block of data) {
    // block.header, block.transactions, block.logs, block.internalTransactions
  }
}
```

Request methods on `TronQueryBuilder`: `addTransaction` (by contract `type`), `addTransferTransaction` (native TRX, `owner`/`to`), `addTransferAssetTransaction` (TRC-10, `owner`/`to`/`asset`), `addTriggerSmartContractTransaction` (`owner`/`contract`/`sighash`), `addLog` (`address`/`topic0..3`), `addInternalTransaction` (`caller`/`transferTo`), `includeAllBlocks`.

**Tron gotchas:**
- All hex is **bare** (no `0x`): transaction-level addresses are 21-byte `41…` hex; **log addresses use the 20-byte EVM-style form without `41`**; topics/sighashes plain hex
- `timestamp`/`expiration` are Unix **milliseconds**
- Amounts (`fee`, `feeLimit`, `energy*`, `net*`) arrive as decimal strings, surfaced as `bigint`; TRX values are in SUN (1 TRX = 1e6 SUN)
- Log topics hold 32-byte padded values — Tron address = `'41' + topic.slice(-40)`

## Bitcoin Portal Streams

`@subsquid/pipes/bitcoin` streams `bitcoin-mainnet` with a UTXO-model API.

```typescript
import { BitcoinQueryBuilder, bitcoinPortalStream } from '@subsquid/pipes/bitcoin'

const stream = bitcoinPortalStream({
  id: 'bitcoin-utxo',
  portal: 'https://portal.sqd.dev/datasets/bitcoin-mainnet',
  outputs: new BitcoinQueryBuilder()
    .addFields({
      block: { number: true, hash: true, timestamp: true },
      transaction: { transactionIndex: true, txid: true, size: true },
      input: { transactionIndex: true, inputIndex: true, coinbase: true, txid: true, vout: true,
               prevoutValue: true, prevoutScriptPubKeyType: true, prevoutScriptPubKeyAddress: true },
      output: { transactionIndex: true, outputIndex: true, value: true,
                scriptPubKeyType: true, scriptPubKeyAddress: true, scriptPubKeyAsm: true },
    })
    .addTransaction({
      request: { inputs: true, outputs: true },
      range: { from: 900_000, to: 900_002 },
    }),
})

for await (const { data } of stream) {
  for (const block of data) {
    // block.header, block.transactions, block.inputs, block.outputs
  }
}
```

Request methods on `BitcoinQueryBuilder`: `addTransaction` (`{inputs, outputs}` relation flags), `addInput` (`type`/`prevoutScriptPubKeyAddress`/`prevoutScriptPubKeyType`/`prevoutGenerated` + `transaction`/`transactionInputs`/`transactionOutputs`), `addOutput` (`scriptPubKeyAddress`/`scriptPubKeyType` + relation flags), `includeAllBlocks`.

**Bitcoin gotchas:**
- Values are **BTC floats** (Bitcoin Core convention), not satoshis
- Hex strings are bare (no `0x`)
- `scriptPubKeyType` gives the standard classification (`pubkeyhash`, `scripthash`, `witness_v0_keyhash`, `witness_v1_taproot`, `nulldata`, …) — no manual script parsing needed
- Coinbase inputs have `coinbase` set and no `txid`/`vout`/prevout data

## New EVM Query Fields (alpha.14+)

Added to the EVM field selection:
- **Block:** `uncles`, `withdrawalsRoot`, `withdrawals`
- **Transaction:** `logsBloom`, `accessList`

## Typed Error System

Framework errors carry unique codes linking to docs.

| Error | Code | When |
|-------|------|------|
| `DefaultPipeIdError` | E0001 | `.pipeTo()` called without `id` on source |
| `BlockRangeConfigurationError` | E0002 | Inverted range, invalid date with `'latest'`, unresolvable timestamp |

## Testing with `@subsquid/pipes/testing/evm`

Test pipe logic end-to-end without hitting a real portal. Requires `vitest` and `viem` as dev dependencies.

The library provides:
- **`encodeEvent`** — encode events with full type inference from viem ABIs
- **`mockBlock`** — build mock blocks with auto-generated metadata
- **`evmPortalMockStream`** — spin up a mock portal HTTP server
- **`resetMockBlockCounter`** — reset block numbering between tests

### Basic test setup

```typescript
import { commonAbis, evmDecoder, evmPortalStream } from '@subsquid/pipes/evm'
import {
  type MockPortal,
  encodeEvent,
  evmPortalMockStream,
  mockBlock,
  resetMockBlockCounter,
} from '@subsquid/pipes/testing/evm'

// Helper: collect stream output
async function readAll<T>(stream: AsyncIterable<{ data: T[] }>): Promise<T[]> {
  const res: T[] = []
  for await (const chunk of stream) res.push(...chunk.data)
  return res
}

const ERC20_ABI = [
  {
    type: 'event' as const,
    name: 'Transfer',
    inputs: [
      { name: 'from', type: 'address', indexed: true },
      { name: 'to', type: 'address', indexed: true },
      { name: 'value', type: 'uint256', indexed: false },
    ],
  },
] as const

const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' as const
const ALICE = '0x7a250d5630b4cf539739df2c5dacb4c659f2488d' as const
const BOB = '0xc82e11e709deb68f3631fc165ebd8b4e3fc3d18f' as const
```

### Test 1: Decode events from mock blocks

```typescript
let portal: MockPortal

beforeEach(() => resetMockBlockCounter())
afterEach(async () => await portal?.close())

it('should decode ERC20 transfers', async () => {
  const transfer = encodeEvent({
    abi: ERC20_ABI,
    eventName: 'Transfer',
    address: USDC,
    args: { from: ALICE, to: BOB, value: 1_000_000n },
  })

  portal = await evmPortalMockStream({
    blocks: [mockBlock({ transactions: [{ logs: [transfer] }] })],
  })

  const stream = evmPortalStream({
    id: 'test',
    portal: portal.url,
    outputs: evmDecoder({
      range: { from: 0, to: 1 },
      events: { transfers: commonAbis.erc20.events.Transfer },
    }),
  }).pipe((batch) => batch.transfers)

  const transfers = await readAll(stream)
  expect(transfers).toHaveLength(1)
  expect(transfers[0].event.from).toBe(ALICE)
  expect(transfers[0].event.value).toBe(1_000_000n)
  expect(transfers[0].contract).toBe(USDC)
})
```

### Test 2: Custom pipe transformations

```typescript
it('should test custom transformations', async () => {
  const transfer = encodeEvent({
    abi: ERC20_ABI, eventName: 'Transfer', address: USDC,
    args: { from: ALICE, to: BOB, value: 2_000_000n },
  })

  portal = await evmPortalMockStream({
    blocks: [mockBlock({ transactions: [{ logs: [transfer] }] })],
  })

  const stream = evmPortalStream({
    id: 'test',
    portal: portal.url,
    outputs: evmDecoder({
      range: { from: 0, to: 1 },
      events: { transfers: commonAbis.erc20.events.Transfer },
    }),
  })
    .pipe((batch) => batch.transfers)
    .pipe((transfers) =>
      transfers.map((t) => ({
        from: t.event.from,
        to: t.event.to,
        amount: Number(t.event.value) / 1e6,
      })),
    )

  const results = await readAll(stream)
  expect(results[0]).toEqual({ from: ALICE, to: BOB, amount: 2 })
})
```

### Key testing patterns

- `encodeEvent` accepts `abi`, `eventName`, `address`, and typed `args`
- `mockBlock` auto-generates `number`, `hash`, `timestamp` — call `resetMockBlockCounter()` in `beforeEach`
- `evmPortalMockStream` returns `{ url, close() }` — use `portal.url` with `evmPortalStream`
- Chain `.pipe()` on the stream to test transformations
- Multiple event types: pass multiple in `events: { transfers: ..., approvals: ... }` and access `batch.transfers`, `batch.approvals`
- A parallel Bitcoin testing surface exists at `@subsquid/pipes/testing/bitcoin` (same mock-block / mock-stream shape for the UTXO model)

## Decoded Event Field Access in `.pipe()`

When using `evmDecoder` with a manual `.pipe()` transform, each decoded event `d` has:

| Field | Type | Description |
|-------|------|-------------|
| `d.event.*` | object | Decoded event parameters (e.g., `d.event.vault`) |
| `d.block.number` | number | Block number |
| `d.rawEvent.transactionHash` | string | Transaction hash |
| `d.rawEvent.logIndex` | number | Log index within the block |
| `d.timestamp` | Date | Block timestamp as JS Date |
| `d.contract` | string | Emitter contract address |
| `d.factory` | object/null | Factory metadata (if using factory pattern) |

**⚠️ Common mistake:** Using `d.blockNumber` or `d.txHash` (which don't exist). These silently return `undefined`, stored as `0` or `""` in ClickHouse.

**⚠️ DateTime64(3) gotcha:** For `DateTime64(3, 'UTC')` columns, pass ISO strings via `d.timestamp.toISOString()` with `date_time_input_format: 'best_effort'`. Passing epoch seconds (e.g., `1700392127`) is misinterpreted as `1970-01-20`.

The CLI-generated `enrichEvents` helper (in `src/utils/index.ts`) flattens into `{ ...event, blockNumber, txHash, logIndex, timestamp /* unix SECONDS */, contractAddress }`. It is used **only by the `custom` templates** — the `erc20Transfers`/`uniswapV3Swaps` templates use inline `.pipe()` maps instead, and those emit `timestamp` in **milliseconds** (not seconds; see Timestamp Handling).

## Timestamp Handling (CRITICAL)

`d.timestamp.getTime()` returns **milliseconds**. Whether you divide by 1000 depends on the **ClickHouse column precision** — there is no blanket rule:

| Column type | Stored ticks | Convert `d.timestamp` with |
|-------------|--------------|----------------------------|
| `DateTime` (no precision arg) | seconds | `Math.floor(d.timestamp.getTime() / 1000)` |
| `DateTime(3)` / `DateTime64(3)` | **milliseconds** | `d.timestamp.getTime()` — **no division** |

ClickHouse resolves `DateTime(3)` to `DateTime64(3)` (millisecond precision), so a `DateTime(3)` column stores epoch-**ms**. The CLI's generated ClickHouse tables use `timestamp DateTime(3)` and the generated transformer emits `.getTime()` with **no division** — so "always divide `getTime()` by 1000" is WRONG for the default scaffold and pushes every row to ~1970 if applied.

```typescript
// DateTime column (seconds)
timestamp: Math.floor(d.timestamp.getTime() / 1000)

// DateTime(3) / DateTime64(3) column (ms) — the CLI default
timestamp: d.timestamp.getTime()
```

**Both** mismatch directions land near 1970 (seconds into a ms column, or ms into a seconds column), so a "1970" date alone does not tell you which way is wrong — check the **column type**, then match the divisor to it.

### `enrichEvents` vs inline maps

The CLI-generated `enrichEvents` helper divides by 1000 and emits **unix seconds** (`new Date(v.timestamp).getTime() / 1000`) — but it is used only by the `custom` templates. The `erc20Transfers`/`uniswapV3Swaps` templates use inline `.pipe()` maps that emit **milliseconds** (`.getTime()`, no division) to match their `DateTime(3)` columns. Pick the divisor from the column type, not from a habit or from which helper you copied.

## Target Configuration

Available targets: ClickHouse, PostgreSQL (Drizzle), BigQuery, Parquet. (A `memory` target exists in source but is **not** exported from the package in alpha.16 — `createMemoryTarget` is absent from the package exports, so it is internal/testing-only and cannot be imported by consumers.)

### ClickHouse

```typescript
import { clickhouseTarget } from '@subsquid/pipes/targets/clickhouse'

stream.pipeTo(clickhouseTarget({
  client: createClient({ url: process.env.CLICKHOUSE_URL }),
  onData: async ({ store, data, ctx }) => {
    await store.insert({ table: 'transfers', values: data.transfers, format: 'JSONEachRow' })
  },
  onRollback: async ({ type, store, safeCursor }) => {
    // type: 'offset_check' (startup) | 'blockchain_fork' (reorg)
    await store.removeAllRows({
      tables: 'transfers',
      where: 'block_number > {latest:UInt32}',
      params: { latest: safeCursor.number },
    })
  },
}))
```

**Rollbacks and materialized views (alpha.16):** on a fork, `store.removeAllRows` removes rows by inserting **cancel rows** (`sign = -1`) when the table is a `CollapsingMergeTree`/`VersionedCollapsingMergeTree` (or Replicated variant) with a `sign` column — the only delete mechanism that propagates through materialized views. Write MVs rollback-aware: aggregate with the sign (`sum(value * sign)`, `sum(sign)` for counts). On any other engine it falls back to a lightweight `DELETE` with a warning — the table is cleaned but MVs built on it keep the removed rows. Irreversible aggregates (`min`, `max`, `uniq`, `argMax`) cannot be rolled back by any mechanism — recompute the affected tail after a fork. A `minmax` skip index on `block_number` is auto-created on first rollback; call `store.ensureRollbackIndex({ table })` in `onStart` to set it up eagerly.

### PostgreSQL with Drizzle

```typescript
import { batchForInsert, drizzleTarget } from '@subsquid/pipes/targets/drizzle/node-postgres'

stream.pipeTo(drizzleTarget({
  db: drizzle(pool),
  tables: [transfersTable],
  // ONE destructured object; insert via `tx`, NOT `ctx.db`
  onData: async ({ tx, data, ctx }) => {
    for (const rows of batchForInsert(data.transfers)) {
      await tx.insert(transfersTable).values(rows)
    }
  },
  onStart: async ({ db }) => { /* create tables / run migrations */ },
  onBeforeRollback: async ({ tx, cursor }) => { /* optional, before rollback deletes */ },
  onAfterRollback: async ({ tx, cursor }) => { /* optional, after rollback deletes */ },
  settings: {
    state: { id: 'my-pipe' },                         // pin cursor key (alpha.15+); defaults to the pipe id
    transaction: { isolationLevel: 'serializable' },  // default isolation level
  },
}))
```

**Insert via `tx`, not `ctx.db`.** Each `onData` batch runs inside the target's snapshot/rollback transaction, and `tx` is that transaction handle. Writing through `ctx.db` bypasses it, so the rows escape the rollback snapshot and a reorg can't undo them. The callback takes **one** destructured object `{ tx, data, ctx }` — not two positional args. Use `batchForInsert` (alias `chunk`), exported from `@subsquid/pipes/targets/drizzle/node-postgres`, to split large batches under Postgres's 32767-parameter limit.

### BigQuery (alpha.16)

```typescript
import { BigQuery } from '@google-cloud/bigquery'
import { bigqueryTarget } from '@subsquid/pipes/targets/bigquery'

stream.pipeTo(bigqueryTarget({
  client: { bigquery: new BigQuery({ projectId: PROJECT }) },
  dataset: 'eth_transfers',
  tables: [{
    table: 'transfers',
    blockNumberColumn: 'block_number',
    schema: [
      { name: 'block_number', type: 'INT64', mode: 'REQUIRED' },
      { name: 'block_timestamp', type: 'TIMESTAMP', mode: 'REQUIRED' },
      { name: 'from', type: 'STRING', mode: 'REQUIRED' },
      { name: 'to', type: 'STRING', mode: 'REQUIRED' },
      { name: 'amount', type: 'BIGNUMERIC', mode: 'NULLABLE' },
      { name: 'amount_raw', type: 'STRING', mode: 'REQUIRED' },
    ],
    clusterBy: ['from'],
  }],
  onData: async ({ store, data }) => {
    store.insert('transfers', data.transfers.map(t => ({ /* row */ })))  // synchronous buffer; commits when onData returns
  },
}))
```

Key facts: tables auto-create with `PARTITION BY RANGE_BUCKET(block_number, …)` (partition column forced `INT64 NOT NULL`); declared schema is enforced against existing tables (fails fast on mismatch); reorgs run bounded `DELETE`s per tracked table, resumed idempotently after crashes. An optional `onBeforeRollback: async ({ cursor }) => ...` fires after the safe cursor resolves, before the per-table `DELETE`s. Gotchas: `TIMESTAMP` wire format is INT64 **microseconds** (`date.getTime() * 1000` — ISO strings are NOT parsed); uint256 overflows BIGNUMERIC (38 integer digits) — clamp and keep the exact decimal in a STRING column.

### Parquet (alpha.16)

```typescript
import { parquetTarget } from '@subsquid/pipes/targets/parquet'

stream.pipeTo(parquetTarget({
  dir: './parquet-out',
  tables: [{
    table: 'transfers',
    schema: {
      blockNumber: { type: 'INT64' },            // default block-number column, required
      timestamp: { type: 'TIMESTAMP', optional: true },  // ← Date
      day: { type: 'DATE', optional: true },             // ← Date truncated to UTC day
      topics: { type: 'LIST', element: { type: 'UTF8' } },  // ← plain array
      amount: { type: 'UTF8' },                  // uint256 fits no Parquet numeric — keep decimal text
    },
  }],
  settings: { rollover: { maxBytes: 128 * 1024 * 1024 }, compression: 'SNAPPY' },
  onData: ({ store, data }) => { store.insert('transfers', data.transfers.map(t => ({ /* row */ }))) },
}))
```

Key facts: writes **finalized-only** rotating files (`<min>-<max>.parquet`) readable directly by DuckDB/Spark/Athena/ClickHouse `s3()`; constant memory; crash-safe via a durable cursor file (`_sqd_parquet_state.json`). Leaf column types: `INT64`, `INT32`, `UTF8`, `BYTE_ARRAY`, `BOOLEAN`, `DOUBLE`, `TIMESTAMP`, `DATE`, `JSON` (plus nested `LIST` and `STRUCT`); `DECIMAL` is unsupported (use `UTF8` or a scaled `INT64`). Compression codecs (`settings.compression`): `UNCOMPRESSED`, `SNAPPY` (default), `GZIP`, `BROTLI`. Requires optional peer dep `@dsnp/parquetjs`. `onData` must be a pure function of the batch (recovery re-processes finalized blocks and expects byte-identical rows).

## Cursor Keying — Upgrading to alpha.15

Since alpha.15, targets key their sync cursor by the pipe's source `id` (previously a static `"stream"` key in ClickHouse). Applies to ClickHouse, BigQuery, Postgres, and Parquet.

- **Fresh projects:** nothing to do — each pipe's progress is isolated by its `id`.
- **Upgrading one pipe per database:** the legacy ClickHouse cursor migrates to the pipe's `id` automatically on first resume.
- **Upgrading multiple pipes that shared one offset table:** only one of them owned the surviving legacy cursor — pin an explicit cursor key per pipe via `clickhouseTarget({ settings: { id: '...' } })` **before** upgrading such setups.
- The pipe `id` passed to `*PortalStream({ id })` is therefore load-bearing: renaming it orphans the old cursor and the pipe re-syncs from its range start.

## Stream Options: Response Cache, Metrics, Tracing

These wire in as top-level options on the `*PortalStream({ ... })` call.

### Portal response cache (`cache`)

On-disk SQLite + zstd cache of Portal responses, keyed by query hash + block range. Speeds up re-runs and backfills over the same range. Needs `better-sqlite3` (optional peer dep).

```typescript
import { portalSqliteCache } from '@subsquid/pipes/portal-cache/node'

evmPortalStream({
  id: 'erc20',
  portal: 'https://portal.sqd.dev/datasets/ethereum-mainnet',
  cache: portalSqliteCache({ path: './.portal-cache.sqlite' }), // { path, compress? } — compress defaults true (zstd)
  outputs: evmDecoder({ /* ... */ }),
})
```

### Prometheus metrics (`metrics`)

```typescript
import { metricsServer } from '@subsquid/pipes/metrics/node'

evmPortalStream({ /* ... */ metrics: metricsServer() })
```

### OpenTelemetry tracing (`profiler`)

```typescript
import { opentelemetryProfiler } from '@subsquid/pipes/opentelemetry'

evmPortalStream({ /* ... */ profiler: opentelemetryProfiler() })
```

The stream-level `profiler?: boolean | SpanHooks` defaults to **on when `NODE_ENV !== 'production'`**. Pass `opentelemetryProfiler()` to export spans over OTLP (needs `@opentelemetry/sdk-node` + an exporter), or `profiler: false` to disable.
