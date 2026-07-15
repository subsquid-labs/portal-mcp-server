# EVM Traces — Query Reference

## Query Structure

**Basic EVM trace query structure:**

```json
{
  "type": "evm",
  "fromBlock": 19500000,
  "toBlock": 19500100,
  "traces": [{
    "type": ["call"],
    "callFrom": ["0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45"],
    "callSighash": ["0x414bf389"]
  }],
  "fields": {
    "trace": {
      "type": true,
      "callFrom": true,
      "callTo": true,
      "callValue": true,
      "callSighash": true
    }
  }
}
```

**Field explanations:**
- `type: "evm"` - **Required for EVM chains**
- `fromBlock/toBlock` - Block range (required)
- `traces` - Array of trace filter objects
- `type` - Trace type: `call`, `create`, `suicide`, `reward`
- Filters vary by trace type (see examples below)

---

## Understanding Trace Types

**EVM has 4 trace types:**

### 1. CALL - Internal Function Calls
Internal contract-to-contract function calls (including ETH transfers).

**INDEXED filter fields:**
- `callFrom` - Caller address (INDEXED)
- `callTo` - Callee address (INDEXED)
- `callSighash` - Function selector (INDEXED)

**Response fields:** `callValue`, `callCallType` (call/staticcall/delegatecall/callcode), `callInput`, `callResultOutput`, `error`

### 2. CREATE - Contract Deployments
Contract creation via CREATE or CREATE2 opcodes.

**INDEXED filter fields:**
- `createFrom` - Deployer address (INDEXED)

> **`createResultAddress` is NOT a supported filter.** Despite being listed in some docs, Portal does not support filtering by deployed contract address. You can only filter by deployer (`createFrom`). To find who deployed a known contract, you must know the deployer address first, or scan without address filters over a narrow block range.

**Response fields:** `createResultAddress` (deployed contract address), `createResultCode` (deployed bytecode), `createValue`

### 3. SUICIDE (SELFDESTRUCT) - Contract Destruction

**INDEXED filter fields:**
- `suicideAddress` - Contract being destroyed (INDEXED)
- `suicideRefundAddress` - Address receiving remaining ETH (INDEXED)

**Response fields:** `suicideBalance`

### 4. REWARD - Block Rewards (historical, not used in PoS chains)

**INDEXED filter fields:** `rewardAuthor` (INDEXED)

---

## Examples

### Example 1: Find Contracts Deployed by Address

```json
{
  "type": "evm",
  "fromBlock": 19000000,
  "toBlock": 19100000,
  "traces": [{
    "type": ["create"],
    "createFrom": ["0x1234567890123456789012345678901234567890"]
  }],
  "fields": {
    "trace": {
      "type": true,
      "createFrom": true,
      "createResultAddress": true,
      "createResultCode": true,
      "createValue": true,
      "transactionIndex": true
    }
  }
}
```

**Dataset:** `ethereum-mainnet`
**Notes:** `createResultAddress` = new contract address; `createResultCode` = deployed (runtime) bytecode

---

### Example 2: Track Internal ETH Transfers

```json
{
  "type": "evm",
  "fromBlock": 19500000,
  "toBlock": 19500100,
  "traces": [{
    "type": ["call"],
    "callFrom": ["0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D"]
  }],
  "fields": {
    "trace": {
      "type": true,
      "callFrom": true,
      "callTo": true,
      "callValue": true,
      "callCallType": true,
      "error": true
    }
  }
}
```

**Dataset:** `ethereum-mainnet` | **Contract:** Uniswap V2 Router
**Notes:** `error: null` = success; `callValue` shows ETH transferred

---

## More Examples

### Example 3: Monitor Delegatecall Patterns (Proxy Contracts)

**Use case:** Track delegatecall operations for proxy pattern analysis.

```json
{
  "type": "evm",
  "fromBlock": 19500000,
  "toBlock": 19500100,
  "traces": [{
    "type": ["call"]
  }],
  "fields": {
    "trace": {
      "type": true,
      "callFrom": true,
      "callTo": true,
      "callSighash": true,
      "callCallType": true
    }
  }
}
```

