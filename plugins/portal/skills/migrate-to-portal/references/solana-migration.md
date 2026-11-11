# Solana migration steps

The Solana branch of `../SKILL.md`: `@subsquid/solana-stream` moves from `0.x` on the v2 gateway to `1.x` on Portal. Do the steps in order, then return to `SKILL.md` for hot blocks, verification and the re-sync. A full before/after of one file is in `solana-example-diff.md`; compiler and runtime errors are in `common-errors.md`.

## Step 1 — Code cleanup, then upgrade packages

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

## Step 2 — Rewrite the data source

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

1. Replace `.setGateway(...)` (and `.setRpc({...})` if present) with `.setPortal({ url, http })`. `retryAttempts: Infinity` keeps a production indexer waiting through a Portal outage. The default budget is 20 retries, about five minutes, from `@subsquid/solana-stream` 1.2.1 on; earlier `1.x` releases gave up after about 33 seconds whatever was configured.
2. Convert the block-range `from` from a block height to a slot number. Solana exposes both; the v2 archive used heights, Portal uses slots. Use the interactive bisection converter embedded at <https://docs.sqd.dev/en/sdk/squid-sdk/solana/guides/migration/height-to-slot> (binary-searches the public Portal).

Selectors inside `.addInstruction({ where, include })` and field selection in `.setFields({...})` keep the same shape.

## Step 3 — Block-header rename in the handler

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

## Step 4 — Field selection

The Portal `solana-stream` (`^1.x.x`) fetches **only** the fields listed in `.setFields()`. There is no default set — beyond a small set of always-required identity/index fields (`block.number`/`.hash`/`.parentHash`, `transaction.transactionIndex`, `instruction.transactionIndex`/`.instructionAddress`, etc.), every field must be requested explicitly. TypeScript enforces this: accessing a field not in your selection is a compile error.

v2 was different — it merged a default set on top of your selection, so a partial `.setFields()` still worked at runtime. The full v2 default table is in `common-errors.md` ("Property 'signatures' does not exist..."). The most-missed cases on a real squid: `tokenBalance.preMint` / `postMint` (commonly used to recover which token is involved in a swap), `transaction.signatures`, `block.header.timestamp`.

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
