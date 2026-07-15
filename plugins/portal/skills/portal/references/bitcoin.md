# Bitcoin — Query Reference

## Query Structure

Portal Stream API uses POST requests to `/datasets/bitcoin-mainnet/stream`.

**Basic Bitcoin query structure:**

```json
{
  "type": "bitcoin",
  "fromBlock": 942000,
  "toBlock": 942010,
  "transactions": [{}],
  "fields": {
    "block": {"number": true, "hash": true, "timestamp": true},
    "transaction": {"txid": true, "size": true, "vsize": true}
  }
}
```

**Field explanations:**
- `type: "bitcoin"` — **Required** (not "evm" or "solana")
- `fromBlock/toBlock` — Block range (dataset starts at block 0, current ~957K; check `GET /datasets/bitcoin-mainnet/head`)
- Data keys: `transactions`, `inputs`, `outputs` — arrays of filter objects
- Fields keys: `block`, `transaction`, `input`, `output`
- `includeAllBlocks` (boolean, optional) — When omitted, a query with no matching data selector returns only the **first and last** block of the range. Set `true` to receive every block header in the range.

---

## Response Shape

The stream returns NDJSON — one JSON record per block:

```json
{
  "header":       {"number": 942000, "hash": "…", "timestamp": 1774354883},
  "transactions": [{"transactionIndex": 0, "txid": "…"}],
  "inputs":       [{"transactionIndex": 0, "inputIndex": 0}],
  "outputs":      [{"transactionIndex": 0, "outputIndex": 0, "value": 3.125}]
}
```

- Block fields arrive under **`.header`**, not `.block` — `block` is only the *field-selector* name.
- `inputs` and `outputs` are **flat, block-level arrays**, NOT nested inside each transaction. Correlate an input/output to its transaction via `transactionIndex` (plus `inputIndex`/`outputIndex`). This is what makes the fee computation below work.
- Every stream response includes the **first and last block of the requested range** as header-only records even when they contain no matching data. When iterating results, skip records whose `transactions`/`inputs`/`outputs` arrays are empty.

---

## Data Keys & Filters

### Transactions

Filter key: `transactions`

No filter fields for matching — use `[{}]` to match all transactions. Two relation flags pull nested data for each matched transaction:

| Flag | Type | Effect |
|---|---|---|
| `inputs` | boolean | Include all inputs of each matched transaction |
| `outputs` | boolean | Include all outputs of each matched transaction |

```json
{"transactions": [{"inputs": true, "outputs": true}]}
```

Alternatively, filter from the other direction: use `inputs`/`outputs` filters with `transaction: true` to pull the parent transactions.

### Inputs

Filter key: `inputs`

| Filter Field | Type | Description |
|---|---|---|
| `type` | string[] | Input type: `"coinbase"` or `"tx"` |
| `prevoutScriptPubKeyAddress` | string[] | Previous output's address (who is spending) |
| `prevoutScriptPubKeyType` | string[] | Previous output's script type |
| `prevoutGenerated` | boolean | Whether the prevout was from a coinbase tx |

### Outputs

Filter key: `outputs`

| Filter Field | Type | Description |
|---|---|---|
| `scriptPubKeyAddress` | string[] | Recipient address |
| `scriptPubKeyType` | string[] | Script type (see below) |

### Script Types (for filtering)

| Type | Description |
|---|---|
| `witness_v0_keyhash` | Native SegWit (P2WPKH) — most common |
| `witness_v1_taproot` | Taproot (P2TR) |
| `pubkeyhash` | Legacy (P2PKH) |
| `scripthash` | P2SH |
| `witness_v0_scripthash` | SegWit P2WSH |
| `nulldata` | OP_RETURN (data outputs, 0 value) |
| `multisig` | Bare multisig |
| `pubkey` | Pay-to-pubkey (P2PK, mostly early blocks) |
| `nonstandard` | Nonstandard scripts |

### Address Prefix → Script Type

| Address starts with | Script type |
|---|---|
| `1…` | `pubkeyhash` (P2PKH) |
| `3…` | `scripthash` (P2SH) |
| `bc1q…` (42 chars) | `witness_v0_keyhash` (P2WPKH) |
| `bc1q…` (62 chars) | `witness_v0_scripthash` (P2WSH) |
| `bc1p…` | `witness_v1_taproot` (P2TR) |

### Relation Flags (on input/output filters)

These boolean flags pull related data when filtering inputs or outputs:

| Flag | On Filter | Effect |
|---|---|---|
| `transaction` | inputs or outputs | Include the parent transaction |
| `transactionInputs` | inputs or outputs | Include all inputs of the parent tx |
| `transactionOutputs` | inputs or outputs | Include all outputs of the parent tx |

