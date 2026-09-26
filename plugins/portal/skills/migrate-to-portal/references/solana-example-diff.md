# Solana example diff — Whirlpool USDC↔SOL swaps

Canonical example matching `subsquid-labs/solana-example` going from `archive/v2-based-version` to Portal. Adapt filters and field set to your squid.

## `src/main.ts`

```diff
 import {run} from '@subsquid/batch-processor'
 import {augmentBlock} from '@subsquid/solana-objects'
-import {DataSourceBuilder, SolanaRpcClient} from '@subsquid/solana-stream'
+import {DataSourceBuilder} from '@subsquid/solana-stream'
 import {TypeormDatabase} from '@subsquid/typeorm-store'
 import assert from 'assert'
 import * as tokenProgram from './abi/token-program'
 import * as whirlpool from './abi/whirlpool'
 import {Exchange} from './model'

 const dataSource = new DataSourceBuilder()
-  .setGateway('https://v2.archive.subsquid.io/network/solana-mainnet')
-  .setRpc(process.env.SOLANA_NODE == null ? undefined : {
-    client: new SolanaRpcClient({
-      url: process.env.SOLANA_NODE,
-    }),
-    strideConcurrency: 10
-  })
-  .setBlockRange({from: 289_819_150})   // BLOCK HEIGHT
+  .setPortal({
+    url: 'https://portal.sqd.dev/datasets/solana-mainnet',
+    http: {
+      retryAttempts: Infinity,
+    },
+  })
+  .setBlockRange({from: 317_617_480})   // SLOT NUMBER
   .setFields({
     block: { timestamp: true },
     transaction: { signatures: true },
     instruction: { programId: true, accounts: true, data: true },
     tokenBalance: {
       preAmount: true, postAmount: true, preOwner: true, postOwner: true,
+      preMint: true, postMint: true,
     },
   })
   .addInstruction({
     where: {
       programId: [whirlpool.programId],
       d8: [whirlpool.instructions.swap.d8],
       ...whirlpool.instructions.swap.accountSelection({
         whirlpool: ['7qbRF6YsyGuLUVs6Y1q64bdVrfe4ZcUUz1JRdoVNUJnm'],
       }),
       isCommitted: true,
     },
     include: {
       innerInstructions: true,
       transaction: true,
       transactionTokenBalances: true,
     },
   })
   .build()

-const database = new TypeormDatabase()
+const database = new TypeormDatabase({supportHotBlocks: true})

 run(dataSource, database, async ctx => {
   let blocks = ctx.blocks.map(augmentBlock)
   let exchanges: Exchange[] = []

   for (let block of blocks) {
     for (let ins of block.instructions) {
       if (ins.programId === whirlpool.programId && ins.d8 === whirlpool.instructions.swap.d8) {
         let exchange = new Exchange({
           id: ins.id,
-          slot: block.header.slot,
+          slot: block.header.number,
           tx: ins.getTransaction().signatures[0],
           timestamp: new Date(block.header.timestamp * 1000),
         })
         // ... rest of handler unchanged
       }
     }
   }

   await ctx.store.insert(exchanges)
 })
```

## `package.json`

After `npx --yes npm-check-updates --filter "@subsquid/*" --target "@latest" --upgrade`:

```diff
   "dependencies": {
-    "@subsquid/batch-processor": "^0.0.0",
-    "@subsquid/borsh":            "^0.2.0",
-    "@subsquid/solana-objects":   "^0.0.2",
-    "@subsquid/solana-stream":    "^0.1.4",
-    "@subsquid/typeorm-store":    "^1.5.1",
+    "@subsquid/batch-processor": "^1.0.0",
+    "@subsquid/borsh":            "^0.3.0",
+    "@subsquid/solana-objects":   "^1.0.0",
+    "@subsquid/solana-stream":    "^1.1.1",
+    "@subsquid/typeorm-store":    "^1.9.1",
     // ...
   },
   "devDependencies": {
-    "@subsquid/solana-typegen": "^0.4.0",
+    "@subsquid/solana-typegen": "^0.9.1",
     // ...
   }
```

`@subsquid/borsh` bumps `0.2 → 0.3`. Regenerate typegen output (`npx squid-solana-typegen`) after the bump if you use typed Borsh decoders.

## Block height → slot conversion

The upstream doc embeds an interactive converter inline at <https://docs.sqd.dev/en/sdk/migration/height-to-slot>. It binary-searches the public Portal to translate a v2 height into the corresponding slot. Reference values from the doc and the canonical `solana-example/master`:

| Height (v2)  | Slot (Portal) |
|--------------|---------------|
| 289_819_150  | 317_617_480   |
| 303_262_650  | 325_000_000   |

## Required from 2026-05-19 12:00 UTC: API key on v2 gateway

Self-hosted squids that still hit the v2 archive must authenticate from May 19, 2026 12:00 UTC. Cloud-hosted squids are unaffected. To stay on v2 for now, upgrade the stream package:

```bash
npm i @subsquid/solana-stream@^0.5.0
```

The user then creates a key at <https://portal.sqd.dev/app> and adds it to the squid as SQD's guide describes. Don't ask for the key, read it, or write it into the project. The `apiKey` gateway setting was added in `@subsquid/solana-stream@0.5.0`; earlier 0.x versions reject it.

Reference docs: <https://docs.sqd.dev/changelog/gateway-api-keys> · <https://docs.sqd.dev/en/data/api-keys>

## Reference template

- <https://github.com/subsquid-labs/solana-example/tree/master> — post-migration shape (uses `setPortal`, `supportHotBlocks: true`, slot-based block range, `block.header.number`).
