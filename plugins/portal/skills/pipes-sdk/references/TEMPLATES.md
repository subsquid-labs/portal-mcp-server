# Templates & Network-Specific Setup

The Pipes CLI ships with a catalog of templates; discover them with:
```bash
pnpx @subsquid/pipes-cli@1.0.0-alpha.4 init --schema
```

Template IDs are **camelCase** (`uniswapV3Swaps`, not `uniswap-v3-swaps`). Each template has a required `params` schema — check `--schema` for the exact fields.

Current catalog (verified against the published alpha.4 schema): `networkType: "evm"` → `custom`, `erc20Transfers`, `uniswapV3Swaps`; `networkType: "svm"` → `custom`, `tokenBalances`. Sinks: `clickhouse`, `postgresql`, `memory`.

> **The CLI's built-in network list can lag Portal** — it still offers datasets Portal has dropped (e.g. `fantom-mainnet`) and misses recent additions. Verify the dataset with `curl -I https://portal.sqd.dev/datasets/{name}/metadata` before scaffolding.

> **Generated projects pin `"@subsquid/pipes": "alpha"`** — a floating npm dist-tag, so a fresh `npm install` always pulls the newest alpha (currently 1.0.0-alpha.16). If an older project behaves differently from a new one, compare the installed `@subsquid/pipes` versions first.

## What the CLI generates

A generated project (published alpha.4) is more than a bare `src/index.ts`:
- **`src/index.ts` uses `evmPortalSource`** — an exported alias of `evmPortalStream` (identical function), so don't be thrown when the generated code doesn't say `evmPortalStream`.
- **A random pipe `id`** (e.g. `id: 'b3a3a02b'`) for cursor isolation.
- **ClickHouse tables default to `CollapsingMergeTree(sign)`** — a `sign Int8 DEFAULT 1` column plus `INDEX _sqd_rollback_idx block_number TYPE minmax GRANULARITY 1`. The fork-safe, MV-propagating rollback pattern is now the scaffold default, not a plain `MergeTree`.
- **A `migrations/` directory** and an **`AGENTS.md`** at the project root.
- **`package.json`** pins `"@subsquid/pipes": "alpha"` and uses **zod v4** (`zod ^4`).

## EVM Templates

### erc20Transfers — ERC20 Transfer events

```json
{
  "templateId": "erc20Transfers",
  "params": {
    "contractAddresses": ["0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"],
    "range": {"from": "21000000"}
  }
}
```

### uniswapV3Swaps — Uniswap V3 swaps via factory pattern

```json
{
  "templateId": "uniswapV3Swaps",
  "params": {
    "factoryAddress": "0x1F98431c8aD98523631AE4a59f267346ea31F984",
    "range": {"from": "21000000"}
  }
}
```

### custom — Custom contract events

**Requires full ABI event objects, NOT just event names.**

```json
{
  "templateId": "custom",
  "params": {
    "contracts": [{
      "contractAddress": "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
      "contractName": "WETH",
      "contractEvents": [
        {
          "name": "Deposit",
          "type": "event",
          "inputs": [
            {"name": "dst", "type": "address", "indexed": true},
            {"name": "wad", "type": "uint256"}
          ]
        }
      ],
      "range": {"from": "21000000"}
    }]
  }
}
```

**Common mistake:** `"contractEvents": ["Deposit", "Withdrawal"]` (just names) fails with `Invalid input: expected array, received undefined`. Each event needs full `{name, type, inputs}` with `indexed: true` for indexed params.

### Template Parameter Mapping

| templateId | Required params | Description |
|------------|----------------|-------------|
| `custom` | `contracts[]` with `{contractAddress, contractName, contractEvents, range}` | Custom contract events with full ABI |
| `erc20Transfers` | `contractAddresses[]`, `range` | ERC20 Transfer events |
| `uniswapV3Swaps` | `factoryAddress`, `range` | Uniswap V3 swaps via factory pattern |

## Solana (SVM) Templates

### custom — Custom program instructions

**Note:** SVM `custom` requires the same `contracts[]` shape as EVM custom — `{contractAddress, contractName, contractEvents, range}` — and runs `squid-solana-typegen` in its `postSetup`. The `Invalid input: expected array, received undefined` error is just the generic missing/malformed `contracts` validation error, not an SVM-specific breakage: supply a valid `contracts[]` array and it scaffolds.

