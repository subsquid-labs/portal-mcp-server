# EVM Transactions — Query Reference

## Query Structure

**Basic EVM transaction query structure:**

```json
{
  "type": "evm",
  "fromBlock": 19500000,
  "toBlock": 19500100,
  "transactions": [{
    "to": ["0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45"],
    "sighash": ["0x414bf389"]
  }],
  "fields": {
    "transaction": {
      "hash": true,
      "from": true,
      "to": true,
      "value": true,
      "input": true,
      "status": true
    }
  }
}
```

**Field explanations:**
- `type: "evm"` - **Required for EVM chains** (not "solana")
- `fromBlock/toBlock` - Block range (required)
- `transactions` - Array of transaction filter objects
- `to` - Recipient address (INDEXED - fast)
- `from` - Sender address (INDEXED - fast)
- `sighash` - Function selector (first 4 bytes of input, INDEXED)
- `fields` - Which fields to include in response

---

## Understanding Function Selectors (Sighash)

**Sighash = first 4 bytes of keccak256(function signature)**

```javascript
// Using ethers.js
import { ethers } from 'ethers';
const sighash = ethers.id("swap(uint256,address[])").slice(0, 10);
// Result: "0x414bf389"
```

**Key rules:**
1. Sighash is first 4 bytes of transaction `input` data
2. Computed from function name + parameter types (no spaces, no names)
3. INDEXED field - fast to query

---

## Examples

### Example 1: Track Wallet Outgoing Transactions

```json
{
  "type": "evm",
  "fromBlock": 19500000,
  "toBlock": 19500100,
  "transactions": [{
    "from": ["0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"]
  }],
  "fields": {
    "transaction": {
      "hash": true,
      "from": true,
      "to": true,
      "value": true,
      "gasUsed": true,
      "status": true
    },
    "block": {
      "number": true,
      "timestamp": true
    }
  }
}
```

**Dataset:** `ethereum-mainnet` | **Use case:** Track vitalik.eth transaction activity
**Notes:** `value` is in wei (divide by 1e18 for ETH); `status: 1` = success, `0` = failed (response field, not filter)

---

### Example 2: Find Uniswap V3 Router Swap Calls

```json
{
  "type": "evm",
  "fromBlock": 19500000,
  "toBlock": 19500100,
  "transactions": [{
    "to": ["0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45"],
    "sighash": ["0x414bf389"],
    "logs": true
  }],
  "fields": {
    "transaction": {
      "hash": true,
      "from": true,
      "to": true,
      "value": true,
      "input": true,
      "status": true
    },
    "log": {
      "address": true,
      "topics": true,
      "data": true
    }
  }
}
```

**Dataset:** `ethereum-mainnet` | **Contract:** Uniswap V3 SwapRouter02
**Notes:** `"logs": true` in the transaction filter automatically fetches logs emitted by matched transactions

---

### Example 3: Filter by ERC-20 Transfer Function

```json
{
  "type": "evm",
  "fromBlock": 18000000,
  "toBlock": 18010000,
  "transactions": [{
    "to": ["0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"],
    "sighash": ["0xa9059cbb"]
  }],
  "fields": {
    "transaction": {
      "hash": true,
      "from": true,
      "to": true,
      "input": true,
      "status": true
    }
  }
}
```

**Dataset:** `ethereum-mainnet` | **Contract:** USDC | **Function:** `transfer(address,uint256)` | **Sighash:** `0xa9059cbb`

---

## More Examples

### Example 4: Query Transactions to USDT Contract

**Use case:** Retrieve all transactions sent to USDT contract with comprehensive metadata.

```json
{
  "type": "evm",
  "fromBlock": 18000000,
  "toBlock": 18010000,
  "transactions": [{
    "to": ["0xdAC17F958D2ee523a2206206994597C13D831ec7"]
  }],
  "fields": {
    "block": {
      "number": true,
      "timestamp": true
    },
    "transaction": {
      "hash": true,
      "from": true,
      "to": true,
      "value": true,
      "input": true,
      "gasUsed": true,
      "status": true
    }
  }
}
```

**Dataset:** `ethereum-mainnet`
**Contract:** Tether USD (USDT)
**Notes:** Including block fields enables temporal analysis; captures all interaction types.

---

### Example 5: Monitor Contract Deployments by Address

**Use case:** Find all contracts deployed by a specific deployer address.

```json
{
  "type": "evm",
  "fromBlock": 19000000,
  "toBlock": 19100000,
  "transactions": [{
    "from": ["0x1234567890123456789012345678901234567890"],
    "to": []
  }],
  "fields": {
    "transaction": {
      "hash": true,
      "from": true,
      "contractAddress": true,
      "input": true
    }
  }
}
```

**Notes:**
- `to: []` filters for contract creation transactions
- `contractAddress` field contains the deployed contract address
- `input` contains the contract bytecode

---

### Example 6: Track Transactions and Filter by Status Client-Side

**Use case:** Find failed transactions to a specific contract.

```json
{
  "type": "evm",
  "fromBlock": 19500000,
  "toBlock": 19500100,
  "transactions": [{
    "to": ["0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D"]
  }],
  "fields": {
    "transaction": {
      "hash": true,
      "from": true,
      "to": true,
      "value": true,
      "gasUsed": true,
      "status": true
    }
  }
}
```