**Example:** Find coinbase inputs and get the full coinbase transaction with all outputs:
```json
{
  "inputs": [{"type": ["coinbase"], "transaction": true, "transactionOutputs": true}]
}
```

---

## Examples

### Example 1: Recent Blocks with Metadata

```json
{
  "type": "bitcoin",
  "fromBlock": 942000,
  "toBlock": 942005,
  "includeAllBlocks": true,
  "fields": {
    "block": {
      "number": true, "hash": true, "timestamp": true,
      "size": true, "weight": true, "difficulty": true
    }
  }
}
```

**Dataset:** `bitcoin-mainnet`
**Notes:** Returns block headers for **every** block in the range (requires `includeAllBlocks: true`; without it only the first and last block are returned). No transactions/inputs/outputs. Timestamps are Unix seconds.

---

### Example 2: All Transactions in a Block

```json
{
  "type": "bitcoin",
  "fromBlock": 942000,
  "toBlock": 942000,
  "transactions": [{}],
  "fields": {
    "block": {"number": true, "hash": true, "timestamp": true},
    "transaction": {"txid": true, "size": true, "vsize": true, "weight": true, "version": true, "locktime": true}
  }
}
```

**Notes:** A single block typically has 2000-4000 transactions. Use narrow ranges.

---

### Example 3: Track Payments to an Address

**Use case:** Find all outputs sent to a specific Bitcoin address.

```json
{
  "type": "bitcoin",
  "fromBlock": 940000,
  "toBlock": 942000,
  "outputs": [{
    "scriptPubKeyAddress": ["bc1qxhmdufsvnuaaaer4ynz88fspdsxq2h9e9cetdj"],
    "transaction": true
  }],
  "fields": {
    "block": {"number": true, "timestamp": true},
    "transaction": {"txid": true},
    "output": {"transactionIndex": true, "outputIndex": true, "value": true, "scriptPubKeyAddress": true}
  }
}
```

**Notes:**
- `transaction: true` on the output filter pulls the parent transaction's txid
- Values are in **BTC** (float), not satoshis — e.g., `0.54199819` = 0.542 BTC

---

### Example 4: Track Spending From an Address

**Use case:** Find all inputs that spend UTXOs previously sent to an address.

```json
{
  "type": "bitcoin",
  "fromBlock": 940000,
  "toBlock": 942000,
  "inputs": [{
    "prevoutScriptPubKeyAddress": ["bc1qxhmdufsvnuaaaer4ynz88fspdsxq2h9e9cetdj"],
    "transaction": true
  }],
  "fields": {
    "block": {"number": true, "timestamp": true},
    "transaction": {"txid": true},
    "input": {"transactionIndex": true, "inputIndex": true, "txid": true, "vout": true, "prevoutValue": true, "prevoutScriptPubKeyAddress": true}
  }
}
```

**Notes:**
- `prevoutScriptPubKeyAddress` matches the address of the UTXO being spent
- `txid` + `vout` on the input reference the previous output being consumed
- `prevoutValue` is the value of the spent UTXO (in BTC)

---

### Example 5: Monitor Taproot Activity

**Use case:** Track all Taproot (P2TR) outputs in recent blocks.

```json
{
  "type": "bitcoin",
  "fromBlock": 942000,
  "toBlock": 942005,
  "outputs": [{"scriptPubKeyType": ["witness_v1_taproot"]}],
  "fields": {
    "block": {"number": true, "timestamp": true},
    "output": {"transactionIndex": true, "outputIndex": true, "value": true, "scriptPubKeyType": true, "scriptPubKeyAddress": true}
  }
}
```

---

### Example 6: Coinbase Transactions (Mining Rewards)

**Use case:** Find coinbase transactions and their reward outputs.

```json
{
  "type": "bitcoin",
  "fromBlock": 942000,
  "toBlock": 942010,
  "inputs": [{
    "type": ["coinbase"],
    "transaction": true,
    "transactionOutputs": true
  }],
  "fields": {
    "block": {"number": true, "timestamp": true},
    "transaction": {"txid": true},
    "input": {"transactionIndex": true, "coinbase": true},
    "output": {"transactionIndex": true, "outputIndex": true, "value": true, "scriptPubKeyAddress": true}
  }
}
```

**Notes:**
- Coinbase inputs have `txid: null`, `vout: null`, and a hex `coinbase` field containing the mining pool's signature
- One coinbase output carries the block reward + fees (subsidy currently 3.125 BTC). It is **not** guaranteed to be output index 0 — pools often add small marker outputs — so identify the reward as the **largest-value output**
- Outputs with `value: 0.0` and `address: null` are OP_RETURN data outputs

---

### Example 7: Full Transaction Detail (Inputs + Outputs)

**Use case:** Get complete transaction data including all inputs and outputs for a block range.