**Notes:**
- `callCallType` is NOT a valid filter field; filter by `type: ["call"]` and then filter for `callCallType == "delegatecall"` client-side
- `callFrom` = proxy contract, `callTo` = implementation contract

---

### Example 4: Find CREATE2 Deployments

**Use case:** Track deterministic contract deployments (CREATE2).

```json
{
  "type": "evm",
  "fromBlock": 19500000,
  "traces": [{
    "type": ["create"],
    "createResultAddress": ["0x1234567890123456789012345678901234567890"]
  }],
  "fields": {
    "trace": {
      "type": true,
      "createFrom": true,
      "createResultAddress": true,
      "createValue": true,
      "transactionIndex": true
    }
  }
}
```

**Notes:**
- Cannot directly filter by CREATE vs CREATE2 (both have type "create")
- Use `createResultAddress` to find specific contract deployment
- Check transaction input for CREATE2 opcode (0xf5)

---

### Example 5: Track Multi-Hop Swaps (MEV Analysis)

**Use case:** Analyze complex swap paths (e.g., Token A -> B -> C).

```json
{
  "type": "evm",
  "fromBlock": 19500000,
  "toBlock": 19500100,
  "traces": [{
    "type": ["call"],
    "callSighash": ["0x022c0d9f"]
  }],
  "fields": {
    "trace": {
      "type": true,
      "callFrom": true,
      "callTo": true,
      "callSighash": true,
      "callInput": true,
      "callResultOutput": true
    }
  }
}
```

**Dataset:** `ethereum-mainnet`
**Function:** `swap(uint256,uint256,address,bytes)` on Uniswap V2 pairs
**Notes:**
- Multiple traces per transaction = multi-hop swap
- `callFrom` = calling contract (router or previous pair)

---

### Example 6: Contract Self-Destruct Tracking

**Use case:** Monitor contracts being destroyed (rare but important).

```json
{
  "type": "evm",
  "fromBlock": 19000000,
  "toBlock": 19500000,
  "traces": [{
    "type": ["suicide"],
    "suicideRefundAddress": ["0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"]
  }],
  "fields": {
    "trace": {
      "type": true,
      "suicideAddress": true,
      "suicideRefundAddress": true,
      "suicideBalance": true,
      "transactionIndex": true
    }
  }
}
```

**Notes:**
- `suicideAddress` = contract being destroyed
- `suicideRefundAddress` = recipient of remaining ETH
- Post-Merge: selfdestruct is deprecated but still functional

---

## Call Types Reference

**4 call types in EVM:**

**1. `call` (most common):**
- Normal external function call; can transfer ETH; called contract executes in its own context

**2. `staticcall`:**
- Read-only call; cannot modify state or transfer ETH; used for view/pure functions

**3. `delegatecall`:**
- Execute code in caller's context; used for proxy patterns; storage changes affect caller, not callee

**4. `callcode` (deprecated):**
- Legacy version of delegatecall; rarely used in modern contracts

---

## Trace Position and Ordering

**Traces include position fields:**
- `traceAddress` - Array indicating position in call tree
- `transactionIndex` - Position of transaction in block
- `subtraces` - Number of child traces

**Example trace tree:**
```
Transaction 0
|- Trace [0] - Router.swap()
|  |- Trace [0, 0] - Pair.swap()
|  |  \- Trace [0, 0, 0] - Token.transfer()
|  \- Trace [0, 1] - Another internal call
\- Trace [1] - Parallel call
```

**`traceAddress` values:**
- `[]` - Top-level call (transaction itself)
- `[0]` - First internal call
- `[0, 0]` - First call within first call
- `[0, 1]` - Second call within first call

---

## Trace vs Transaction

**Transactions** = top-level operations submitted to the blockchain
**Traces** = all operations executed within transactions (including internal calls)

```
Transaction: User calls Uniswap Router.swap()
|- Trace 1: Router calls Pair.swap() [internal call]
|- Trace 2: Pair calls Token.transfer() [internal call]
\- Trace 3: Pair transfers ETH [internal ETH transfer]
```

**Key insight:** One transaction can generate dozens of traces.

---

## Trace Fields Reference

**Common fields available across trace types:**
- `type` - Trace type (call/create/suicide/reward)
- `transactionIndex` - Position of transaction in block
- `traceAddress` - Array indicating position in call tree (e.g., `[0, 1]`)
- `subtraces` - Number of child traces
- `error` - Error message (null = success)
- `revertReason` - Decoded revert reason (if available)