### Anchor vs Non-Anchor: Determine First

Before writing any Solana indexer, determine the program type — it dictates the entire approach:

|  | Anchor | Non-Anchor |
|---|---|---|
| Discriminator | `d8` (8 bytes, from `sha256("global:<name>")`) | `d1` (1 byte, Borsh enum index) |
| Typegen | Yes — `@subsquid/solana-typegen` | No — manual Borsh decoding |
| IDL available | On-chain or GitHub (`target/idl/*.json`) | No IDL — read Rust source |
| Decoding | `instructions.swap.decode(ins)` → typed `{ accounts, data }` | Manual: read bytes from base58-decoded data |
| Examples | Jito Tip Distribution, Jupiter Lend, Orca Whirlpool | SPL Token, SPL Stake Pool, System Program |

**Detection:** Query Portal for the program's instructions and check `d8` values. 8-byte hex (`0x3ec6d6c1d59f6cd2`) = Anchor. Single meaningful byte in `d1` = non-Anchor.

### Anchor Programs: Use Typegen

```bash
npm install @subsquid/solana-typegen

# Method 1: Local IDL JSON
npx squid-solana-typegen src/abi whirlpool.json

# Method 2: Fetch IDL from on-chain
npx squid-solana-typegen src/abi whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc#whirlpool

# Method 3: Glob pattern
npx squid-solana-typegen src/abi ./idl/*
```

Generated module exports:
- `programId` — public key constant
- `instructions.<name>.d8` — 8-byte discriminator
- `instructions.<name>.decode(ins)` — typed decoder → `{ accounts, data }`
- `instructions.<name>.accountSelection(mapping)` — account-position filter helper

**Usage with SolanaQueryBuilder:**
```typescript
import * as whirlpool from './abi/whirlpool'
import { solanaPortalStream, solanaQuery } from '@subsquid/pipes/solana'

const query = solanaQuery()
  .addFields({
    block: { number: true, timestamp: true },
    transaction: { signatures: true },
    instruction: { programId: true, accounts: true, data: true },
  })
  .addInstruction({
    range: { from: 280000000 },
    request: {
      programId: [whirlpool.programId],
      d8: [whirlpool.instructions.swap.d8],
      ...whirlpool.instructions.swap.accountSelection({
        whirlpool: ['7qbRF6YsyGuLUVs6Y1q64bdVrfe4ZcUUz1JRdoVNUJnm']
      }),
      transaction: true,
    },
  })
```

**Decoding in `.pipe()`:**
```typescript
.pipe((blocks) => {
  const swaps = []
  for (const block of blocks) {
    for (const ins of block.instructions ?? []) {
      if (ins.programId === whirlpool.programId && ins.d8 === whirlpool.instructions.swap.d8) {
        const decoded = whirlpool.instructions.swap.decode(ins)
        swaps.push({
          slot: block.header.number,
          timestamp: new Date(block.header.timestamp * 1000).toISOString(),
          ...decoded.data,
        })
      }
    }
  }
  return { swaps }
})
```

**Where to find IDLs:**
1. **On-chain** — `npx squid-solana-typegen src/abi <programId>#<name>` queries the chain
2. **GitHub** — most protocols publish `target/idl/*.json`
3. **Anchor IDL registries** — stored at a PDA derived from program ID
4. **Protocol docs** — some link IDLs directly

**When on-chain IDL is missing:** Some Anchor programs don't store IDLs on-chain. `programId#name` fails with `Failed to fetch IDL`. Download from the protocol's GitHub repo and pass local files.

### Non-Anchor Programs: Manual d1 Decoding

**Typegen does NOT work for non-Anchor programs** (SPL Token, SPL Stake Pool, System Program, etc.).

**Step 1: Discover d1 discriminators from Portal:**
```bash
curl -s 'https://portal.sqd.dev/datasets/solana-mainnet/stream' \
  -H 'content-type: application/json' \
  -H 'accept: application/x-ndjson' \
  -d '{"type":"solana","fromBlock":400000000,"toBlock":400010000,
       "instructions":[{"programId":["SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy"]}],
       "fields":{"instruction":{"programId":true,"d1":true}}}' \
  | python3 -c "import sys,json; counts={}
for l in sys.stdin:
  for i in json.loads(l).get('instructions',[]):
    d=i.get('d1','?'); counts[d]=counts.get(d,0)+1
for k,v in sorted(counts.items(),key=lambda x:-x[1]): print(f'{k}: {v}')"
```

