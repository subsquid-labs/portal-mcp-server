# EVM migration steps

The EVM branch of `../SKILL.md`: an `@subsquid/evm-processor` squid becomes an `@subsquid/evm-stream` data source driven by `run()` from `@subsquid/batch-processor`. Do the steps in order, then return to `SKILL.md` for hot blocks, verification and the re-sync. A full before/after of one file is in `evm-example-diff.md`; compiler and runtime errors are in `common-errors.md`.

## Step 1 — Swap packages

```bash
npm uninstall @subsquid/evm-processor @subsquid/archive-registry
npm i @subsquid/evm-stream @subsquid/evm-objects @subsquid/batch-processor @subsquid/logger
```

If the handler makes direct RPC calls (contract state, Multicall):

```bash
npm i @subsquid/rpc-client
```

`@subsquid/util-internal` and `@subsquid/util-internal-hex` get pulled in transitively — no explicit install needed; retarget imports per Step 2.

## Step 2 — Imports

```ts
// before
import {
  BlockHeader,
  DataHandlerContext,
  EvmBatchProcessor,
  EvmBatchProcessorFields,
  Log as _Log,
  Transaction as _Transaction,
  BlockData as _BlockData,
  FieldSelection,
  decodeHex,
  assertNotNull,
} from '@subsquid/evm-processor'
import {lookupArchive} from '@subsquid/archive-registry'  // older squids

// after
import * as evmObjects from '@subsquid/evm-objects'
import {DataSourceBuilder, FieldSelection} from '@subsquid/evm-stream'
import type {DataHandlerContext as BaseDataHandlerContext} from '@subsquid/batch-processor'
import type {Logger} from '@subsquid/logger'
import {decodeHex} from '@subsquid/util-internal-hex'   // if used
import {assertNotNull} from '@subsquid/util-internal'   // if used
// The archive registry lookup is gone: use the Portal URL directly.
```

Mapping:

| Old import | New location |
|---|---|
| `EvmBatchProcessor` | gone — replaced by `DataSourceBuilder` from `@subsquid/evm-stream` |
| `EvmBatchProcessorFields<typeof processor>` | gone — derive `Fields` from a literal `fields` object via `typeof fields` |
| `FieldSelection` | `@subsquid/evm-stream` |
| `BlockHeader`, `Log`, `Transaction`, `Trace`, `StateDiff` | `@subsquid/evm-objects` |
| `BlockData` | `@subsquid/evm-objects` — **renamed to `Block`** (see Step 3) |
| `DataHandlerContext` | `@subsquid/batch-processor` (base; augment manually) |
| `decodeHex` | `@subsquid/util-internal-hex` |
| `assertNotNull` | `@subsquid/util-internal` |
| `lookupArchive` | gone — use Portal URL directly |

## Step 3 — Type aliases

**a) Hoist `setFields(...)` into a literal — `EvmBatchProcessorFields<typeof processor>` is gone.**

```ts
export const fields = {
  block: { timestamp: true },
  log: {
    address: true,
    topics: true,
    data: true,
    transactionHash: true,
  },
} satisfies FieldSelection

export const dataSource = new DataSourceBuilder()
  // ...
  .setFields(fields)
  // ...
  .build()

export type Fields = typeof fields
```

The `satisfies FieldSelection` keeps the precise shape of `fields` instead of widening it to `FieldSelection`. Without it, `evmObjects.Log<Fields>` (Step 3c) degrades to "all fields".

**b) `Block` ↔ `BlockData` swap.**

- Old: `Block = BlockHeader<F>` (header only); `BlockData = BlockData<F>` (full payload).
- New: `BlockHeader<F>` = header only; `Block<F>` = full payload. The "Data" suffix is gone.

```ts
// before
export type Block = BlockHeader<Fields>
export type BlockData = _BlockData<Fields>

// after
export type Block = evmObjects.BlockHeader<Fields>     // header only
export type BlockData = evmObjects.Block<Fields>       // full payload
```

Code that expected header-only via `Block` will now type-check against the full payload at compile time and behave differently at runtime. Rename callsites accordingly.

**c) `DataHandlerContext` generic argument order is flipped, and the base no longer carries `log` or `_chain`.**

- Old: `DataHandlerContext<Store, Fields>`. Exposes `log` and `_chain` by default.
- New: `DataHandlerContext<BlockData, Store>` (block payload first, store second). Bare `{store, blocks, isHead}`; you re-attach `log` (Step 5) and `_chain` (Step 6) manually.

```ts
// after, no RPC
export type Context<Store> = BaseDataHandlerContext<BlockData, Store> & {
  log: Logger
}

// after, with RPC
import type {RpcClient} from '@subsquid/rpc-client'
export type Context<Store> = BaseDataHandlerContext<BlockData, Store> & {
  log: Logger
  _chain: { client: RpcClient }
}
```

`Store` is the user's store generic — typically `Store` re-exported from `@subsquid/typeorm-store` (`import {Store, TypeormDatabase} from '@subsquid/typeorm-store'`). At the call site you'd write `Context<Store>`.

## Step 4 — Rewrite the data source

```ts
// after
const dataSource = new DataSourceBuilder()
  .setPortal({
    url: 'https://portal.sqd.dev/datasets/ethereum-mainnet',
    http: { retryAttempts: Infinity },
  })
  .setBlockRange({ from: 6_082_465 })
  .setFields(fields)
  .addLog({
    where: { address: [CONTRACT], topic0: [TOPIC] },
    include: { transaction: true },
    range: { from: 6_082_465 },
  })
  .build()
```

