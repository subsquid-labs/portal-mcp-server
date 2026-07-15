# ABI Guide

Reference for fetching, analyzing, and using contract ABIs in Pipes indexers.

## commonAbis (Built-in Standard ABIs)

Import pre-built ABIs for standard token interfaces - no fetching required:

```typescript
import { commonAbis } from "@subsquid/pipes/evm"

// Usage in evmDecoder
events: {
  transfers: commonAbis.erc20.events.Transfer,    // Transfer(from, to, value)
  approvals: commonAbis.erc20.events.Approval,    // Approval(owner, spender, value)
}

// ERC721
events: {
  transfers: commonAbis.erc721.events.Transfer,
}
```

Available in `commonAbis`: `erc20`, `erc721`, `erc1155`

## Fetching ABIs from Block Explorers

For custom/unknown contracts, use the block explorer APIs:

```typescript
// Ethereum mainnet
WebFetch({
  url: `https://api.etherscan.io/api?module=contract&action=getabi&address=${address}`,
  prompt: "Extract the ABI JSON from the result field"
})

// Base mainnet
WebFetch({
  url: `https://api.basescan.org/api?module=contract&action=getabi&address=${address}`,
  prompt: "Extract the ABI JSON from the result field"
})
```

Save to `./abi/<contract_name>.json` then generate TypeScript types:

```bash
npx @subsquid/evm-typegen@latest \
  --abi ./abi/<contract_name>.json \
  --output ./abi/<contract_name>.ts
```

Import and use the generated types:

```typescript
import * as pool from "./abi/pool"

events: {
  swaps: pool.events.Swap,
  mints: pool.events.Mint,
}
```

## Solidity Type → BigInt Mapping

| Solidity Type | Use BigInt? | Notes |
|---------------|-------------|-------|
| `uint256`, `int256` | Always | `.toString()` before storing |
| `uint128`, `uint160`, `uint192`, `uint224` | Always | Too large for native integers |
| `uint64`, `uint96`, `uint112` | Yes | Can be large |
| `uint32`, `uint16`, `uint8` | No | Safe as Number |
| `int24`, `int32` | No | Safe as Number |
| `address` | N/A | Already a string |

## Struct/Tuple Parameters and bytes32

Some DeFi protocols use struct (tuple) parameters in events and `bytes32` identifiers (e.g., Morpho market IDs). The `evm-typegen` tool handles these automatically.

### bytes32 Fields

`bytes32` values are common as identifiers (market IDs, salt values, etc.). They decode to `string` in TypeScript:

```typescript
// In generated ABI
id: indexed(p.bytes32)

// Access in .pipe()
marketId: d.event.id  // string, "0x..." (66 chars)
```

Store as `FixedString(66)` in ClickHouse (same as transaction hashes).

### Struct (Tuple) Parameters

Events can include struct parameters. Typegen generates nested `p.struct()` definitions:

```typescript
// Generated code for Morpho's CreateMarket event
CreateMarket: event(
  '0xac4b2400...',
  'CreateMarket(bytes32,(address,address,address,address,uint256))',
  {
    id: indexed(p.bytes32),
    marketParams: p.struct({
      loanToken: p.address,
      collateralToken: p.address,
      oracle: p.address,
      irm: p.address,
      lltv: p.uint256,
    }),
  },
)