**Step 2: Map d1 values to instruction names from the Rust source:**
```typescript
const INSTRUCTIONS: Record<string, string> = {
  '0x09': 'DepositStake',
  '0x0a': 'WithdrawStake',
  '0x0e': 'DepositSol',
  '0x10': 'WithdrawSol',
}
```

**Step 3: Filter by d1 in SolanaQueryBuilder:**
```typescript
.addInstruction({
  range: { from: FROM_SLOT },
  request: {
    programId: [SPL_STAKE_POOL],
    d1: Object.keys(INSTRUCTIONS),
    isCommitted: true,
    transaction: true,
  },
})
```

**Step 4: Decode manually in `.pipe()`:**
```typescript
const data = base58Decode(ins.data)
const d1Hex = '0x' + data[0].toString(16).padStart(2, '0')
const instrName = INSTRUCTIONS[d1Hex]

// Read u64 LE amount after d1 byte (if present)
let amount = 0n
if (data.length >= 9) {
  for (let i = 0; i < 8; i++) amount |= BigInt(data[1 + i]) << BigInt(i * 8)
}

const pool = ins.accounts?.[0] ?? ''
```

**Volume warning:** Many non-Anchor programs (especially SPL Stake Pool) have very low on-chain instruction volume. Check volume with Portal BEFORE building.

### CPI (Cross-Program Invocation) — CRITICAL for DeFi

Many Solana DeFi protocols use layered architecture where user-facing programs call core programs via CPI. Example: Jupiter Lend's Lending/Vaults call the Liquidity program's `operate` via CPI.

**Symptom:** Indexer returns zero data but Portal shows instructions exist → instructions are CPI (inner instructions).

**Fix:** Add `innerInstructions: true` to `addInstruction()`:
```typescript
.addInstruction({
  range: { from: FROM_SLOT },
  request: {
    programId: [myProgram.programId],
    d8: [myProgram.instructions.operate.d8],
    isCommitted: true,
    transaction: true,
    innerInstructions: true,
  },
})
```

**Detect:** Query Portal for the program's instructions and check `instructionAddress`. All entries with `len > 1` = all CPI. Without this flag, the indexer silently captures zero data.

## Tron (No CLI Template)

The Pipes SDK supports Tron natively via `@subsquid/pipes/tron` (alpha.15+), but the CLI cannot scaffold Tron projects — set up manually (package.json, tsconfig, src/index.ts, sink config). Install the SDK with `npm i @subsquid/pipes@alpha` — a bare `npm i @subsquid/pipes` pulls the pre-1.0 `0.1.0-beta.17` (a different API).

```typescript
import { TronQueryBuilder, tronPortalStream } from '@subsquid/pipes/tron'

const stream = tronPortalStream({
  id: 'tron-usdt-transfers',
  portal: 'https://portal.sqd.dev/datasets/tron-mainnet',
  outputs: new TronQueryBuilder()
    .addFields({
      block: { number: true, hash: true, timestamp: true },
      transaction: { transactionIndex: true, hash: true, energyUsageTotal: true, result: true },
      log: { transactionIndex: true, logIndex: true, address: true, topics: true, data: true },
    })
    .addTriggerSmartContractTransaction({
      request: {
        contract: ['41a614f803b6fd780986a42c78ec9c7f77e6ded13c'],  // USDT — bare hex, no 0x
        sighash: ['a9059cbb'],                                     // transfer(address,uint256)
        logs: true,
      },
      range: { from: 84_000_000 },
    }),
})
```

Request methods: `addTransaction` (by Tron contract `type`), `addTransferTransaction` (native TRX), `addTransferAssetTransaction` (TRC-10), `addTriggerSmartContractTransaction` (contract calls), `addLog`, `addInternalTransaction`, `includeAllBlocks`.

