# EVM Event Logs — Query Reference

## Query Structure

Portal Stream API uses POST requests with JSON payloads to `/datasets/{dataset-name}/stream`.

**Basic EVM log query structure:**

```json
{
  "type": "evm",
  "fromBlock": 19500000,
  "toBlock": 19500100,
  "logs": [{
    "address": ["0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"],
    "topic0": ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"]
  }],
  "fields": {
    "log": {
      "address": true,
      "topics": true,
      "data": true,
      "transactionHash": true
    }
  }
}
```

**Field explanations:**
- `type: "evm"` - **Required for EVM chains**
- `fromBlock/toBlock` - Block range (required)
- `logs` - Array of log filter objects
- `address` - Contract addresses to filter (INDEXED - fast)
- `topic0` - Event signature hash (INDEXED - fast)
- `topic1/2/3` - Indexed event parameters (INDEXED - fast)
- `fields` - Which fields to include in response

---

## Understanding Event Topics

**EVM event logs use topics for indexed parameters:**

```solidity
event Transfer(address indexed from, address indexed to, uint256 amount);
```

**Maps to:**
- `topic0` = keccak256("Transfer(address,address,uint256)") = `0xddf252ad...`
- `topic1` = indexed `from` address (padded to 32 bytes)
- `topic2` = indexed `to` address (padded to 32 bytes)
- `data` = non-indexed parameters (`amount`)

**Key rules:**
1. `topic0` is ALWAYS the event signature hash
2. `topic1-3` are indexed parameters in declaration order
3. Non-indexed parameters go in `data` field (not filterable)

**Addresses in topics must be padded to 32 bytes:**
```
Original: 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045
Padded:   0x000000000000000000000000d8dA6BF26964aF9D7eEd9e03E53415D37aA96045
```

---

## Examples

### Example 1: Track USDC Transfers on Base

```json
{
  "type": "evm",
  "fromBlock": 10000000,
  "toBlock": 10000100,
  "logs": [{
    "address": ["0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"],
    "topic0": ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"]
  }],
  "fields": {
    "log": {
      "address": true,
      "topics": true,
      "data": true,
      "transactionHash": true
    },
    "block": {"number": true}
  }
}
```

**Dataset:** `base-mainnet` | **Contract:** USDC on Base | **Event:** Transfer(address indexed from, address indexed to, uint256 amount)

---

### Example 2: Find Transfers FROM Specific Address

```json
{
  "type": "evm",
  "fromBlock": 19500000,
  "logs": [{
    "topic0": ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"],
    "topic1": ["0x000000000000000000000000d8da6bf26964af9d7eed9e03e53415d37aa96045"]
  }],
  "fields": {
    "log": {
      "address": true,
      "topics": true,
      "data": true
    }
  }
}
```

**Notes:** `topic1` = sender address (padded to 32 bytes). Omitting `address` filter searches ALL contracts.

---

### Example 3: Uniswap V3 Swap Events

```json
{
  "type": "evm",
  "fromBlock": 19500000,
  "toBlock": 19500100,
  "logs": [{
    "address": ["0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640"],
    "topic0": ["0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67"]
  }],
  "fields": {
    "log": {
      "address": true,
      "topics": true,
      "data": true,
      "transactionHash": true
    },
    "block": {"number": true}
  }
}
```

**Dataset:** `ethereum-mainnet` | **Contract:** USDC/WETH 0.05% pool
**Event:** Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)

---

### Example 4: Multiple Event Types from Same Contract

```json
{
  "type": "evm",
  "fromBlock": 19500000,
  "logs": [
    {
      "address": ["0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2"],
      "topic0": ["0xde6857219544bb5b7746f48ed30be6386fefc61b2f864cacf559893bf50fd951"]
    },
    {
      "address": ["0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2"],
      "topic0": ["0x3115d1449a7b732c986cba18244e897a450f61e1bb8d589cd2e69e6c8924f9f7"]
    }
  ],
  "fields": {
    "log": {
      "address": true,
      "topics": true,
      "data": true
    }
  }
}
```

