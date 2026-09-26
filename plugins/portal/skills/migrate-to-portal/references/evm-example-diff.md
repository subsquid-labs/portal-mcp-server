# EVM example diff — USDC Transfers (Ethereum mainnet)

Canonical example matching the upstream migration doc. Use as a reference; adapt filters and field set to your squid.

## `src/main.ts`

```diff
-import {EvmBatchProcessor} from '@subsquid/evm-processor'
+import {DataSourceBuilder} from '@subsquid/evm-stream'
+import {augmentBlock} from '@subsquid/evm-objects'
+import {run} from '@subsquid/batch-processor'
+import {createLogger} from '@subsquid/logger'
 import {TypeormDatabase} from '@subsquid/typeorm-store'
 import * as usdcAbi from './abi/usdc'
 import {UsdcTransfer} from './model'

 const USDC_CONTRACT_ADDRESS = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'

-const processor = new EvmBatchProcessor()
-  .setGateway('https://v2.archive.subsquid.io/network/ethereum-mainnet')
-  .setRpcEndpoint('https://rpc.example')
-  .setFinalityConfirmation(75)
+const dataSource = new DataSourceBuilder()
+  .setPortal({
+    url: 'https://portal.sqd.dev/datasets/ethereum-mainnet',
+    http: { retryAttempts: Infinity },
+  })
   .addLog({
-    address: [USDC_CONTRACT_ADDRESS],
-    topic0: [usdcAbi.events.Transfer.topic],
-    transaction: true,
+    where: {
+      address: [USDC_CONTRACT_ADDRESS],
+      topic0: [usdcAbi.events.Transfer.topic],
+    },
+    include: {
+      transaction: true,
+    },
     range: { from: 6_082_465 },
   })
   .setFields({
     log: {
       address: true,
       topics: true,
       data: true,
       transactionHash: true,
     },
   })
+  .build()

-const db = new TypeormDatabase()
+const db = new TypeormDatabase({supportHotBlocks: true})

-processor.run(db, async (ctx) => {
+const logger = createLogger('sqd:processor:mapping')
+
+run(dataSource, db, async (simpleCtx) => {
+  const ctx = {
+    ...simpleCtx,
+    blocks: simpleCtx.blocks.map(augmentBlock),
+    log: logger,
+  }
+
   const transfers: UsdcTransfer[] = []
   for (let block of ctx.blocks) {
     for (let log of block.logs) {
       if (log.address === USDC_CONTRACT_ADDRESS &&
           log.topics[0] === usdcAbi.events.Transfer.topic) {
         let {from, to, value} = usdcAbi.events.Transfer.decode(log)
         transfers.push(new UsdcTransfer({
           id: log.id,
           block: block.header.number,
           from,
           to,
           value,
           txnHash: log.transactionHash,
         }))
       }
     }
   }
   await ctx.store.insert(transfers)
 })
```

## Type aliases

```diff
-import {
-  BlockHeader,
-  DataHandlerContext,
-  EvmBatchProcessor,
-  Log as _Log,
-  Transaction as _Transaction,
-  BlockData as _BlockData,
-  FieldSelection,
-} from '@subsquid/evm-processor'
+import * as evmObjects from '@subsquid/evm-objects'
+import {DataSourceBuilder, FieldSelection} from '@subsquid/evm-stream'
+import type {DataHandlerContext as BaseDataHandlerContext} from '@subsquid/batch-processor'
+import type {Logger} from '@subsquid/logger'

 const fields = {
   log: {
     address: true,
     topics: true,
     data: true,
     transactionHash: true,
   },
 } satisfies FieldSelection

 export type Fields = typeof fields
-export type Block = BlockHeader<Fields>
-export type BlockData = _BlockData<Fields>
-export type Log = _Log<Fields>
-export type Transaction = _Transaction<Fields>
-export type ProcessorContext<Store> = DataHandlerContext<Store, Fields>
+export type Block = evmObjects.BlockHeader<Fields>
+export type BlockData = evmObjects.Block<Fields>
+export type Log = evmObjects.Log<Fields>
+export type Transaction = evmObjects.Transaction<Fields>
+export type Context<Store> = BaseDataHandlerContext<BlockData, Store> & {
+  log: Logger
+  // _chain?: { client: RpcClient }   // add if you make direct RPC calls
+}
```