```json
{
  "type": "bitcoin",
  "fromBlock": 942000,
  "toBlock": 942000,
  "transactions": [{"inputs": true, "outputs": true}],
  "fields": {
    "block": {"number": true, "hash": true, "timestamp": true},
    "transaction": {"txid": true, "hash": true, "size": true, "vsize": true, "weight": true},
    "input": {"transactionIndex": true, "inputIndex": true, "txid": true, "vout": true, "type": true, "prevoutValue": true, "prevoutScriptPubKeyAddress": true, "txInWitness": true},
    "output": {"transactionIndex": true, "outputIndex": true, "value": true, "scriptPubKeyType": true, "scriptPubKeyAddress": true}
  }
}
```

**Notes:**
- Field selection alone does NOT emit inputs/outputs. You must request them either via relation flags (`transactions: [{"inputs": true, "outputs": true}]`) or via `inputs: [{}]` / `outputs: [{}]` data selectors
- `hash` on transaction is the witness-inclusive hash (different from `txid` for SegWit txs)
- `txInWitness` is an array of hex strings (witness data)

---

## Block Fields Reference

| Field | Type | Description |
|-------|------|-------------|
| `number` | integer | Block height |
| `hash` | string | Block hash (64 hex chars with leading zeros) |
| `parentHash` | string | Previous block hash |
| `timestamp` | integer | Unix timestamp (seconds) |
| `medianTime` | integer | Median time of previous 11 blocks |
| `version` | integer | Block version |
| `merkleRoot` | string | Merkle root hash |
| `nonce` | integer | Mining nonce |
| `target` | string | Mining target |
| `bits` | string | Compact target representation |
| `difficulty` | float | Mining difficulty |
| `chainWork` | string | Cumulative chain work |
| `strippedSize` | integer | Block size without witness data |
| `size` | integer | Full block size (bytes) |
| `weight` | integer | Block weight (WU) |

## Transaction Fields Reference

| Field | Type | Description |
|-------|------|-------------|
| `transactionIndex` | integer | Position in block (0 = coinbase) |
| `txid` | string | Transaction ID (non-witness hash) |
| `hash` | string | Witness-inclusive hash |
| `hex` | string | Raw transaction hex |
| `size` | integer | Transaction size (bytes) |
| `vsize` | integer | Virtual size (weight/4) |
| `weight` | integer | Transaction weight (WU) |
| `version` | integer | Transaction version |
| `locktime` | integer | Lock time |

## Input Fields Reference

| Field | Type | Description |
|-------|------|-------------|
| `transactionIndex` | integer | Parent transaction position |
| `inputIndex` | integer | Input position within transaction |
| `type` | string | `"coinbase"` or `"tx"` |
| `txid` | string/null | Previous output's transaction ID (null for coinbase) |
| `vout` | integer/null | Previous output's index (null for coinbase) |
| `scriptSigHex` | string | ScriptSig hex |
| `scriptSigAsm` | string | ScriptSig assembly |
| `sequence` | integer | Sequence number |
| `coinbase` | string/null | Coinbase hex data (only for coinbase inputs) |
| `txInWitness` | string[] | Witness data (array of hex strings) |
| `prevoutValue` | float/null | Value of spent UTXO (BTC, null for coinbase) |
| `prevoutHeight` | integer/null | Block height of spent UTXO |
| `prevoutGenerated` | boolean/null | Whether spent UTXO was from coinbase |
| `prevoutScriptPubKeyHex` | string/null | ScriptPubKey hex of spent UTXO |
| `prevoutScriptPubKeyAsm` | string/null | ScriptPubKey assembly of spent UTXO |
| `prevoutScriptPubKeyDesc` | string/null | Output descriptor of spent UTXO |
| `prevoutScriptPubKeyType` | string/null | Script type of spent UTXO |
| `prevoutScriptPubKeyAddress` | string/null | Address of spent UTXO |

## Output Fields Reference

| Field | Type | Description |
|-------|------|-------------|
| `transactionIndex` | integer | Parent transaction position |
| `outputIndex` | integer | Output position (vout) |
| `value` | float | Output value in **BTC** (not satoshis) |
| `scriptPubKeyHex` | string | ScriptPubKey hex |
| `scriptPubKeyAsm` | string | ScriptPubKey assembly |
| `scriptPubKeyDesc` | string | Output descriptor — `addr(bc1q…)#checksum` for addresses, `raw(<hex>)#checksum` for non-address scripts (e.g. the nulldata witness commitment) |
| `scriptPubKeyType` | string | Script type (see Script Types table) |
| `scriptPubKeyAddress` | string/null | Recipient address (null for OP_RETURN) |

---

## Key Concepts