**Critical Tron facts:**
- All hex is **bare** (no `0x` prefix); transaction-level addresses are 21-byte `41…` hex (not base58 `T…`), while **log addresses use the 20-byte EVM-style form without `41`**
- Timestamps are Unix **milliseconds**
- Amounts arrive as decimal strings surfaced as `bigint`; TRX values in SUN (1 TRX = 1e6 SUN)
- Log topics are 32-byte padded — Tron address = `'41' + topic.slice(-40)`
- No decoder/typegen layer yet: decode log topics/data manually (TVM event hashing matches EVM keccak256, so ERC-20-style topic0 values apply)

Full example: `docs/examples/tron/01.trc20-transfers.example.ts` in the [pipes-sdk repo](https://github.com/subsquid-labs/pipes-sdk).

## Bitcoin (No CLI Template)

The Pipes SDK supports Bitcoin natively via `@subsquid/pipes/bitcoin`, but the CLI cannot scaffold Bitcoin projects — set up manually. Install the SDK with `npm i @subsquid/pipes@alpha` — a bare `npm i @subsquid/pipes` pulls the pre-1.0 `0.1.0-beta.17` (a different API).

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
      range: { from: 900_000 },
    }),
})
```

Request methods: `addTransaction` (`{inputs, outputs}` relation flags), `addInput` (by `type`/`prevoutScriptPubKeyAddress`/`prevoutScriptPubKeyType`), `addOutput` (by `scriptPubKeyAddress`/`scriptPubKeyType`), `includeAllBlocks`.

**Critical Bitcoin facts:**
- Values are **BTC floats** (Bitcoin Core convention), not satoshis — multiply by 1e8 for sats
- `scriptPubKeyType` gives the standard script classification (`pubkeyhash`, `witness_v0_keyhash`, `witness_v1_taproot`, `nulldata`, …)
- Coinbase inputs carry a `coinbase` hex field and no `txid`/`vout`/prevout data
- Test helpers available at `@subsquid/pipes/testing/bitcoin`

Full example: `docs/examples/bitcoin/01.utxo-decoder.example.ts` in the [pipes-sdk repo](https://github.com/subsquid-labs/pipes-sdk).

## Hyperliquid Fills (No CLI Template)

The Pipes SDK supports Hyperliquid fills natively via `@subsquid/pipes/hyperliquid`, but there is **no CLI template yet**. Scaffold manually and install the SDK with `npm i @subsquid/pipes@alpha` — a bare `npm i @subsquid/pipes` pulls the pre-1.0 `0.1.0-beta.17` (a different API). See [HYPERLIQUID_GUIDE.md](HYPERLIQUID_GUIDE.md) for the complete walkthrough.

Quick pattern:
```typescript
import { hyperliquidFillsPortalStream, hyperliquidFillsQuery } from '@subsquid/pipes/hyperliquid'

const query = hyperliquidFillsQuery()
  .addRange({ from: 920000000 })
  .addFields({
    block: { number: true, timestamp: true },
    fill: { user: true, coin: true, px: true, sz: true, side: true, dir: true,
            closedPnl: true, fee: true, feeToken: true, crossed: true, startPosition: true },
  })
  .addFill({ range: { from: 920000000 }, request: { coin: ['BTC', 'ETH', 'SOL'] } })

await hyperliquidFillsPortalStream({
  id: 'hl-perps-fills',
  portal: 'https://portal.sqd.dev/datasets/hyperliquid-fills',
  outputs: query,
})
```

**Critical:** `.addFill()` requires a `range` — omitting it crashes. Dataset starts at block **750,000,000**. Blocks increment at ~1/second, so `current_block - (days × 86400)` estimates a start.

## Supported Sinks

CLI-scaffolded sinks:
- **ClickHouse** — high-performance analytics (recommended)
- **PostgreSQL** — relational with Drizzle ORM

**Memory sink** is listed in the schema but not yet implemented in the CLI.

SDK-only targets (wire manually with `.pipeTo(...)` — see [SDK_FEATURES.md](SDK_FEATURES.md#target-configuration)):
- **BigQuery** — `@subsquid/pipes/targets/bigquery`, auto-created partitioned tables, fork-safe DELETEs
- **Parquet** — `@subsquid/pipes/targets/parquet`, finalized-only rotating files for DuckDB/Spark/Athena