**Contract:** Aave V3 Pool | **Events:** Deposit + Withdraw
**Notes:** Multiple filter objects in `logs` array = OR logic (both events returned)

---

## More Examples

### Example 5: NFT Transfers to Specific Address

**Use case:** Track NFT transfers to a specific wallet address.

```json
{
  "type": "evm",
  "fromBlock": 17000000,
  "toBlock": 17001000,
  "logs": [{
    "address": ["0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D"],
    "topic0": ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"],
    "topic2": ["0x000000000000000000000000742d35cc6634c0532925a3b844bc454e4438f44e"]
  }],
  "fields": {
    "log": {
      "address": true,
      "topics": true,
      "data": true,
      "transactionHash": true
    },
    "block": {
      "number": true
    }
  }
}
```

**Dataset:** `ethereum-mainnet`
**Contract:** Bored Ape Yacht Club
**Event:** Transfer(address indexed from, address indexed to, uint256 indexed tokenId)
**Notes:**
- ERC721 Transfer events have 3 indexed parameters: `from`, `to`, `tokenId`
- `topic1` = from address, `topic2` = to address, `topic3` = token ID
- Compare with ERC20: only 2 indexed parameters (`from`, `to`), amount is in `data`

---

### Example 6: Query Multiple ERC-20 Tokens Simultaneously

**Use case:** Track transfers across multiple stablecoins (USDC, USDT, DAI) in one query.

```json
{
  "type": "evm",
  "fromBlock": 18000000,
  "toBlock": 18010000,
  "logs": [{
    "address": [
      "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      "0xdAC17F958D2ee523a2206206994597C13D831ec7",
      "0x6B175474E89094C44Da98b954EedeAC495271d0F"
    ],
    "topic0": ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"]
  }],
  "fields": {
    "block": {
      "number": true,
      "timestamp": true
    },
    "log": {
      "address": true,
      "topics": true,
      "data": true,
      "transactionHash": true
    }
  }
}
```

**Dataset:** `ethereum-mainnet`
**Contracts:** USDC, USDT, DAI
**Notes:** Multiple addresses in array = OR logic; efficient way to track multiple tokens without separate queries.

---

### Example 7: Monitor NFT Minting Events

**Use case:** Capture NFT creation events (transfers from zero address).

```json
{
  "type": "evm",
  "fromBlock": 18000000,
  "toBlock": 18010000,
  "logs": [{
    "address": ["0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D"],
    "topic0": ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"],
    "topic1": ["0x0000000000000000000000000000000000000000000000000000000000000000"]
  }],
  "fields": {
    "log": {
      "address": true,
      "topics": true,
      "transactionHash": true
    },
    "block": {
      "number": true
    }
  }
}
```

**Dataset:** `ethereum-mainnet`
**Contract:** Bored Ape Yacht Club
**Notes:**
- Minting is represented as a transfer from the zero address
- `topic1` = zero address (0x000...000 padded to 32 bytes)
- `topic2` = recipient address (minter)

---

### Example 8: Track ERC-1155 Multi-Token Transfers

**Use case:** Monitor ERC-1155 TransferSingle and TransferBatch events.

```json
{
  "type": "evm",
  "fromBlock": 18000000,
  "toBlock": 18010000,
  "logs": [{
    "address": ["0x495f947276749Ce646f68AC8c248420045cb7b5e"],
    "topic0": [
      "0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62",
      "0x4a39dc06d4c0dbc64b70af90fd698a233a518aa5d07e595d983b8c0526c8f7fb"
    ]
  }],
  "fields": {
    "log": {
      "address": true,
      "topics": true,
      "data": true
    }
  }
}
```

**Dataset:** `ethereum-mainnet`
**Contract:** OpenSea Shared Storefront (ERC-1155)
**Event Signatures:**
- TransferSingle: `0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62`
- TransferBatch: `0x4a39dc06d4c0dbc64b70af90fd698a233a518aa5d07e595d983b8c0526c8f7fb`