Two non-obvious renames:

- `Block` was header-only; it is now the full payload. The old `BlockData` shape is the new `Block`. The old `Block` shape is the new `BlockHeader`.
- `ProcessorContext` is conventionally renamed to `Context` or `DataHandlerContext` since there is no `Processor` object anymore.

## Older v2 squids — `setDataSource({ archive, chain })` shape

Squids written before `setGateway` existed used the older shape. The migration is identical — replace the whole block with the same `.setPortal({...})` call from the main diff. Uninstall `@subsquid/archive-registry` along with `@subsquid/evm-processor`.

```diff
-import { lookupArchive } from '@subsquid/archive-registry'
-
-const processor = new EvmBatchProcessor()
-  .setDataSource({
-    archive: lookupArchive('eth-mainnet'),
-    chain: 'https://rpc.example',
-  })
-  .setFinalityConfirmation(75)
+const dataSource = new DataSourceBuilder()
+  .setPortal({
+    url: 'https://portal.sqd.dev/datasets/ethereum-mainnet',
+    http: { retryAttempts: Infinity },
+  })
   // ... rest matches the main diff above
```

The archive-slug → Portal-slug mapping is direct for most chains (`eth-mainnet` → `ethereum-mainnet`, `bsc-mainnet` → `binance-mainnet`). Verify with `curl -sI https://portal.sqd.dev/datasets/<slug>/metadata`.

## `package.json`

```diff
   "dependencies": {
-    "@subsquid/evm-processor": "^X.Y.Z",
-    "@subsquid/archive-registry": "^3.x"            // older squids only
+    "@subsquid/evm-stream": "^0.1.0",
+    "@subsquid/evm-objects": "^0.0.3",
+    "@subsquid/batch-processor": "^1.0.0",
+    "@subsquid/logger": "^1.6.0",
     "@subsquid/typeorm-store": "^1.9.1",
     // ...
   }
```

If the handler does direct RPC calls, also add:

```diff
   "dependencies": {
+    "@subsquid/rpc-client": "^4.15.0",
     // ...
   }
```

## Optional: contract state reads

```diff
+import {RpcClient} from '@subsquid/rpc-client'
+
+const rpcClient = new RpcClient({
+  url: process.env.RPC_URL!,
+  rateLimit: 100,
+})

 run(dataSource, db, async (simpleCtx) => {
   const ctx = {
     ...simpleCtx,
     blocks: simpleCtx.blocks.map(augmentBlock),
     log: logger,
+    _chain: { client: rpcClient },
   }

   // contract reads via new abi.Contract(ctx, header, address) work unchanged.
   // Use ctx.blocks[0].header (with an empty-batch guard) for the header:
   if (ctx.blocks.length > 0) {
     const usdcContract = new usdcAbi.Contract(ctx, ctx.blocks[0].header, USDC_CONTRACT_ADDRESS)
     const decimals = await usdcContract.decimals()
   }
 })
```

## Required from 2026-05-19 12:00 UTC: API key on v2 gateway

Self-hosted squids that still hit the v2 archive must authenticate from May 19, 2026 12:00 UTC. Cloud-hosted squids are unaffected. To stay on v2 for now, upgrade the processor:

```bash
npm i @subsquid/evm-processor@^1.30.0
```

The user then creates a key at <https://portal.sqd.dev/app> and adds it to the squid as SQD's guide describes. Don't ask for the key, read it, or write it into the project. The `apiKey` gateway setting was added in `@subsquid/evm-processor@1.30.0`; earlier versions reject it.

Reference docs: <https://docs.sqd.dev/changelog/gateway-api-keys> · <https://docs.sqd.dev/en/data/api-keys>

## Reference templates

- <https://github.com/subsquid-labs/squid-evm-rt-template/tree/with-logger> — minimal Portal squid with logger
- <https://github.com/subsquid-labs/squid-evm-rt-template/tree/with-rpc-client> — same, with RPC client
