# SDK 1.0 Features & Testing

Reference for SDK 1.0+ APIs: time-based ranges, `defineAbi`, query builders, typed errors, decode-error hooks, the testing library, Tron/Bitcoin streams, BigQuery/Parquet/Pub/Sub targets, finality, and cursor keying. Examples target `@subsquid/pipes@1.0.0-beta.11`, which was npm `latest` on 2026-11-11; the `beta` tag still pointed to beta.4 on that date. Re-check with `npm view @subsquid/pipes dist-tags --json`.

## Renamed in the Beta Line

The beta line (and alpha.17+) removed the old aliases and renamed several exports. Old names hard-error on current installs; code written against ≤ alpha.16 needs these renames:

| ≤ alpha.16 | Current | Module |
|------------|---------|--------|
| `evmDecoder` | `evmEventDecoder` | `@subsquid/pipes/evm` |
| `evmPortalSource` (alias) | `evmPortalStream` (only name) | `@subsquid/pipes/evm` |
| `solanaPortalSource` (alias) | `solanaPortalStream` (only name) | `@subsquid/pipes/solana` |
| `hyperliquidFillsPortalSource` (alias) | `hyperliquidFillsPortalStream` (only name) | `@subsquid/pipes/hyperliquid` |
| `evmPortalMockStream` | `mockPortal({ blocks })` from `@subsquid/pipes/testing`; the intermediate name `mockEvmPortalStream` still exists but is deprecated | `@subsquid/pipes/testing/evm` |
| `batchForInsert` / `chunk` | `chunkForInsert` | `@subsquid/pipes/targets/drizzle/node-postgres` |
| `factorySqliteDatabase` / `contractFactoryStore` | `contractFactorySqliteStore` | `@subsquid/pipes/evm` |
| `SdkError` (enum) | `SdkErrorName` | `@subsquid/pipes` |
| `factory` | `contractFactory` | `@subsquid/pipes/evm` |
| `createClickhouseTarget` | `clickhouseTarget` | `@subsquid/pipes/targets/clickhouse` |
| `createDefaultLogger` | `defaultLogger` | `@subsquid/pipes` |
| `addLog`, `addTransaction`, `addInstruction`, `addFill`, etc. | `addLogRequest`, `addTransactionRequest`, `addInstructionRequest`, `addFillRequest`, etc. | Every query builder |
| `createFinalizationBuffer` / `finalizationBuffer` | Removed; finalized-only targets declare `requiresFinalizedStream: true` | Target/source contract |

Prefer the `evmQuery()`, `solanaQuery()`, `hyperliquidFillsQuery()`, `tronQuery()`, and `bitcoinQuery()` factories over direct query-builder constructors. A query builder may be passed directly as `outputs`; call `.build()` before chaining `.pipe()` transforms. Source-level `.pipe()` / `.pipeComposite()` was removed: put one chainable output or a named output record inside the source's required `outputs` option.

Other breaking renames to check when upgrading: `RunConfig` → `PipeContext`, `createDevRunner` → `devRunner`, `ResultOf<T>` → `OutputOf<T>`, `BatchCtx` → `BatchContext`, and `PortalClientOptions` duration keys now end in `Ms` (`maxIdleTimeMs`, `maxWaitTimeMs`, `headPollIntervalMs`). Metrics use `sqd_processed_block` / `sqd_end_block`, the preview endpoint is `/preview/transformation`, profiler options use `name` instead of `id`, and Solana decoded instructions expose `event.block.number` instead of top-level `event.blockNumber`.

## Time-Based Ranges

Ranges accept ISO date strings and `Date` objects. Dates are auto-resolved to block numbers via the Portal API.

```typescript
evmEventDecoder({
  range: { from: '2024-01-01' },  // ISO date → block number
  events: { transfers: erc20.events.Transfer },
})

// Date objects
evmEventDecoder({
  range: { from: new Date('2024-01-01'), to: new Date('2024-02-01') },
  events: { ... },
})

// Formatted block numbers (underscores OK)
evmEventDecoder({ range: { from: '18_908_900' }, ... })

// Latest block (only for `from`)
evmEventDecoder({ range: { from: 'latest' }, ... })
```