**Values are in BTC (float), not satoshis:**
```json
{"value": 3.15237202}  // = 3.15 BTC = 315,237,202 satoshis
{"value": 0.00007336}  // = 7,336 satoshis
```
Small amounts serialize in **scientific notation** (`5.46e-6` = 546 sats, `7.0e-6` = 700 sats); `difficulty` likewise (`1.337931473075428e14`). Parse these as floating point, not as fixed-decimal strings.

**Timestamps are in seconds** (same as EVM, unlike Hyperliquid which uses milliseconds).

**UTXO model:** Bitcoin uses Unspent Transaction Outputs, not account balances. To track an address's activity:
- **Receiving:** Filter `outputs` by `scriptPubKeyAddress`
- **Spending:** Filter `inputs` by `prevoutScriptPubKeyAddress`

**Coinbase transactions:** The first transaction (index 0) in every block is the coinbase. Its input has `type: "coinbase"`, `txid: null`, and contains pool identification data in the `coinbase` hex field.

**SegWit transaction hashes:** `txid` excludes witness data; `hash` includes it. For non-SegWit transactions they're identical.

**Transaction fees are not a field — compute them:** `fee = sum(input.prevoutValue) - sum(output.value)`. Request the transaction with both `inputs: true` and `outputs: true` (or use `transactionInputs`/`transactionOutputs` relation flags) and sum per `transactionIndex`. Coinbase transactions have no fee (their input has no prevout).

**OP_RETURN decoding:** outputs with `scriptPubKeyType: "nulldata"` carry data, not value. The `scriptPubKeyAsm` looks like `OP_RETURN <hex>` — grab the hex payload and decode it as UTF-8 if printable:
```javascript
const m = out.scriptPubKeyAsm.match(/^OP_RETURN\s+([0-9a-f]+)/i)
if (m) console.log(Buffer.from(m[1], 'hex').toString('utf8'))
```
An OP_RETURN may contain **multiple pushes** (`OP_RETURN <hexA> <hexB>`), and many payloads are binary rather than UTF-8 (e.g. the `aa21a9ed…` SegWit witness commitment). The regex above captures only the first push.

---

## Common Mistakes

### Mistake 1: Using Wrong Type Field

```json
{"type": "evm"}  // Wrong - Bitcoin is not EVM
```
**Fix:** Always use `"type": "bitcoin"`.

---

### Mistake 2: Expecting Values in Satoshis

```json
// Output: {"value": 0.54199819}
// This is 0.542 BTC, NOT 54199819 satoshis
```
Portal returns Bitcoin values as **BTC floats**. Multiply by 100,000,000 for satoshis.

---

### Mistake 3: Using `coinbase` as a Filter Field

```json
{"inputs": [{"coinbase": true}]}  // Wrong - coinbase is not a filter field
```
**Fix:** Use `"type": ["coinbase"]` to filter for coinbase inputs:
```json
{"inputs": [{"type": ["coinbase"]}]}
```

---

### Mistake 4: Missing Relation Flags

```json
// Filtering outputs but wanting transaction data too
{"outputs": [{"scriptPubKeyAddress": ["bc1q..."]}]}  // Gets outputs only
```
**Fix:** Add `"transaction": true` to the filter to pull related transactions:
```json
{"outputs": [{"scriptPubKeyAddress": ["bc1q..."], "transaction": true}]}
```

---

### Mistake 5: Using EVM-style Field Keys

```json
{"fields": {"log": {"address": true}}}  // Wrong - no logs in Bitcoin
```
**Fix:** Use Bitcoin field keys: `block`, `transaction`, `input`, `output`.

---

### Mistake 6: Too Broad Query

```json
{"transactions": [{}], "fromBlock": 0, "toBlock": 942000}  // Millions of results
```
**Fix:** Use narrow block ranges (10-100 blocks) or specific address filters.

---

**Debugging tip:** An unknown field name returns `HTTP 400 Bad request: unknown field '<x>', expected one of …` listing every valid field — the fastest way to self-correct a field name.

---

## Performance Tips

- **Filter by address** when possible — `scriptPubKeyAddress` on outputs or `prevoutScriptPubKeyAddress` on inputs
- **Use narrow block ranges** for unfiltered queries (1-10 blocks per request)
- **Request only needed fields** — omit `hex`, `scriptSigHex`, `scriptPubKeyHex`, `txInWitness` unless needed
- **Use relation flags** (`transaction: true`) instead of separate queries to get related data in one request
- **Filter by script type** to narrow results (e.g., only Taproot outputs)

---

## Pipes SDK

For durable Bitcoin indexers, the Pipes SDK ships a native Bitcoin module:

```typescript
import { BitcoinQueryBuilder, bitcoinPortalStream } from '@subsquid/pipes/bitcoin'
```

See the **pipes-sdk** skill for the full pattern.
