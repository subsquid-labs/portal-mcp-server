---
name: migrate-to-portal
description: Migrate an existing Squid SDK indexer (EVM or Solana) off the v2 gateway and onto the Portal data source. Covers the package swap (`@subsquid/evm-processor` → `@subsquid/evm-stream` + `@subsquid/evm-objects` + `@subsquid/batch-processor` for EVM; `@subsquid/solana-stream@^0.x` → `^1.x` for Solana), the API/type shape changes, and field-selection changes. Use when the user mentions migrating, porting, upgrading, or converting a v2 squid to Portal; references `v2.archive.subsquid.io`, `setGateway`, `setDataSource`, `lookupArchive`, or `SolanaRpcClient`; or hits TS errors on `EvmBatchProcessor`, `evmLog`, or `block.header.slot` after a `@subsquid/*` bump.
metadata:
  author: subsquid
  version: "1.2.1"
  category: documentation
---

# Migrate a Squid to Portal

Walks the migration of an existing Squid SDK indexer onto the Portal data source. EVM and Solana have different package sets; the migration shape (data source + types + field selection) is parallel. Upstream doc (unified, both chains): <https://docs.sqd.dev/en/sdk/migration/gateway-to-portal>.

> **The v2 gateways are actively being sunset.** On 2026-08-05, 18 datasets (including `astar-mainnet`, `berachain-mainnet`, `celo-mainnet`, `linea-mainnet`, `scroll-mainnet`, `taiko-mainnet`, `unichain-mainnet`, `zksync-mainnet`, `zora-mainnet`) became **Portal-only**. A v2 squid on those chains is already broken and must migrate. On **2026-08-20**, 67 low-usage datasets retired from both v2 and Portal ([announcement](https://docs.sqd.dev/announcements/dataset-retirements-august-2026)); there is no Portal migration target for them, so move to RPC or a private Portal instead. The [July 30, 2026 Squid SDK release](https://github.com/subsquid/squid-sdk/releases/tag/2026-07-30) also introduced the `@subsquid/squid-sdk` umbrella package with an automatic Portal/RPC failover data source. Consider it for new work, though this guide's `@subsquid/evm-stream` target remains current.

## When to use this skill

Activate when the user says any of:

- "migrate my squid to Portal" (EVM or Solana)
- "move off v2 archive / `setGateway` / `setDataSource` / `lookupArchive`"
- "upgrade `@subsquid/evm-processor`" or "`@subsquid/solana-stream` to `1.x`"
- references `https://v2.archive.subsquid.io/...`
- mentions removing `SolanaRpcClient`
- asks about Solana block-height-to-slot conversion
- hits compile errors on `EvmBatchProcessor`, `evmLog`, `block.height`, or `block.header.slot` after a bump
- needs to migrate `processor.setPrometheusPort()` / `processor.setPrometheusServer()` (EVM only — removed with `EvmBatchProcessor`)

## Pre-flight

1. **Identify the chain.** Grep:
   ```bash
   grep -RE "@subsquid/(evm-processor|solana-stream|archive-registry)" --include="*.ts" --include="*.json" .
   ```
   - `@subsquid/evm-processor` → EVM section below
   - `@subsquid/solana-stream@^0.x` → Solana section below

2. **Verify that the dataset is active, then verify its Portal slug.** First check the [August 2026 retirement list](https://docs.sqd.dev/announcements/dataset-retirements-august-2026). Any listed dataset stopped ingesting on August 20 and has no Portal migration target. Then map the old archive URL `https://v2.archive.subsquid.io/network/<slug>` to the Portal URL:
   ```bash
   curl -sI https://portal.sqd.dev/datasets/<slug>/metadata
   ```
   `200 OK` = catalog entry exists. `404` = wrong or removed slug; search at <https://portal.sqd.dev/datasets>. A `200` does not override an announced retirement; always perform the retirement check first.

3. **Inventory direct RPC calls in the batch handler.** If the handler uses `new abi.Contract(ctx, header, address)` or `Multicall(...)` for contract reads, the migration needs the optional RPC-client step.

4. **Determine whether the source squid uses real-time data.** Check for `.setRpcEndpoint()` (EVM) or `.setRpc()` (Solana) alongside `.setGateway()`. A gateway-only squid (no RPC) was processing finalized data only — preserve that mode after the migration by setting `supportHotBlocks: false` on the database (see the EVM Step 7 / Solana Step 4 notes). A squid with both was real-time; default `supportHotBlocks: true`.

5. **Check for prior Portal-beta usage.** If the squid already calls `.setPortal(...)` (from the Portal beta) alongside `.setRpcEndpoint()`, treat the existing `.setPortal` call the same way as a `.setGateway` — remove it and the surrounding processor initialization, then set up the new Portal data source as below.

6. **Commit / branch first.** The migration touches imports, types, and the processor entrypoint.

7. **Node.js 22+** is required.

---

## Add the v2 gateway API key — EVM only (alternative to migrating)

Only use the v2-auth path when the user explicitly wants to remain on an EVM v2 gateway that still exists. For the package versions and how the user adds their key, read [references/v2-auth.md](references/v2-auth.md). On Solana, follow the Portal migration below instead.

---

## EVM migration

### Step 1 — Swap packages

```bash
npm uninstall @subsquid/evm-processor @subsquid/archive-registry
npm i @subsquid/evm-stream @subsquid/evm-objects @subsquid/batch-processor @subsquid/logger
```

If the handler makes direct RPC calls (contract state, Multicall):

```bash
npm i @subsquid/rpc-client
```

`@subsquid/util-internal` and `@subsquid/util-internal-hex` get pulled in transitively — no explicit install needed; retarget imports per Step 2.

### Step 2 — Imports

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
// `lookupArchive` is gone — use the Portal URL directly.
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

### Step 3 — Type aliases

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

### Step 4 — Rewrite the data source

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

Full before/after for both starting shapes (recent `setGateway`/`setRpcEndpoint`/`setFinalityConfirmation` and the older `lookupArchive` + `setDataSource({archive, chain})`) is in `references/evm-example-diff.md`.

Structural changes:

1. **`setRpcEndpoint` / `setFinalityConfirmation` / `setDataSource` are gone.** Portal handles real-time delivery and finality. All three v2 shapes (`setGateway`/`setDataSource`) collapse to a single `.setPortal(...)` call. Both forms are valid: bare URL (`.setPortal('https://portal.sqd.dev/datasets/<slug>')`, matching the upstream EVM doc) or object form (`.setPortal({ url, http: { retryAttempts: Infinity } })`). The object form is recommended for production because it lets you raise `http.retryAttempts` so the indexer doesn't exit on transient non-2xx Portal responses.
2. **`.addLog()` / `.addTransaction()` / `.addTrace()` / `.addStateDiff()` arguments are split into three keys.** Filters under `where`, related items under `include`, block range under `range`. The flat shape (`{ address, topic0, transaction: true, range }`) is rejected by the new type.
3. **`.setFields({ evmLog: ... })` → `.setFields({ log: ... })`.** The selector key for log fields was renamed.
4. **`.build()` must be called** at the end of the chain. Without it, calls like `getBlockStream` are not on the builder type.

Block-selector restriction: `.setFields({ block: { ... } })` only accepts the mutable header fields (`timestamp`, `nonce`, `miner`, `extraData`, etc.). `number`, `hash`, and `parentHash` are always present on the block header — requesting them in the selector is a TS error.

### Step 5 — Wire up `run()` and `augmentBlock`

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

### Step 6 — (Optional) RPC client for direct chain reads

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

### Step 7 — Hot blocks on the store

For a real-time squid (the v2 source had both `.setGateway()` and `.setRpcEndpoint()`):

```ts
const db = new TypeormDatabase({ supportHotBlocks: true })
```
`{supportHotBlocks: true}` here is just to keep things explicit: it is the default. This regime is required for the store to apply forked-block rollbacks once the indexer reaches the chain head. Other store backends accept the same option.

For a **finalized-only** squid (the v2 source had `.setGateway()` only, no `.setRpcEndpoint()` — the regime where the squid processes only finalized data, suitable for forwarding into append-only destinations), preserve that behavior by explicitly setting:

```ts
const db = new TypeormDatabase({ supportHotBlocks: false })
```

A Portal data source streaming into a target with `supportHotBlocks: false` automatically ingests from [`/finalized-stream`](https://docs.sqd.dev/en/api/evm/finalized-stream) instead of [`/stream`](https://docs.sqd.dev/en/api/evm/stream).

### Step 8 — Field selection

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

### Step 9 — Re-sync the squid

After the code compiles and a local run succeeds, re-sync from genesis so the new data path is exercised across the full history (catches bugs early).

If deployed to [SQD Cloud](https://docs.sqd.dev/en/cloud), use the zero-downtime procedure: deploy into a new slot, wait for it to sync, then move the production tag to the new deployment (see [slots and tags](https://docs.sqd.dev/en/cloud/resources/slots-and-tags#zero-downtime-updates)). If you can't afford a re-sync, [re-deploy the squid](https://docs.sqd.dev/en/sdk/squid-sdk/squid-cli/deploy) **without resetting its database** (Cloud) or just restart it with its code updated (self-hosted).

---

## Solana migration

### Step 1 — Code cleanup, then upgrade packages

Before bumping, remove `SolanaRpcClient` references from the source — they will not compile after the bump:

```diff
-import {DataSourceBuilder, SolanaRpcClient} from '@subsquid/solana-stream'
+import {DataSourceBuilder} from '@subsquid/solana-stream'

 const dataSource = new DataSourceBuilder()
   .setGateway('https://v2.archive.subsquid.io/network/solana-mainnet')
-  .setRpc(process.env.SOLANA_NODE == null ? undefined : {
-    client: new SolanaRpcClient({ url: process.env.SOLANA_NODE }),
-    strideConcurrency: 10,
-  })
   // ...
```

Then upgrade:

```bash
npx --yes npm-check-updates --filter "@subsquid/*" --target "@latest" --upgrade
npm install   # or pnpm install / yarn install
```

This bumps `@subsquid/solana-stream` to `^1.x.x`, `@subsquid/solana-objects` to `^1.x.x`, `@subsquid/batch-processor` to `^1.x.x`, and `@subsquid/typeorm-store` to `^1.x.x`.

### Step 2 — Rewrite the data source

```ts
// before
const dataSource = new DataSourceBuilder()
  .setGateway('https://v2.archive.subsquid.io/network/solana-mainnet')
  .setBlockRange({ from: 289_819_150 })   // BLOCK HEIGHT
  // ... .setFields(...), .addInstruction(...)
  .build()

// after
const dataSource = new DataSourceBuilder()
  .setPortal({
    url: 'https://portal.sqd.dev/datasets/solana-mainnet',
    http: { retryAttempts: Infinity },
  })
  .setBlockRange({ from: 317_617_480 })   // SLOT NUMBER
  // ... .setFields(...), .addInstruction(...)
  .build()
```

Structural changes:

1. Replace `.setGateway(...)` (and `.setRpc({...})` if present) with `.setPortal({ url, http })`. `http: { retryAttempts: Infinity }` is recommended for production — without it the indexer exits on transient non-2xx Portal responses.
2. Convert the block-range `from` from a block height to a slot number. Solana exposes both; the v2 archive used heights, Portal uses slots. Use the interactive bisection converter embedded at <https://docs.sqd.dev/en/sdk/migration/height-to-slot> (binary-searches the public Portal).

Selectors inside `.addInstruction({ where, include })` and field selection in `.setFields({...})` keep the same shape.

### Step 3 — Block-header rename in the handler

`block.header.slot` → `block.header.number`. The Portal `BlockHeader` only exposes `.number`, which on Solana represents the slot.

```diff
 let exchange = new Exchange({
   id: ins.id,
-  slot: block.header.slot,
+  slot: block.header.number,
   // ...
 })
```

Same for `transaction.block.slot` / `instruction.block.slot` if those were traversed.

### Step 4 — Hot blocks on the store

For a real-time squid (the v2 source had both `.setGateway()` and `.setRpc()`) use
```ts
const database = new TypeormDatabase()
```
or
```ts
const database = new TypeormDatabase({ supportHotBlocks: true })
```
- these are equivalent. Hot blocks support is required to apply Portal's hot-block updates once the indexer reaches the chain head.

For a **finalized-only** squid (the v2 source had `.setGateway()` only, no `.setRpc()`), explicitly set:

```ts
const database = new TypeormDatabase({ supportHotBlocks: false })
```

A Portal data source streaming into such a target automatically ingests from `/finalized-stream` instead of `/stream`, preserving the finalized-only regime.

### Step 5 — Field selection

The Portal `solana-stream` (`^1.x.x`) fetches **only** the fields listed in `.setFields()`. There is no default set — beyond a small set of always-required identity/index fields (`block.number`/`.hash`/`.parentHash`, `transaction.transactionIndex`, `instruction.transactionIndex`/`.instructionAddress`, etc.), every field must be requested explicitly. TypeScript enforces this: accessing a field not in your selection is a compile error.

v2 was different — it merged a default set on top of your selection, so a partial `.setFields()` still worked at runtime. The full v2 default table is in `references/common-errors.md` ("Property 'signatures' does not exist..."). The most-missed cases on a real squid: `tokenBalance.preMint` / `postMint` (commonly used to recover which token is involved in a swap), `transaction.signatures`, `block.header.timestamp`.

Typical minimum for a swap-style instruction handler:

```ts
.setFields({
  block: { timestamp: true },
  transaction: {
    signatures: true,
    accountKeys: true,
  },
  instruction: {
    programId: true,
    accounts: true,
    data: true,
  },
  tokenBalance: {
    preAmount: true,
    postAmount: true,
    preOwner: true,
    postOwner: true,
    preMint: true,
    postMint: true,
  },
})
```

`block.header.number` (the slot on Solana) is always available without being requested. Block **height** is not — request via `block: { height: true }` if your handler reads it.

### Step 6 — Re-sync the squid

After the code compiles and a local run succeeds, re-sync from genesis so the new data path is exercised across the full history (catches bugs early).

If deployed to [SQD Cloud](https://docs.sqd.dev/en/cloud), use the zero-downtime procedure: deploy into a new slot, wait for it to sync, then move the production tag to the new deployment (see [slots and tags](https://docs.sqd.dev/en/cloud/resources/slots-and-tags#zero-downtime-updates)).

If you can't afford a re-sync, [re-deploy the squid](https://docs.sqd.dev/en/sdk/squid-sdk/squid-cli/deploy) **without resetting its database** (Cloud) or just restart it (self-hosted). On Solana, if the existing DB stores block heights and the new code expects slots in the status row, see <https://docs.sqd.dev/en/sdk/migration/solana-resync-workaround>.

---

## References

- `references/evm-example-diff.md` — canonical USDC-transfers diff
- `references/solana-example-diff.md` — canonical Whirlpool-swap diff
- `references/common-errors.md` — full table of TS / install / runtime errors with one-line fixes, grouped by chain (and "both chains" for v2-with-`apiKey`)

## Related skills

- **portal** — query the same Portal datasets directly once migrated.
- **squid-perf** — compare sync time between v2 and Portal deployments.