**Validation:** Inverted ranges (`from > to`) and unresolvable timestamps throw `BlockRangeConfigurationError` (E0002).

## `defineAbi` — Use JSON ABIs Without Codegen

`defineAbi()` converts a standard JSON ABI into decoder objects at runtime — no `squid-evm-typegen` step needed.

```typescript
import erc20Json from './erc20.json'
import { defineAbi } from '@subsquid/pipes'

const erc20 = defineAbi(erc20Json)

evmEventDecoder({
  range: { from: '2024-01-01' },
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
import { tronPortalStream, tronQuery } from '@subsquid/pipes/tron'

const stream = tronPortalStream({
  id: 'tron-usdt-transfers',
  portal: 'https://portal.sqd.dev/datasets/tron-mainnet',
  outputs: tronQuery()
    .addFields({
      block: { number: true, hash: true, timestamp: true },
      transaction: { transactionIndex: true, hash: true, type: true, energyUsageTotal: true, result: true },
      log: { transactionIndex: true, logIndex: true, address: true, topics: true, data: true },
    })
    // USDT transfer(...) calls + the logs they emit
    .addTriggerSmartContractTransactionRequest({
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

Request methods on the Tron query builder: `addTransactionRequest` (by contract `type`), `addTransferTransactionRequest` (native TRX, `owner`/`to`), `addTransferAssetTransactionRequest` (TRC-10, `owner`/`to`/`asset`), `addTriggerSmartContractTransactionRequest` (`owner`/`contract`/`sighash`), `addLogRequest` (`address`/`topic0..3`), `addInternalTransactionRequest` (`caller`/`transferTo`), `includeAllBlocks`.

**Tron gotchas:**
- All hex is **bare** (no `0x`): transaction-level addresses are 21-byte `41…` hex; **log addresses use the 20-byte EVM-style form without `41`**; topics/sighashes plain hex
- `timestamp`/`expiration` are Unix **milliseconds**
- Amounts (`fee`, `feeLimit`, `energy*`, `net*`) arrive as decimal strings, surfaced as `bigint`; TRX values are in SUN (1 TRX = 1e6 SUN)
- Log topics hold 32-byte padded values — Tron address = `'41' + topic.slice(-40)`

## Bitcoin Portal Streams

`@subsquid/pipes/bitcoin` streams `bitcoin-mainnet` with a UTXO-model API.

```typescript
import { bitcoinPortalStream, bitcoinQuery } from '@subsquid/pipes/bitcoin'