---

### Example 9: Monitor Multiple NFT Collections

**Use case:** Track transfers across popular NFT collections (BAYC, MAYC, CryptoPunks).

```json
{
  "type": "evm",
  "fromBlock": 18000000,
  "toBlock": 18010000,
  "logs": [{
    "address": [
      "0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D",
      "0x60E4d786628Fea6478F785A6d7e704777c86a7c6",
      "0xb47e3cd837dDF8e4c57F05d70Ab865de6e193BBB"
    ],
    "topic0": ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"]
  }],
  "fields": {
    "block": {
      "number": true,
      "timestamp": true
    },
    "log": {
      "address": true,
      "topics": true,
      "transactionHash": true
    }
  }
}
```

**Dataset:** `ethereum-mainnet`
**Contracts:** BAYC, MAYC, CryptoPunks

---

## Filter Performance

**Field index status:**
- `address` - INDEXED (fast) - always add if you know the contract
- `topic0` - INDEXED (fast) - add for specific events
- `topic1/2/3` - INDEXED (fast) - add for further narrowing
- `data` - NOT INDEXED (cannot filter)

**Best practices:**
1. Always filter by `address` if known (10-100x faster)
2. Add `topic0` for specific events (another 10x faster)
3. Add topic1-3 filters for further narrowing
4. Use narrow block ranges when possible

---

## Log Response Fields

```json
{
  "logIndex": true,        // Position in block
  "transactionIndex": true,// Transaction position in block
  "transactionHash": true, // Tx hash
  "address": true,         // Contract address
  "data": true,            // Event data (non-indexed params, ABI-encoded)
  "topics": true           // All topics array [topic0, topic1, topic2, topic3]
}
```

**Note:** `topics` returns all topics as an array. Request only needed fields to reduce response size.

---

## Common Mistakes

### Filtering by Non-Indexed Parameter

```json
{"logs": [{"data": ["0x1234..."]}]}  // WRONG - Can't filter by data
```
**Fix:** Only topic0-3 are filterable. Fetch all events and filter `data` client-side.

---

### Forgetting Topic Padding

```json
{"topic1": ["0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"]}  // WRONG - Not padded
```
**Fix:** Pad addresses to 32 bytes: `"0x000000000000000000000000d8dA6BF26964aF9D7eEd9e03E53415D37aA96045"`

---

### Using Wrong Event Signature

Compute correct keccak256 hash with no spaces and exact types:
```javascript
ethers.id("Transfer(address,address,uint256)")  // correct
ethers.id("Transfer(address, address, uint256)")  // WRONG - spaces cause wrong hash
```

---

### Too Broad Query (No Filters)

```json
{"type": "evm", "fromBlock": 0, "logs": [{}]}  // WRONG - Millions of logs
```
**Fix:** Always filter by at least `address` or `topic0`, and use reasonable block ranges.

---

## Verifying Event Signatures Before Indexing

> Always verify topic0 hashes against actual on-chain data before building an indexer. Computed hashes from ABIs can be wrong for proxy contracts, Diamond proxies (EIP-2535), or contracts that changed event signatures across upgrades.

**Verification workflow:**

1. **Query actual topic0s from the contract** using Portal MCP's `portal_evm_get_contract_activity` or `portal_evm_get_analytics` grouped by topic0
2. **Identify unknowns** — look up topic0 hashes on [4byte.directory](https://www.4byte.directory/) or [openchain.xyz](https://openchain.xyz/signatures)
3. **Cross-reference with source code** — verify parameter types and indexed fields match

**Real-world failures this prevents:**
- wBETH: Computed `Deposit(address,uint256)` hash but actual event was `Deposit(address,address,uint256,uint256)` (extra params)
- Pendle: `SwapYtAndToken` event changed data layout between Router V1 and V3 — older events cause `EventDecodingError` with the current ABI
- Diamond proxies: Multiple facets emit different events through the same address — ABI from one facet misses events from others