**Dataset:** `ethereum-mainnet`
**Contract:** Uniswap V2 Router
**Notes:**
- `status` is NOT a valid filter field - only available as a response field
- Filter client-side: `status === 0` = failed, `status === 1` = success

---

### Example 7: Multi-Function Call Tracking

**Use case:** Track multiple function types on the same contract.

```json
{
  "type": "evm",
  "fromBlock": 19500000,
  "transactions": [
    {
      "to": ["0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D"],
      "sighash": ["0x38ed1739"]
    },
    {
      "to": ["0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D"],
      "sighash": ["0x8803dbee"]
    }
  ],
  "fields": {
    "transaction": {
      "hash": true,
      "from": true,
      "input": true,
      "value": true
    }
  }
}
```

**Contract:** Uniswap V2 Router
**Functions:**
- `0x38ed1739` = `swapExactTokensForTokens(...)`
- `0x8803dbee` = `swapTokensForExactTokens(...)`

**Notes:** Multiple filter objects = OR logic (both function types returned)

---

### Example 8: Incoming Transactions with Related Data

**Use case:** Track all transactions TO a contract with their logs and traces.

```json
{
  "type": "evm",
  "fromBlock": 19500000,
  "toBlock": 19500100,
  "transactions": [{
    "to": ["0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"],
    "logs": true,
    "traces": true
  }],
  "fields": {
    "transaction": {
      "hash": true,
      "from": true,
      "to": true,
      "value": true,
      "gasUsed": true
    },
    "log": {
      "address": true,
      "topics": true,
      "data": true
    },
    "trace": {
      "type": true,
      "callFrom": true,
      "callTo": true,
      "callValue": true
    }
  }
}
```

**Dataset:** `ethereum-mainnet`
**Contract:** USDC token contract
**Notes:**
- `"logs": true` and `"traces": true` in the filter fetch related data for matched transactions
- Must also request the corresponding fields in the `fields` section

---

## Transaction Filter Fields

**Valid filter fields:**
- `from` - Transaction sender address (INDEXED - fast)
- `to` - Transaction recipient address (INDEXED - fast)
- `sighash` - Function selector, first 4 bytes of input (INDEXED - fast)
- `firstNonce` - Minimum nonce value (range filter)
- `lastNonce` - Maximum nonce value (range filter)
- `logs` - Boolean, include related logs for matched transactions
- `traces` - Boolean, include related traces for matched transactions
- `stateDiffs` - Boolean, include related state diffs for matched transactions

**Important:** `status` is NOT a valid filter field. It is only available as a response field. Filter by status client-side.

---

## Transaction Response Fields

```json
{
  "hash": true,              // Transaction hash
  "transactionIndex": true,  // Position in block
  "from": true,              // Sender address
  "to": true,                // Recipient address (null for contract creation)
  "input": true,             // Transaction input data (calldata)
  "value": true,             // ETH value in wei
  "nonce": true,             // Sender nonce
  "gas": true,               // Gas limit
  "gasUsed": true,           // Gas actually used
  "gasPrice": true,          // Legacy gas price
  "maxFeePerGas": true,      // EIP-1559 max fee
  "maxPriorityFeePerGas": true, // EIP-1559 priority fee
  "contractAddress": true,   // Deployed contract address (if creation)
  "type": true,              // Transaction type (0, 1, 2)
  "status": true,            // 1 = success, 0 = failed
  "sighash": true,           // Function selector
  "chainId": true            // Chain ID
}
```

---

## Related Data Joins (logs, traces, stateDiffs)

Add `logs`, `traces`, or `stateDiffs` boolean fields **inside each transaction filter object** to automatically fetch related data:

```json
{
  "transactions": [{
    "to": ["0x..."],
    "logs": true,       // Include logs emitted by this transaction
    "traces": true,     // Include internal calls
    "stateDiffs": true  // Include storage changes
  }]
}
```

**Important:** Must also request the corresponding fields in the `fields` section.

**Contract creation:** Use `"to": []` (empty array) to filter for deployment transactions. The `contractAddress` field contains the new contract address.

---

## Common Mistakes

### Filtering by Input Data Directly

```json
{"transactions": [{"input": ["0x414bf389..."]}]}  // Not filterable
```
**Fix:** Use `"sighash": ["0x414bf389"]`

---

### Expecting Related Data Without Requesting It in the Filter

```json
{
  "transactions": [{"to": ["0x..."]}],
  "fields": {"log": {"topics": true}}  // Logs won't be included
}
```
**Fix:** Add `"logs": true` inside the transaction filter object.

---

### Forgetting Block Range

```json
{"type": "evm", "transactions": [{"to": ["0x..."]}]}  // No fromBlock/toBlock
```
**Fix:** Always specify `fromBlock` and `toBlock`.

---

### Querying Too Many Transactions

```json
{"fromBlock": 0, "toBlock": 19500000, "transactions": [{}]}  // Millions of txs
```
**Fix:** Always add address/sighash filters and reasonable block ranges (100-100,000 blocks).