const stream = bitcoinPortalStream({
  id: 'bitcoin-utxo',
  portal: 'https://portal.sqd.dev/datasets/bitcoin-mainnet',
  outputs: bitcoinQuery()
    .addFields({
      block: { number: true, hash: true, timestamp: true },
      transaction: { transactionIndex: true, txid: true, size: true },
      input: { transactionIndex: true, inputIndex: true, coinbase: true, txid: true, vout: true,
               prevoutValue: true, prevoutScriptPubKeyType: true, prevoutScriptPubKeyAddress: true },
      output: { transactionIndex: true, outputIndex: true, value: true,
                scriptPubKeyType: true, scriptPubKeyAddress: true, scriptPubKeyAsm: true },
    })
    .addTransactionRequest({
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

Request methods on the Bitcoin query builder: `addTransactionRequest` (`{inputs, outputs}` relation flags), `addInputRequest` (`type`/`prevoutScriptPubKeyAddress`/`prevoutScriptPubKeyType`/`prevoutGenerated` + `transaction`/`transactionInputs`/`transactionOutputs`), `addOutputRequest` (`scriptPubKeyAddress`/`scriptPubKeyType` + relation flags), `includeAllBlocks`.

**Bitcoin gotchas:**
- Values are **BTC floats** (Bitcoin Core convention), not satoshis
- Hex strings are bare (no `0x`)
- `scriptPubKeyType` gives the standard classification (`pubkeyhash`, `scripthash`, `witness_v0_keyhash`, `witness_v1_taproot`, `nulldata`, …) — no manual script parsing needed
- Coinbase inputs have `coinbase` set and no `txid`/`vout`/prevout data

## New EVM Query Fields (alpha.14+)

Added to the EVM field selection:
- **Block:** `uncles`, `withdrawalsRoot`, `withdrawals` (alpha.14+); `blobGasUsed`, `excessBlobGas` (alpha.20+)
- **Transaction:** `logsBloom`, `accessList` (alpha.14+); EIP-4844 blob fields `blobVersionedHashes`, `blobGasUsed`, `blobGasPrice` (alpha.20+, populated on type-3 transactions)

- **Block, Avalanche header fields** (beta.7+, all optional): `extDataHash`, `blockExtraData`, `blockGasCost`, `extDataGasUsed`, `timestampMilliseconds`, `minDelayExcess`, `targetExponent`, `minPriceExponent`, `settledHeight`, `settledGasUnix`, `settledGasNumerator`, `settledExcess`. `timestampMilliseconds`, `settledHeight` and `settledGasUnix` are `number`; the two hashes are hex strings; the rest are `bigint`.

Portal itself serves a few more columns the SDK schema doesn't type yet (`parentBeaconBlockRoot`, `requestsHash` on blocks; `maxFeePerBlobGas` on transactions). Column availability varies by dataset — `ethereum-mainnet` and `polygon-mainnet` were reindexed from genesis with the full set. alpha.20 also made the decoder tolerant of chains without post-London/post-Cancun fields.

**Transaction `effectiveGasPrice` and `type` are optional** (beta.8+): typed `effectiveGasPrice?: bigint` and `type?: number`. Some datasets return null for them on old blocks (Mantle up to block 29,459), so handle `undefined` even when the field is selected. `blobGasUsed` and `blobGasPrice` arrive as hex or decimal strings depending on the dataset and decode to `bigint` either way. Source: `src/portal-client/query/evm.ts`.

## Typed Error System

Framework errors carry unique codes linking to docs (`https://docs.sqd.dev/en/sdk/pipes-sdk/errors/{code}`).

| Error | Code | When |
|-------|------|------|
| `DefaultPipeIdError` | E0001 | `.pipeTo()` called without `id` on source |
| `BlockRangeConfigurationError` | E0002 | Inverted range, invalid date with `'latest'`, unresolvable timestamp |
| `InstructionDecoderConfigurationError` | E0003 | Solana decoder built with an instruction that is not one of `program.instructions`, a `program` without an address, or an unusable discriminator set (missing, duplicated, or mixed-width discriminators) |
| `EventDecoderConfigurationError` | E0004 | Two entries of one `evmEventDecoder` can match the same log |
| `PortalBlockOrderError` | E1006 | The portal delivered a block out of order, twice, or outside the requested range |

Source and pipe configuration errors are E0xxx. E1xxx covers fork handling and the portal contract. Targets own E2xxx: ClickHouse E20xx, Postgres E21xx, BigQuery E22xx, Parquet E23xx, Pub/Sub E24xx. The full list is `docs/errors.md` in the SDK repository; cause and fix for the start-time errors are in [TROUBLESHOOTING.md](TROUBLESHOOTING.md#error-pattern-12-coded-sdk-errors).

## Decode-Error Hook (`onError`)

A decode failure is **fatal by default** — one undecodable record kills the pipe. `evmEventDecoder` and `solanaInstructionDecoder` accept an `onError` hook; if the hook returns without throwing, the offending record is **suppressed** and counted in the `sqd_decode_errors_skipped_total` Prometheus metric (labeled by pipe `id`), so dropped records never vanish silently.

```typescript
evmEventDecoder({
  range: { from: 21_000_000 },
  events: { swaps: pendle.events.SwapYtAndToken },
  onError: (ctx, error) => {
    // Old event layout the current ABI can't decode — skip the record, keep the pipe alive
    ctx.logger.warn({ error }, 'skipping undecodable event')
  },
})
```

Use it for known-bad historical records (e.g. an event whose data layout changed between protocol versions). Don't blanket-suppress: a hook that swallows everything hides real ABI mistakes — the metric only tells you *how many* records were dropped, not *why*.

## Testing with `@subsquid/pipes/testing/evm`

Test pipe logic end-to-end without hitting a real portal. Requires `vitest` and `viem` as dev dependencies.

The library provides:
- **`mockPortal`** (from `@subsquid/pipes/testing`): spin up a mock portal HTTP server that holds a chain and answers each query from it
- **`readAll`** (from `@subsquid/pipes/testing`): drain a stream into a flat array of data items
- **`encodeEvent`** — encode events with full type inference from viem ABIs
- **`mockBlock`** — build mock blocks with auto-generated metadata
- **`resetMockBlockCounter`** — reset block numbering between tests

### Basic test setup

```typescript
import { commonAbis, evmEventDecoder, evmPortalStream } from '@subsquid/pipes/evm'
import { type MockPortal, mockPortal, readAll } from '@subsquid/pipes/testing'
import { encodeEvent, mockBlock, resetMockBlockCounter } from '@subsquid/pipes/testing/evm'

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

  portal = await mockPortal({
    blocks: [mockBlock({ transactions: [{ logs: [transfer] }] })],
  })

  const stream = evmPortalStream({
    id: 'test',
    portal: portal.url,
    outputs: evmEventDecoder({
      range: { from: 0, to: 1 },
      events: { transfers: commonAbis.erc20.events.Transfer },
    }).pipe((batch) => batch.transfers),
  })

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

  portal = await mockPortal({
    blocks: [mockBlock({ transactions: [{ logs: [transfer] }] })],
  })

  const stream = evmPortalStream({
    id: 'test',
    portal: portal.url,
    outputs: evmEventDecoder({
      range: { from: 0, to: 1 },
      events: { transfers: commonAbis.erc20.events.Transfer },
    })
      .pipe((batch) => batch.transfers)
      .pipe((transfers) =>
        transfers.map((t) => ({
          from: t.event.from,
          to: t.event.to,
          amount: Number(t.event.value) / 1e6,
        })),
      ),
  })

  const results = await readAll(stream)
  expect(results[0]).toEqual({ from: ALICE, to: BOB, amount: 2 })
})
```

### Key testing patterns

- `encodeEvent` accepts `abi`, `eventName`, `address`, and typed `args`
- `mockBlock` auto-generates `number`, `hash`, `timestamp` — call `resetMockBlockCounter()` in `beforeEach`
- `mockPortal({ blocks })` resolves to `{ url, close() }` plus the chain controls below. Pass `portal.url` to `evmPortalStream`
- The mock answers like the real portal: it filters EVM logs, transactions, traces and state diffs by the query, serves both `/stream` and `/finalized-stream`, answers 204 at the head and 409 for a parent hash that is not on its chain. A block number you did not pass exists as an empty block up to the head
- Options beside `blocks`: `latest` (defaults to the highest block given), `finalized` (defaults to `latest`; `null` makes the dataset report none), `blocksPerResponse`, `previousBlocks`, `maxAddresses`, `kind`, `delay`
- Drive the chain during a test with `portal.append(...blocks)`, `portal.fork(at, branch?)`, `portal.setHead({ latest?, finalized? })` and `portal.fail({ status, times?, retryAfter? })` or `portal.fail({ stallAfter, times? })`; `portal.requests` records what the pipe asked for. Declare the variable as `MockChainPortal` (or let it infer) to reach these
- `mockPortal(responses)`, the list form, replays an exact response sequence and resolves to plain `{ url, close() }`. Use it only when a test needs that exact sequence
- `mockEvmPortalStream` from `@subsquid/pipes/testing/evm` and `finalizedMockPortal` still exist but are deprecated (beta.9). `mockEvmPortalStream` sends every block in one response whatever the query asks for, so a test built on it cannot catch a wrong filter
- Chain `.pipe()` on the decoder/query output inside `outputs` to test transformations
- Multiple event types: pass multiple in `events: { transfers: ..., approvals: ... }` and access `batch.transfers`, `batch.approvals`
- Bitcoin currently exposes `mockBitcoinRpc` at `@subsquid/pipes/testing/bitcoin`; it records JSON-RPC calls and lets tests return controlled bitcoind results. It does not provide EVM-style mock blocks or a mock Portal stream.

## Decoded Event Field Access in `.pipe()`

When using `evmEventDecoder` with a manual `.pipe()` transform, each decoded event `d` has:

| Field | Type | Description |
|-------|------|-------------|
| `d.event.*` | object | Decoded event parameters (e.g., `d.event.vault`) |
| `d.block.number` | number | Block number |
| `d.rawEvent.transactionHash` | string | Transaction hash |
| `d.rawEvent.logIndex` | number | Log index within the block |
| `d.timestamp` | Date | Block timestamp as JS Date |
| `d.contract` | string | Emitter contract address |
| `d.factory` | object/null | Factory metadata (if using factory pattern) |

**Common mistake:** Using `d.blockNumber` or `d.txHash` (which don't exist). These silently return `undefined`, stored as `0` or `""` in ClickHouse.

**DateTime64(3) gotcha:** For `DateTime64(3, 'UTC')` columns, pass ISO strings via `d.timestamp.toISOString()` with `date_time_input_format: 'best_effort'`. Passing epoch seconds (e.g., `1700392127`) is misinterpreted as `1970-01-20`.

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

Available targets: ClickHouse, PostgreSQL (Drizzle), BigQuery, Parquet, and Google Pub/Sub. (A `memory` target exists in source but is **not** exported from the package; still true in `1.0.0-beta.11`. There is no `./targets/memory` export, so `createMemoryTarget` is internal/testing-only and cannot be imported by consumers.)

### ClickHouse

```typescript
import { clickhouseTarget } from '@subsquid/pipes/targets/clickhouse'

stream.pipeTo(clickhouseTarget({
  client: createClient({ url: process.env.CLICKHOUSE_URL }),
  onData: async ({ store, data, ctx }) => {
    await store.insert({ table: 'transfers', values: data.transfers, format: 'JSONEachRow' })
  },
  onRollback: async ({ reason, store, safeCursor }) => {
    // reason: 'recovery' (every restart with a saved cursor) | 'fork' (chain reorg)
    await store.removeRowsAfter(safeCursor, { tables: 'transfers' })
  },
}))
```

**`store.removeRowsAfter(cursor, { tables, where?, params?, column? })` (beta.10+)** writes the block condition itself: it removes rows above `safeCursor.number` and stops at `safeCursor.upTo` when the target sets it, so the hook cannot remove rows outside the block range this pipe wrote. The target sets `upTo` on a fork (the cursor the fork rolls back from) and after a run that stopped inside its first batch (that batch's last block). `tables` takes one name or an array, and `column` defaults to `block_number`. Pass `where` and `params` only for a table several pipes write, to pick this pipe's rows.

The target saves a start cursor before the first batch's data, so the hook also runs with `reason: 'recovery'` after a crash inside the first batch. There `safeCursor.number` is one block below the range start (`-1` for a range that starts at 0). `store.removeAllRows({ tables, where, params })` is deprecated for this reason: a hook written as `where: 'block_number > {latest:UInt32}'` then removes every row above the range start in the listed tables, including rows another pipe wrote to a shared table. Replace it when you see it in older code. Without an `onRollback` hook the target warns at startup and refuses a fork on the hot stream with E2007.

**Rollbacks and materialized views (alpha.16):** `store.removeRowsAfter` removes rows by inserting **cancel rows** (`sign = -1`) when the table is a `CollapsingMergeTree`/`VersionedCollapsingMergeTree` (or Replicated variant) with a `sign` column — the only delete mechanism that propagates through materialized views. Write MVs rollback-aware: aggregate with the sign (`sum(value * sign)`, `sum(sign)` for counts). On any other engine it falls back to a lightweight `DELETE` with a warning — the table is cleaned but MVs built on it keep the removed rows. Irreversible aggregates (`min`, `max`, `uniq`, `argMax`) cannot be rolled back by any mechanism — recompute the affected tail after a fork. A `minmax` skip index on `block_number` is auto-created on first rollback; call `store.ensureRollbackIndex({ table })` in `onStart` to set it up eagerly.

### PostgreSQL with Drizzle

```typescript
import { chunkForInsert, drizzleTarget } from '@subsquid/pipes/targets/drizzle/node-postgres'

stream.pipeTo(drizzleTarget({
  db: drizzle(pool),
  tables: [transfersTable],
  // ONE destructured object; insert via `tx`, NOT `ctx.db`
  onData: async ({ tx, data, ctx }) => {
    for (const rows of chunkForInsert(data.transfers)) {
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

**Insert via `tx`, not `ctx.db`.** Each `onData` batch runs inside the target's snapshot/rollback transaction, and `tx` is that transaction handle. Writing through `ctx.db` bypasses it, so the rows escape the rollback snapshot and a reorg can't undo them. The callback takes **one** destructured object `{ tx, data, ctx }` — not two positional args. Use `chunkForInsert` (named `batchForInsert`/`chunk` before the beta line), exported from `@subsquid/pipes/targets/drizzle/node-postgres`, to split large batches under Postgres's 32767-parameter limit.

Beta.3 fixed Drizzle snapshot triggers and rollback to use real database column names rather than TypeScript property names.

### BigQuery

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

Key facts: tables auto-create with `PARTITION BY RANGE_BUCKET(block_number, …)` (partition column forced `INT64 NOT NULL`); declared schema is enforced against existing tables (fails fast on mismatch); reorgs run bounded `DELETE`s per tracked table, resumed idempotently after crashes. An optional `onBeforeRollback: async ({ cursor }) => ...` fires after the safe cursor resolves, before the per-table `DELETE`s. Gotchas: `TIMESTAMP` wire format is INT64 **microseconds** (`date.getTime() * 1000`; a JS `Date` also works, a raw milliseconds number lands in 1970 — see [BIGQUERY_TARGET.md](BIGQUERY_TARGET.md#the-timestamp-microseconds-rule)); uint256 overflows BIGNUMERIC (max ≈ 5.79e38) — clamp and keep the exact decimal in a STRING column.

Deep reference — the full `bigqueryTarget` option set, GCP prerequisites, the `sync` WAL table, fork and crash recovery, the `E2201`–`E2213` codes, and query-cost rules: [BIGQUERY_TARGET.md](BIGQUERY_TARGET.md).

### Google Pub/Sub (beta.2+)

```typescript
import { PubSub } from '@google-cloud/pubsub'
import { pubsubTarget } from '@subsquid/pipes/targets/pubsub'

stream.pipeTo(pubsubTarget({
  pubsub: new PubSub({ projectId: process.env.GOOGLE_CLOUD_PROJECT }),
  state: { path: './state/transfers.sqlite' }, // cursor, rollback manifest, outbox, sequence
  namespace: 'base-erc20',
  allowColdStart: true, // first run only; remove once the namespace has published
  topics: {
    transfers: {
      topic: 'evm.base.erc20-transfers',
      map: ({ data }) => data.map((t) => ({
        data: {
          _id: `${t.block.hash}:${t.rawEvent.logIndex}`,
          token: t.rawEvent.address,
          from: t.event.from,
          to: t.event.to,
          amount: t.event.value,
          block: t.block.number,
          timestamp: t.timestamp,
        },
        block: t.block,
        attributes: { token: t.rawEvent.address },
      })),
    },
  },
}))
```

`topics` routes emit BigQuery CDC-compatible JSON rows with `_id`, `_CHANGE_TYPE`, and `_CHANGE_SEQUENCE_NUMBER`; fork repair emits a later `DELETE` or restoring `UPSERT`. `bigint` encodes as a decimal string and `Date` as RFC 3339, so choose destination column types accordingly. The SQLite state file is load-bearing: keep it on durable storage and run one producer per path. Losing its sequence counter can cause BigQuery to ignore lower replacement sequence numbers.

Options that decide whether the pipe starts and what it publishes (`src/targets/pubsub/pubsub-target.ts` at beta.11):

- **`allowColdStart`** (default `false`): a run that finds empty state is refused with E2420, because restarting the sequence under a namespace that already published makes rows freeze downstream. Set `true` to bootstrap a namespace that has never published, then remove it.
- **`publishFrom`** (default `'latest'`): resolved to the current head on first start and persisted. The pipe may read earlier blocks for warm-up, but nothing below this block is published. Pass a block number to publish history.
- **`sequenceBarrier`** (default `true`): keeps `_CHANGE_SEQUENCE_NUMBER` gap-free, which limits the producer to one topic (E2428) and in practice one route (E2429 on a batch spanning several blocks). Merge streams into one route's `map`, or set `false` when no consumer relies on a contiguous sequence.
- **`mode`** on a route: `'event'` (default, ids are write-once) or `'materialized'` (ids may be revised; `windowTopic` builds such a route).
- **`assumeNoForks`**, **`topicSetup`** (`'validate'` default, `'create'`, `'none'`), **`attributes`**, **`publish.*`** and **`settings.id`**: see the published `pubsubTarget` reference.

Every route is a CDC row route; there is no `signals` option. Pub/Sub delivery is at-least-once. Needs the optional peers `@google-cloud/pubsub` and `better-sqlite3`.

**State upgrades.** The state file is schema 4. A schema 3 file written by `1.0.0-beta.4` migrates in place on first open and keeps its change sequence. It is refused with E2411 only while its outbox still holds signal operations: let beta.4 drain the outbox, then upgrade. A state file from any other version needs the SDK version that wrote it, or fresh state under a fresh namespace and a consumer re-bootstrap. From beta.11 finalized rows are deleted later, 1,000 rows per transaction between batches, so a batch no longer stalls when finality advances. A failed state write (full, missing or read-only volume) stops the pipe with E2426; see [TROUBLESHOOTING.md](TROUBLESHOOTING.md#error-pattern-12-coded-sdk-errors).

### Parquet

```typescript
import { parquetTarget, parquetjsEngine } from '@subsquid/pipes/targets/parquet'

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
  settings: {
    rollover: { maxBytes: 128 * 1024 * 1024 },
    engine: parquetjsEngine({ compression: 'SNAPPY' }),
  },
  onData: ({ store, data }) => { store.insert('transfers', data.transfers.map(t => ({ /* row */ }))) },
}))
```

Key facts: writes **finalized-only** rotating files (`<min>-<max>.parquet`) readable directly by DuckDB/Spark/Athena/ClickHouse `s3()`; constant memory; crash-safe via a durable cursor file (`_sqd_parquet_state.<pipe-id>.json`). One `dir` belongs to one pipe: a directory that already holds another pipe's state file is refused at startup with E2321 (beta.9+), and `settings.id` only names the state file. Leaf column types: `INT64`, `INT32`, `UTF8`, `BYTE_ARRAY`, `BOOLEAN`, `DOUBLE`, `TIMESTAMP`, `DATE`, `JSON` (plus nested `LIST` and `STRUCT`); `DECIMAL` is unsupported (use `UTF8` or a scaled `INT64`). Configure `UNCOMPRESSED`, `SNAPPY` (default), `GZIP`, or `BROTLI` through `parquetjsEngine({ compression })` or per-column compression, not as a top-level target setting. Requires optional peer dep `@dsnp/parquetjs`. `onData` must be a pure function of the batch (recovery re-processes finalized blocks and expects byte-identical rows).

### Finalized-only target semantics (beta.2+)

Parquet and other finalized-only targets now declare `requiresFinalizedStream: true`; the source reads `/finalized-stream` directly instead of buffering hot blocks. A bounded range whose `to` is above the finalized head waits until those blocks finalize. On a dataset that never advances finality, that range does not complete, so CI/cron backfills should end at or below the finalized head. Custom finalized-only targets should set the same flag and write rows as they arrive; `createFinalizationBuffer`, `finalizationBuffer`, and the `Finalization` state type are removed.

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
  outputs: evmEventDecoder({ /* ... */ }),
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