// Access in .pipe()
d.event.marketParams.loanToken       // address string
d.event.marketParams.lltv.toString() // BigInt → String
```

## Proxy Contract Detection and Handling

Many major DeFi protocols use proxy contracts (e.g., Aave V3 Pool, Lido stETH, upgradeable vaults). **Both the CLI and `evm-typegen` fetch the proxy ABI, NOT the implementation ABI.** This is the #1 cause of "indexer crashes on startup" for custom templates.

### The Failure Mode

When you pass a proxy contract address to the CLI's custom template:
1. CLI fetches the ABI from the block explorer → gets the **proxy ABI** (only `Upgraded`, `admin()`, `implementation()`)
2. Generated `src/contracts/<address>.ts` has only the `Upgraded` event
3. `src/index.ts` references events like `Supply`, `Borrow`, etc. that don't exist
4. Indexer crashes: `TypeError: Cannot read properties of undefined (reading 'topic')`

**`evm-typegen` has the same problem** — it also fetches the proxy ABI, not the implementation.

### How to Detect a Proxy

**Check the generated contract file immediately after CLI generation:**
```bash
grep "export const events" src/contracts/*.ts
# If you see ONLY "Upgraded" for a major protocol → it's a proxy
```

Other signs:
1. Very few events (1-3) for a major protocol that should have many
2. Has `implementation()`, `admin()`, or `upgradeTo()` functions
3. Expected events (Supply, Swap, Deposit, etc.) are completely missing

### How to Fix: Find Implementation Address and Regenerate

**Step 1: Find the implementation address on Etherscan**

Go to the contract page on Etherscan (or the chain's explorer):
```
https://etherscan.io/address/<PROXY_ADDRESS>
```
Look for "Implementation:" near the top of the page, or click the "Read as Proxy" tab. Copy the implementation address.

**Step 2: Generate types from the implementation**

```bash
npx @subsquid/evm-typegen@latest src/contracts \
  <IMPLEMENTATION_ADDRESS> --chain-id <CHAIN_ID>
```

**Step 3: Update the import in `src/index.ts`**

Change the import to point to the implementation's generated file:
```typescript
// BEFORE (proxy — only has Upgraded event)
import { events } from './contracts/0xProxyAddress.js'

// AFTER (implementation — has all protocol events)
import { events } from './contracts/0xImplementationAddress.js'
```

**Important**: Keep the proxy address in the `contracts` array of `evmDecoder`. Events are emitted from the proxy address but use the implementation's event signatures:
```typescript
evmDecoder({
  contracts: ['0xProxyAddress'],  // ← proxy address (where events are emitted)
  events: {
    Supply: implementationEvents.Supply,  // ← implementation ABI (event signatures)
  },
})
```

### Real-World Example: Aave V3 Pool

```bash
# Proxy address (what users interact with):
# 0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2

# CLI/typegen generates only: Upgraded event

# Implementation address (found on Etherscan "Read as Proxy"):
# 0x8147b99df7672a21809c9093e6f6ce1a60f119bd

# Fix:
npx @subsquid/evm-typegen@latest src/contracts \
  0x8147b99df7672a21809c9093e6f6ce1a60f119bd --chain-id 1

# Then update import in src/index.ts
```

### Alternative Approaches

**Option A: Use commonAbis (when events are standard)**

```typescript
import { commonAbis } from "@subsquid/pipes/evm"
events: { transfers: commonAbis.erc20.events.Transfer }
```

**Option B: Define events inline using topic hash**

Find the topic0 hash from the block explorer Events tab, then define inline:

```typescript
import { event, indexed } from '@subsquid/evm-abi'
import * as p from '@subsquid/evm-codec'

const Submitted = event(
  '0x96a25c8ce0baabc1fdefd93e9ed25d8e092a3c2c1e96a9a2a6f3b4e9e8e0c7f3',
  'Submitted(address,uint256,address)',
  { sender: indexed(p.address), amount: p.uint256, referral: p.address },
)

events: { submitted: Submitted }
```

### Common Proxy Contracts in DeFi

| Protocol | Proxy Address | Notes |
|----------|--------------|-------|
| Aave V3 Pool | Chain-specific | EIP-1967 proxy, implementation changes with upgrades |
| Compound V3 (Comet) | Chain-specific | TransparentUpgradeableProxy |
| Lido stETH | `0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84` | AppProxy (Aragon) |
| USDC | `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` | AdminUpgradeabilityProxy |

**Rule of thumb**: If it's a major DeFi protocol on Ethereum, assume it's a proxy until proven otherwise.

## ABI Not Found

If the block explorer returns no ABI:
1. Contract may not be verified - provide the explorer URL for manual inspection
2. Wrong network - try the correct chain's explorer
3. It's a proxy - fetch the implementation ABI instead

## Protocol Research Workflow

For researching unknown protocols before fetching ABIs, see:
- `references/RESEARCH_CHECKLIST.md` in this skill's references directory
