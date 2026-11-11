# Common errors during the Portal migration

Each entry maps back to a step in `evm-migration.md` or `solana-migration.md`.

---

## Squids still on the v2 gateway

Self-hosted v2 gateway calls have needed an API key since 2026-05-19 12:00 UTC ([announcement](https://docs.sqd.dev/announcements/gateway-api-keys)); SQD Cloud injects the key itself. Migrating to Portal removes the requirement. `v2-auth.md` is the path for an EVM squid that stays on v2 for now. The Solana v2 gateway has kept only the last 30 days of data since 2026-06-01 and is scheduled for removal, so a Solana squid that hits these errors migrates.

### `TS2353: 'apiKey' does not exist in type 'GatewaySettings'`

On `.setGateway({ url, apiKey })` in a squid that has not migrated yet, EVM or Solana.

**Cause:** `apiKey` on `GatewaySettings` was added in:

| Chain | Package | First version with `apiKey` |
|---|---|---|
| EVM | `@subsquid/evm-processor` | `1.30.0` |
| Solana | `@subsquid/solana-stream` | `0.5.0` |

Earlier versions still have `{ url, requestTimeout? }` and reject the field.

**Fix:** bump to a version that supports `apiKey`:
```bash
# EVM
npm i @subsquid/evm-processor@^1.30.0

# Solana
npm i @subsquid/solana-stream@^0.5.0
```

The current packages (`@subsquid/evm-stream` for EVM, `@subsquid/solana-stream@^1.x.x` for Solana) are the Portal stack and have no `.setGateway`; installing them means doing the migration.

How the user adds their key: `v2-auth.md`.

### Anonymous v2 archive requests start 401-ing after 2026-05-19 12:00 UTC

Symptom: `HttpError: Got 401 from https://v2.archive.subsquid.io/network/...` or "unauthorized" responses on a self-hosted squid that was working before.

**Cause:** the v2 gateway requires API-key authentication from May 19, 2026 12:00 UTC onward. Cloud-hosted squids are not affected (Cloud injects the key). RPC-only squids (no `setGateway`) are not affected.

**Fix:** migrate to Portal with the steps in this skill, where `setPortal` replaces `setGateway`. An EVM squid that stays on v2 for now upgrades the processor, and the user adds their key as described in `v2-auth.md`.

---

## EVM

### `TS2353: Object literal may only specify known properties, and 'address' does not exist in type ...`

On a call to `.addLog({...})`, `.addTransaction({...})`, `.addTrace({...})`, or `.addStateDiff({...})`.

**Cause:** filters now live under `where:`, related-item flags under `include:`.

**Fix:**
```ts
// before
.addLog({
  address: [USDC],
  topic0: [TRANSFER],
  transaction: true,
  range: { from: 6_082_465 },
})

// after
.addLog({
  where: { address: [USDC], topic0: [TRANSFER] },
  include: { transaction: true },
  range: { from: 6_082_465 },
})
```

`range` stays at the top level; `transaction: true` moves under `include`.

### `'getBlockStream' does not exist on type 'DataSourceBuilder<...>'`

**Cause:** missing `.build()` at the end of the data-source pipeline.

**Fix:**
```ts
const dataSource = new DataSourceBuilder()
  .setPortal({ url: '...', http: { retryAttempts: Infinity } })
  // .addX(...).setFields(...) ...
  .build()
```

### `TS2305: Module '@subsquid/evm-processor' has no exported member 'X'`

After the install swap, any file still importing from `@subsquid/evm-processor` breaks.

**Fix:** `grep -R "@subsquid/evm-processor"` the project. Retarget every file per the import table in `evm-migration.md` (Step 2). Two specific utilities are not mentioned in the upstream doc:

| Was | Now |
|---|---|
| `import {decodeHex} from '@subsquid/evm-processor'` | `import {decodeHex} from '@subsquid/util-internal-hex'` |
| `import {assertNotNull} from '@subsquid/evm-processor'` | `import {assertNotNull} from '@subsquid/util-internal'` |

Both packages are transitive deps of `@subsquid/evm-stream` — no extra install.

### `'evmLog' does not exist in type 'FieldSelection'`

(Or `Property 'transactionHash' does not exist` on a log after listing `evmLog: { transactionHash: true }`.)

**Cause:** the field-selection key for logs was renamed from `evmLog` to `log` in the pre-`@subsquid/evm-processor@1.0.0` era. Squids that haven't been touched since then still use the old key. In `@subsquid/evm-stream` (Portal) the `evmLog` key is removed entirely.

**Fix:** rename the key:
```ts
.setFields({
  log: { address: true, topics: true, data: true, transactionHash: true },
  transaction: { hash: true },
})
```

### `'number' does not exist in type 'Selector<"nonce" | "sha3Uncles" | ...>'`

On `.setFields({ block: { number: true } })`.

**Cause:** `block.header.number`, `.hash`, and `.parentHash` are always available. The `block` selector only accepts mutable header fields (`timestamp`, `nonce`, `miner`, `extraData`, `mixHash`, `difficulty`, etc.).

**Fix:** remove `number: true` (and `hash: true` / `parentHash: true` if present). They are accessible on `block.header` without being requested.

### `Module '@subsquid/archive-registry' not found` after the package swap

Older squids did `lookupArchive('eth-mainnet')` to get an archive URL.

**Fix:** delete the `lookupArchive` import and the surrounding `.setDataSource({ archive, chain })` call. Replace with a hardcoded Portal URL:

```ts
// before
.setDataSource({
  archive: lookupArchive('eth-mainnet'),
  chain: 'https://rpc.example',
})

// after
.setPortal({
  url: 'https://portal.sqd.dev/datasets/ethereum-mainnet',
  http: { retryAttempts: Infinity },
})
```

The archive-slug → Portal-slug mapping is direct most of the time (`eth-mainnet` → `ethereum-mainnet`, `bsc-mainnet` → `binance-mainnet`, etc.). Verify with `curl -sI https://portal.sqd.dev/datasets/<slug>/metadata`.

### `EvmBatchProcessorFields is not exported`

When the squid had:
```ts
export type Fields = EvmBatchProcessorFields<typeof processor>
```

**Cause:** the new builder doesn't expose a `*Fields<typeof builder>` reflection.

**Fix:** hoist `setFields(...)` into a literal `fields` object and derive types:

```ts
export const fields = {
  block: { timestamp: true },
  log: { address: true, topics: true, data: true, transactionHash: true },
} satisfies FieldSelection

export const dataSource = new DataSourceBuilder()
  // ...
  .setFields(fields)
  // ...
  .build()

export type Fields = typeof fields
export type Block = evmObjects.BlockHeader<Fields>
export type BlockData = evmObjects.Block<Fields>
export type Log = evmObjects.Log<Fields>
export type Transaction = evmObjects.Transaction<Fields>
```

The `satisfies FieldSelection` is essential — it validates keys without widening `fields` to `FieldSelection`. Without it, the downstream `evmObjects.Log<Fields>` etc. degrade to "all fields".

### `Type 'Block<Fields>' is missing the following properties from type 'BlockHeader<Fields>': transactions, logs, ...`

Or the inverse — `BlockHeader` lacks `transactions`/`logs`.

**Cause:** `Block` ↔ `BlockHeader`/`BlockData` swap.
- Old: `Block = BlockHeader` (header only); `BlockData = full payload`.
- New: `BlockHeader = header only`; `Block = full payload`.

**Fix:**
```ts
export type Block = evmObjects.BlockHeader<Fields>   // header only
export type BlockData = evmObjects.Block<Fields>     // full payload
```

If a function was typed `(b: Block) => ...` and now reaches into `b.transactions`, it should take `BlockData`. Rename callsites.

### `Property 'height' does not exist on type 'BlockHeader<Fields>'`

(Or on `Block<Fields>`.)

**Cause:** the old `evm-processor` exposed `block.height` as a *shortcut* directly on the block; the new `Block`/`BlockHeader` types from `@subsquid/evm-objects` no longer surface that shortcut. The underlying field is still there on the header as `block.header.height` (typed as `@deprecated` — prefer `block.header.number`, which is the same value).

**Fix:**
- `block.height` → `block.header.number` (or `block.header.height` for a literal rename, though `.height` is deprecated on the new header)
- `block.timestamp` (shortcut) → `block.header.timestamp`
- `log.block.height` → `log.block.number` (after `augmentBlock`)

### `TS2345: Argument of type 'DataHandlerContext<X, Y>' is not assignable to ...`

Generic mismatch errors on functions that previously typed `ctx` as `DataHandlerContext<Store, Fields>`.

**Cause:** generic argument order is flipped.
- Old: `DataHandlerContext<Store, Fields>`
- New: `DataHandlerContext<BlockData, Store>`

**Fix:** rewrite the alias and update call sites:
```ts
export type Context<Store> = BaseDataHandlerContext<BlockData, Store> & {
  log: Logger
}
```

### `Property 'address' does not exist on type 'Log'`

(Or `topics`, `data`, `timestamp`, `from`, `to`, `hash`, etc.)

**Cause:** the new stream fetches only fields listed in `.setFields()`. The v2 processor merged a default set including `log.address`, `log.topics`, `log.data`, `block.timestamp`, `transaction.from/to/hash`. The new stream does not.

**Fix:** add the missing field to `.setFields()`:
```ts
.setFields({
  block: { timestamp: true },
  log: {
    address: true,
    topics: true,
    data: true,
    transactionHash: true,
  },
  transaction: {
    from: true,
    to: true,
    hash: true,
    value: true,
  },
})
```

### `TypeError: Cannot read properties of undefined (reading 'log')` at runtime

The handler reaches `ctx.log` but the augmented `ctx` wasn't built (or was built in some code paths only).

**Fix:** centralise the wrapper that builds the augmented context:
```ts
function buildCtx(raw: BaseDataHandlerContext<BlockData, Store>): Context<Store> {
  return {
    ...raw,
    blocks: raw.blocks.map(augmentBlock),
    log: logger,
  }
}

run(dataSource, db, async (raw) => {
  const ctx = buildCtx(raw)
  // always use ctx, never raw
})
```

### `block.logs[*].transaction` is `undefined` even though `include: { transaction: true }` is set

Two possible causes:

1. The block wasn't passed through `augmentBlock` — the convenience back-references only exist after augmentation. Fix: `ctx.blocks = ctx.blocks.map(augmentBlock)`.
2. `.setFields().transaction` is empty, so the included transaction has no readable fields. Fix: add fields to the transaction selector:
   ```ts
   .setFields({
     transaction: { hash: true, from: true, to: true },
   })
   ```

### Indexer exits during a Portal outage

The HTTP client spent its retry budget. `@subsquid/evm-stream` before 0.1.4 capped every Portal request at 6 retries (about 33 seconds) even when `retryAttempts` was set; 0.1.4 and later default to 20 retries (about five minutes) and honour the configured value.

**Fix:** upgrade `@subsquid/evm-stream`, and use the object form of `.setPortal()` with infinite retries:
```ts
.setPortal({
  url: 'https://portal.sqd.dev/datasets/ethereum-mainnet',
  http: { retryAttempts: Infinity },
})
```

### Hot-block rollbacks crash the store

Missing `supportHotBlocks: true` on the database constructor.

**Fix:**
```ts
const db = new TypeormDatabase({ supportHotBlocks: true })
```

### `Property '_chain' does not exist on type 'DataHandlerContext<Store>'`

When calling `new abi.Contract(ctx, header, address)` or `ctx._chain.client.call(...)`.

**Cause:** the new base `DataHandlerContext` doesn't carry `_chain`.

**Fix:**
```ts
import type {RpcClient} from '@subsquid/rpc-client'

export type Context<Store> = BaseDataHandlerContext<BlockData, Store> & {
  log: Logger
  _chain: { client: RpcClient }
}

const rpcClient = new RpcClient({ url: process.env.RPC_URL!, rateLimit: 100 })

run(dataSource, db, async (raw) => {
  const ctx: Context<Store> = {
    ...raw,
    blocks: raw.blocks.map(augmentBlock),
    log: logger,
    _chain: { client: rpcClient },
  }
})
```

`@subsquid/rpc-client` is a separate install (`npm i @subsquid/rpc-client`).

---

## Solana

### `Module '"@subsquid/solana-stream"' has no exported member 'SolanaRpcClient'`

After upgrading `@subsquid/solana-stream` to `^1.x.x`.

**Fix:** drop both the import and the `.setRpc({...})` call:
```diff
-import {DataSourceBuilder, SolanaRpcClient} from '@subsquid/solana-stream'
+import {DataSourceBuilder} from '@subsquid/solana-stream'

 const dataSource = new DataSourceBuilder()
-  .setRpc(process.env.SOLANA_NODE == null ? undefined : {
-    client: new SolanaRpcClient({ url: process.env.SOLANA_NODE }),
-    strideConcurrency: 10,
-  })
```

### `HttpError: Got 404` with body `solana-mainnet dataset starts from <height> block`

Hit while still on the v2 archive (pre-Portal migration).

**Cause:** v2 archives prune older history. Squid templates often hardcode a `from:` height from when they were written; once the archive's floor passes, the squid 404s.

**Fix:** bump `from:` above the height in the 404 body (the error is self-diagnosing). Long-term fix: finish the Portal migration — Portal serves history from block 0.

### `Property 'slot' does not exist on type 'BlockHeader'`

(Or `Property 'slot' does not exist on type 'Transaction'`.)

**Cause:** the Portal `BlockHeader` normalises on `.number` (which on Solana represents the slot).

**Fix:**
- `block.header.slot` → `block.header.number`
- `transaction.block.slot` / `instruction.block.slot` → `.number`

To keep `slot` in the output model, just rename access on the input side:
```ts
let exchange = new Exchange({
  slot: block.header.number,   // output field name unchanged
})
```

### `Property 'preMint' does not exist on type 'TokenBalance<F>'`

(Or `postMint`, `preDecimals`, `postDecimals`.)

**Cause:** these fields were part of the **v2** `tokenBalance` default field set, but Portal `solana-stream@^1.x.x` ships **no** default field set (only required identity fields like `transactionIndex` / `account` are always present on a `TokenBalance`; everything else must be requested). A v2 handler that read `tokenBalance.preMint` without listing it broke at compile time after migration.

**Fix:** add the fields to `.setFields({ tokenBalance: {...} })`:
```ts
.setFields({
  tokenBalance: {
    preAmount: true,
    postAmount: true,
    preOwner: true,
    postOwner: true,
    preMint: true,       // ← add
    postMint: true,      // ← add
    // preDecimals / postDecimals if you read them
  },
})
```

### `Property 'signatures' does not exist on type 'Transaction<F>'`

(Or `accountKeys`, `timestamp` on the header, `preAmount` on a token balance, etc.)

**Cause:** Portal `solana-stream@^1.x.x` ships **no** default fields. Only the required identity/index fields are always present (`block.{number,hash,parentHash}`, `transaction.transactionIndex`, etc.); everything else must be requested via `.setFields()`. v2 merged a default set on top of your selection, so squids that relied on it now fail to compile.

v2 `DEFAULT_FIELDS` (what was previously free, and now is not):
```
block:        { slot, parentSlot, timestamp }
transaction:  { signatures, err }
instruction:  { programId, accounts, data, isCommitted }
log:          { programId, kind, message }
balance:      { pre, post }
tokenBalance: { preMint, preDecimals, preOwner, preAmount,
                postMint, postDecimals, postOwner, postAmount }
reward:       { lamports, rewardType }
```

**Fix:** request the field explicitly:
```ts
.setFields({
  block: { timestamp: true },
  transaction: {
    signatures: true,
    accountKeys: true,   // not in defaults
  },
  instruction: { programId: true, accounts: true, data: true },
  tokenBalance: {
    preAmount: true, postAmount: true, preOwner: true, postOwner: true,
    preMint: true, postMint: true,
  },
})
```

### Indexer exits during a Portal outage

The HTTP client spent its retry budget. `@subsquid/solana-stream` before 1.2.1 capped every Portal request at 6 retries (about 33 seconds) even when `retryAttempts` was set; 1.2.1 and later default to 20 retries (about five minutes) and honour the configured value.

**Fix:** upgrade `@subsquid/solana-stream`, and use the object form of `.setPortal()` with infinite retries:
```ts
.setPortal({
  url: 'https://portal.sqd.dev/datasets/solana-mainnet',
  http: { retryAttempts: Infinity },
})
```

### Indexer crashes when it catches up to the chain head

Without `supportHotBlocks: true`, the store can't apply Portal's hot-block updates once the indexer reaches the head and Portal starts delivering unfinalized blocks.

**Fix:**
```ts
const database = new TypeormDatabase({ supportHotBlocks: true })
```

### `setBlockRange` returns zero blocks even though the squid synced fine before

The `from` value is still a block height; Portal expects a slot. Heights and slots are different sequences on Solana — slots have gaps for skipped slots, heights don't.

**Fix:** use the bisection converter embedded at <https://docs.sqd.dev/en/sdk/squid-sdk/solana/guides/migration/height-to-slot> to translate height → slot.

### Need RPC fallback after the migration?

`SolanaRpcClient` from `@subsquid/solana-stream` is gone. For direct RPC calls in the batch handler (e.g. reading account state), use `@subsquid/rpc-client`:

```ts
import {RpcClient} from '@subsquid/rpc-client'

const rpcClient = new RpcClient({
  url: process.env.SOLANA_NODE!,
  rateLimit: 100,
})

run(dataSource, db, async (raw) => {
  const ctx = {
    ...raw,
    blocks: raw.blocks.map(augmentBlock),
    _chain: { client: rpcClient },
  }
})
```

Same pattern as the EVM RPC-client step.

For RPC as a second **data source** rather than for handler reads, `@subsquid/squid-sdk` (0.7.0 on 2026-11-11) has `SolanaFallbackDataSourceBuilder` (`@subsquid/squid-sdk/solana/fallback`) and `EvmFallbackDataSourceBuilder` (`@subsquid/squid-sdk/evm/fallback`): an ordered list of Portal and RPC sources that fails over when the active one errors or hangs. See the [fallback reference](https://docs.sqd.dev/en/sdk/squid-sdk/evm/reference/evm-fallback).

### `@subsquid/borsh` typed decoders fail after the upgrade

`ncu --target latest` bumps `@subsquid/borsh` from `^0.2.0` to `^0.3.0`. The upgrade can change the generated typegen output.

**Fix:** regenerate the typegen output after the bump:
```bash
npx @subsquid/solana-typegen <typegen-config-or-args>
```