**Response structure note:** The response uses nested `action` and `result` objects:
- `callFrom` -> `action.from`, `callTo` -> `action.to`
- `callCallType` -> `action.callType`
- `createResultAddress` -> `result.address`
- `callResultOutput` -> `result.output`

---

## Common Mistakes

### Using Transaction Filters for Internal Calls

```json
{"transactions": [{"to": ["0x..."]}]}  // Misses internal calls
```
**Fix:** Use `traces` with `callTo` to capture internal calls.

---

### Filtering CREATE by Wrong Field

```json
{"traces": [{"type": ["create"], "callFrom": ["0x..."]}]}  // Wrong field
```
**Fix:** Use `createFrom` for CREATE traces (not `callFrom`).

---

### Ignoring Trace Type

```json
{"traces": [{"callFrom": ["0x..."]}]}  // No type specified
```
**Fix:** Always specify `"type": ["call"]` (or "create", "suicide").

---

### Confusing Creation Bytecode with Runtime Bytecode

`createResultCode` = deployed (runtime) bytecode. To get creation bytecode, query `transaction.input`.

---

## Performance Tips

**Traces are high-volume data** - complex DeFi transactions can generate 100+ traces.

**Filter selectivity (best to worst):**
1. Specific address + type + sighash (best)
2. Specific address + type
3. Type only (broad)
4. No filters (avoid)

### Block Range Limits for CREATE Traces

> **Keep CREATE trace queries to <=50K blocks per request.** Larger ranges (e.g., 500K blocks) cause Portal to silently drop results from the ndjson stream. This was discovered empirically -- queries return partial data without errors. Chunk your queries and aggregate results.

### Multi-Address Filter Gotcha

When filtering `createFrom` with multiple addresses, high-volume deployers (e.g., factory contracts deploying thousands of pools) dominate the response and traces from other deployers may get lost. **Query each deployer address individually** for comprehensive results.

**Avoid:**
```json
{"fromBlock": 0, "toBlock": 19500000, "traces": [{}]}  // Billions of traces
```

---

## Use Case: Contract Deployment Registry

CREATE traces are the definitive source for contract deployment data. Use them to build contract registries, verify deployment blocks, and discover new protocol contracts.

### Tracking Deployments from Known Deployers

Query all contracts deployed by a specific protocol's deployer address:

```json
{
  "type": "evm",
  "fromBlock": 15500000,
  "toBlock": 17500000,
  "traces": [{
    "type": ["create"],
    "createFrom": [
      "0x54705f80d7c51fcffd9c659ce3f3c9a7dccf5788",
      "0x2f39d218133afab8f2b819b1066c7e434ad94e9e"
    ]
  }],
  "fields": {
    "block": { "number": true, "timestamp": true },
    "trace": {
      "transactionIndex": true,
      "createFrom": true,
      "createResultAddress": true
    }
  }
}
```

**Real-world results (tested):**
- Rocket Pool minipool factory: 608 contract deployments discovered across blocks 15.5M-17M
- Aave V3 PoolAddressesProvider: Pool proxy deployment at block 16291127 correctly identified
- Compound V3 Comet Factory: new market deployments captured

### Key Learnings

**Response field names are nested:**
```json
{
  "traces": [{
    "transactionIndex": 157,
    "action": { "from": "0xDeployer..." },
    "result": { "address": "0xNewContract..." }
  }]
}
```
Access deployer as `trace.action.from` and new contract as `trace.result.address` (NOT `trace.createFrom` or `trace.createResultAddress` -- those are request filter names, not response field names).

**No `transactionHash` on traces** -- only `transactionIndex`. To get the tx hash, include the transaction in your query or look it up separately.

**Factory-deployed contracts:** Many DeFi protocols deploy via factory contracts (Uniswap, Morpho, Euler). The `createFrom` is the factory contract, not the protocol's EOA deployer. To track these, filter by the factory's address as `createFrom`.

**CREATE2 deterministic deployments:** These also appear as `type: "create"` traces. The deployer address will be the factory using CREATE2. Same query pattern works.