Full before/after for both starting shapes (recent `setGateway`/`setRpcEndpoint`/`setFinalityConfirmation` and the older `lookupArchive` + `setDataSource({archive, chain})`) is in `evm-example-diff.md`.

Structural changes:

1. **`setRpcEndpoint` / `setFinalityConfirmation` / `setDataSource` are gone.** Portal handles real-time delivery and finality. All three v2 shapes (`setGateway`/`setDataSource`) collapse to a single `.setPortal(...)` call. Both forms are valid: bare URL (`.setPortal('https://portal.sqd.dev/datasets/<slug>')`, matching the upstream EVM doc) or object form (`.setPortal({ url, http: { retryAttempts: Infinity } })`). Use the object form in production: `retryAttempts: Infinity` keeps the indexer waiting through a Portal outage. The default budget is 20 retries, about five minutes, from `@subsquid/evm-stream` 0.1.4 on; earlier releases gave up after about 33 seconds whatever was configured, so upgrade them.
2. **`.addLog()` / `.addTransaction()` / `.addTrace()` / `.addStateDiff()` arguments are split into three keys.** Filters under `where`, related items under `include`, block range under `range`. The flat shape (`{ address, topic0, transaction: true, range }`) is rejected by the new type.
3. **`.setFields({ evmLog: ... })` → `.setFields({ log: ... })`.** The selector key for log fields was renamed.
4. **`.build()` must be called** at the end of the chain. Without it, calls like `getBlockStream` are not on the builder type.

Block-selector restriction: `.setFields({ block: { ... } })` only accepts the mutable header fields (`timestamp`, `nonce`, `miner`, `extraData`, etc.). `number`, `hash`, and `parentHash` are always present on the block header — requesting them in the selector is a TS error.

## Step 5 — Wire up `run()` and `augmentBlock`

```ts
import {run} from '@subsquid/batch-processor'
import {augmentBlock} from '@subsquid/evm-objects'
import {createLogger} from '@subsquid/logger'

const logger = createLogger('sqd:processor:mapping')

run(dataSource, db, async (simpleCtx) => {
  const ctx: Context<Store> = {
    ...simpleCtx,
    blocks: simpleCtx.blocks.map(augmentBlock),
    log: logger,
    // _chain: { client: rpcClient }  // see Step 6
  }
  // rest of handler unchanged
})
```

The old `processor.run(db, handler)` becomes a free `run(dataSource, db, handler)`. Two things now happen inside the handler that used to be automatic:

1. `augmentBlock()` each block. Raw blocks from the stream are flat objects; `augmentBlock` adds the convenience back-references (`log.transaction`, `log.block`, `block.logs[*].id`, etc.).
2. Attach the logger manually. The new base context doesn't carry `log`.

Block-shortcut renames (the old top-level `block.X` shortcuts are gone; the values now live under `block.header`):

- `block.height` → `block.header.number` (`.height` is also present on the new `BlockHeader` but marked `@deprecated`; prefer `.number`)
- `block.timestamp` → `block.header.timestamp`
- `log.block.height` → `log.block.number` (after `augmentBlock`)

**`processor.setPrometheusPort()` / `processor.setPrometheusServer()`** are gone with `EvmBatchProcessor`. Move them onto a `PrometheusServer` instance and hand it to `run()` via the `prometheus` option (the runner still attaches the built-in `sqd_processor_*` metrics and calls `.serve()` itself):

```diff
-processor.setPrometheusPort(3000)
-processor.setPrometheusServer(myServer)
-processor.run(db, async (ctx) => { /* ... */ })
+import {run, PrometheusServer} from '@subsquid/batch-processor'
+
+const prometheus = new PrometheusServer()
+prometheus.setPort(3000)
+// prometheus.addMetricsSink({ register(registry) { /* custom prom-client metrics */ } })
+
+run(dataSource, db, async (simpleCtx) => { /* ... */ }, {prometheus})
```

`prometheus.setPort()` takes precedence over `PROCESSOR_PROMETHEUS_PORT` / `PROMETHEUS_PORT` (which still work as the default if `setPort` is skipped). For custom metrics, declare them with `prom-client` and register on the server's private registry via `addMetricsSink()` so they share the `/metrics` endpoint with `sqd_processor_*` — see [`squid-evm-rt-template`](https://github.com/subsquid-labs/squid-evm-rt-template) for a worked example.

## Step 6 — (Optional) RPC client for direct chain reads

Skip if the handler doesn't make direct RPC calls (no `new abi.Contract(ctx, header, address)`, no `ctx._chain.client.call(...)`).

```ts
import {RpcClient} from '@subsquid/rpc-client'

const rpcClient = new RpcClient({
  url: process.env.RPC_URL!,
  rateLimit: 100,
})

run(dataSource, db, async (simpleCtx) => {
  const ctx: Context<Store> = {
    ...simpleCtx,
    blocks: simpleCtx.blocks.map(augmentBlock),
    log: logger,
    _chain: { client: rpcClient },
  }
  // Contract reads via new abi.Contract(ctx, header, address) work unchanged.
})
```

## Step 7 — Field selection

The new stream fetches **only** the fields listed in `.setFields()`. The v2 processor merged a default set (`log.address`, `log.topics`, `log.data`, `block.timestamp`, `transaction.from/to/hash`) into the user's selection — the new stream does not, and TypeScript enforces it.

Typical minimum for a log-indexing squid:

```ts
const fields = {
  block: { timestamp: true },
  log: {
    address: true,
    topics: true,
    data: true,
    transactionHash: true,
  },
  transaction: {       // only if include: { transaction: true }
    from: true,
    to: true,
    hash: true,
    value: true,
  },
} satisfies FieldSelection
```

If the handler reaches into a field not listed, TS rejects the access.
