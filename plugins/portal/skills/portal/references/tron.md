# Tron — Query Reference

## Query Structure

Portal Stream API uses POST requests to `/datasets/tron-mainnet/stream`.

Companion endpoints share the `/datasets/tron-mainnet/` base: `GET /head` and `GET /finalized-head` return the current and last-finalized chain tips, and `POST /finalized-stream` takes the same body as `/stream` but yields only finalized blocks (it never returns HTTP 409 on a reorg).

**Basic Tron query structure:**

```json
{
  "type": "tron",
  "fromBlock": 84000000,
  "toBlock": 84000010,
  "logs": [{"address": ["a614f803b6fd780986a42c78ec9c7f77e6ded13c"]}],
  "fields": {
    "block": {"number": true, "hash": true, "timestamp": true},
    "log": {"transactionIndex": true, "logIndex": true, "address": true, "topics": true, "data": true}
  }
}
```

**Field explanations:**
- `type: "tron"` — **Required** (the dataset also answers `"evm"` queries, but native Tron data needs `"tron"` — see EVM Compatibility Mode below)
- `fromBlock/toBlock` — Block range (dataset starts at block 0, real-time head available)
- Data keys: `transactions`, `transferTransactions`, `transferAssetTransactions`, `triggerSmartContractTransactions`, `logs`, `internalTransactions` — arrays of filter objects
- Fields keys: `block`, `transaction`, `log`, `internalTransaction`

## Three Rules That Trip Everyone Up

1. **All hex is BARE — no `0x` prefix.** Addresses, topics, hashes, sighashes: `41a614f803…`, `ddf252ad…`, `a9059cbb`. EVM-style `0x`-prefixed values return no results.
2. **Timestamps are Unix milliseconds** (`timestamp`, `expiration` on blocks and transactions) — unlike EVM datasets which use seconds.
3. **Two address forms, by context.** Transaction-level addresses (`contract`, `owner`, `to` filters; `contractAddress`, `parameter.value.*`, internal-tx addresses) are 21-byte hex starting with `41` (`41a614f803…`). **Log addresses and topics use the 20-byte EVM-style form without the `41`** (`a614f803…` in `logs.address`; topics are 32-byte ABI-padded). Neither is base58 (`TR7NHqje…`). Convert: log/topic form → Tron form = prepend `41`; Tron form → log form = drop the leading `41`.

---

## Data Keys & Filters

### Transactions

Filter key: `transactions` — all transactions, filterable by contract type.

| Filter Field | Type | Description |
|---|---|---|
| `type` | string[] | Tron contract type, e.g. `"TransferContract"`, `"TriggerSmartContract"`, `"TransferAssetContract"`, `"DelegateResourceContract"`, `"FreezeBalanceV2Contract"` |
| `logs` | boolean | Include the logs each matched transaction emitted |
| `internalTransactions` | boolean | Include the internal transactions of each match |

### Transfer Transactions (native TRX)

Filter key: `transferTransactions` — native TRX transfers (`TransferContract`).

| Filter Field | Type | Description |
|---|---|---|
| `owner` | string[] | Sender address (bare `41…` hex) |
| `to` | string[] | Recipient address (bare `41…` hex) |
| `logs` | boolean | Include related logs |
| `internalTransactions` | boolean | Include related internal transactions |

### Transfer Asset Transactions (TRC-10)

Filter key: `transferAssetTransactions` — TRC-10 token transfers (`TransferAssetContract`).

| Filter Field | Type | Description |
|---|---|---|
| `owner` | string[] | Sender address |
| `to` | string[] | Recipient address |
| `asset` | string[] | TRC-10 asset — the raw **hex-encoded** `asset_name` (e.g. `"31303035313537"` = ASCII `"1005157"`), **not** the decimal id |
| `logs` | boolean | Include related logs |
| `internalTransactions` | boolean | Include related internal transactions |

> TRC-10 is Tron's native token standard (no smart contract). TRC-20 tokens like USDT are smart contracts — track them via `logs` or `triggerSmartContractTransactions`, not here.

### Trigger Smart Contract Transactions

Filter key: `triggerSmartContractTransactions` — smart-contract calls (`TriggerSmartContract`).

| Filter Field | Type | Description |
|---|---|---|
| `owner` | string[] | Caller address |
| `contract` | string[] | Contract address (bare `41…` hex) |
| `sighash` | string[] | 4-byte method selector, bare hex (e.g. `"a9059cbb"` = `transfer(address,uint256)`) |
| `logs` | boolean | Include the logs each call emitted |
| `internalTransactions` | boolean | Include internal transactions |

### Logs

Filter key: `logs` — TVM event logs (same event-signature hashing as EVM).

| Filter Field | Type | Description |
|---|---|---|
| `address` | string[] | Emitting contract — **20-byte EVM-style bare hex, no `41` prefix** (e.g. `a614f803…`) |
| `topic0` | string[] | Event signature hash, bare hex |
| `topic1` – `topic3` | string[] | Indexed parameters (32-byte padded, bare hex) |
| `transaction` | boolean | Include the parent transaction |

### Internal Transactions

Filter key: `internalTransactions` — internal TRX/token movements from contract execution.

| Filter Field | Type | Description |
|---|---|---|
| `caller` | string[] | Calling contract/account address |
| `transferTo` | string[] | Receiving address |
| `transaction` | boolean | Include the parent transaction |

### Include All Blocks

`"includeAllBlocks": true` (top-level) — also return blocks with no matching data (Portal skips them by default).

---

## Address Format Conversion

Four representations of the same address:

| Form | Example | Where used |
|---|---|---|
| Base58Check (`T…`) | `TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t` | Wallets, explorers (Tronscan) — **never in Portal queries** |
| Tron hex (`41` + 20 bytes) | `41a614f803b6fd780986a42c78ec9c7f77e6ded13c` | Transaction-level filters (`contract`, `owner`, `to`) and transaction/internal-tx response fields |
| EVM-style 20-byte hex | `a614f803b6fd780986a42c78ec9c7f77e6ded13c` | **Log filters and log responses** (`logs.address`) |
| 32-byte padded topic | `000000000000000000000000a614f803…ded13c` | Log topics (indexed address params) |

**Base58 → Tron hex** (no dependencies):

```bash
node -e '
const bs58chars = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
let n = 0n;
for (const c of process.argv[1]) n = n * 58n + BigInt(bs58chars.indexOf(c));
const hex = n.toString(16);
console.log(hex.slice(0, -8));  // strip 4-byte checksum
' TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t
# → 41a614f803b6fd780986a42c78ec9c7f77e6ded13c
```

**Topic → Tron hex:** `"41" + topic.slice(-40)`

---

## Examples

### Example 1: USDT (TRC-20) Transfer Events

**Use case:** Track USDT transfers via `Transfer(address,address,uint256)` logs — same topic0 as ERC-20.

```json
{
  "type": "tron",
  "fromBlock": 84000000,
  "toBlock": 84000010,
  "logs": [{
    "address": ["a614f803b6fd780986a42c78ec9c7f77e6ded13c"],
    "topic0": ["ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"],
    "transaction": true
  }],
  "fields": {
    "block": {"number": true, "timestamp": true},
    "log": {"transactionIndex": true, "logIndex": true, "address": true, "topics": true, "data": true},
    "transaction": {"transactionIndex": true, "hash": true}
  }
}
```

**Dataset:** `tron-mainnet`
**Notes:**
- Log `address` uses the 20-byte EVM-style form — USDT's `41a614f8…` becomes `a614f8…` here
- `from`/`to` are in `topics[1]`/`topics[2]` (padded) — convert with `"41" + topic.slice(-40)`
- Transfer amount is in `data` (hex, USDT has 6 decimals): `Number(BigInt("0x" + log.data)) / 1e6`
- Logs carry no transaction hash — set `"transaction": true` and join `log.transactionIndex` → `transaction.transactionIndex`

**Sample response (real data, block 84,000,000):**
```json
{"header": {"number": 84000000, "timestamp": 1782669669000}}
{"logs": [{"transactionIndex": 12, "logIndex": 0, "address": "a614f803b6fd780986a42c78ec9c7f77e6ded13c", "data": "…1312d000", "topics": ["ddf252ad…", "000000000000000000000000d95174a0…", "0000000000000000000000005bdb8b4c…"]}]}
```

### Example 2: USDT `transfer()` Calls

**Use case:** Track smart-contract calls by contract + method selector.

```json
{
  "type": "tron",
  "fromBlock": 84000000,
  "toBlock": 84000010,
  "triggerSmartContractTransactions": [{
    "contract": ["41a614f803b6fd780986a42c78ec9c7f77e6ded13c"],
    "sighash": ["a9059cbb"],
    "logs": true
  }],
  "fields": {
    "block": {"number": true, "timestamp": true},
    "transaction": {"transactionIndex": true, "hash": true, "type": true, "result": true, "energyUsageTotal": true, "fee": true},
    "log": {"transactionIndex": true, "topics": true, "data": true}
  }
}
```

**Notes:**
- `sighash` is the same 4-byte selector as EVM (`a9059cbb` = `transfer(address,uint256)`), bare hex
- `logs: true` pulls the events those calls emitted — useful to get actual transfer outcomes
- `result: "SUCCESS"` marks successful execution; failed calls have other values (e.g. `"REVERT"`)

### Example 3: Native TRX Transfers

```json
{
  "type": "tron",
  "fromBlock": 84000000,
  "toBlock": 84000010,
  "transferTransactions": [{}],
  "fields": {
    "block": {"number": true, "timestamp": true},
    "transaction": {"transactionIndex": true, "hash": true, "type": true, "parameter": true}
  }
}
```

**Notes:**
- Filter by `owner` (sender) or `to` (recipient) with bare `41…` hex addresses
- The transfer details (sender, recipient, amount) live in `parameter.value` — for `TransferContract`: `{owner_address, to_address, amount}` with the amount in **SUN** (1 TRX = 1,000,000 SUN)

### Example 4: TRC-10 Asset Transfers

```json
{
  "type": "tron",
  "fromBlock": 84000000,
  "toBlock": 84000030,
  "transferAssetTransactions": [{"asset": ["31303035313537"]}],
  "fields": {
    "block": {"number": true, "timestamp": true},
    "transaction": {"transactionIndex": true, "hash": true, "parameter": true}
  }
}
```

**Notes:**
- TRC-10 transfers are still common (~10-15% of Tron transactions), though most *value* moves via TRC-20 USDT
- `parameter.value` holds `{amount, asset_name, owner_address, to_address}` — `asset_name` is the **hex-encoded** numeric asset ID (e.g. `"31303035313537"` = ASCII `"1005157"`)
- The `asset` filter matches that raw hex `asset_name` **verbatim** — use `{"asset": ["31303035313537"]}`, **not** the decimal `{"asset": ["1005157"]}` (the decimal form returns 0 matches)

### Example 5: Internal Transactions

**Use case:** Contract-to-contract TRX movements (Tron's equivalent of EVM internal calls with value).

```json
{
  "type": "tron",
  "fromBlock": 84000000,
  "toBlock": 84000005,
  "internalTransactions": [{"transaction": true}],
  "fields": {
    "block": {"number": true, "timestamp": true},
    "internalTransaction": {"transactionIndex": true, "internalTransactionIndex": true, "callerAddress": true, "transferToAddress": true, "callValueInfo": true, "rejected": true},
    "transaction": {"transactionIndex": true, "hash": true}
  }
}
```

**Notes:** `callValueInfo` is an array of `{callValue, tokenId}` — `callValue` in SUN (decimal string); `tokenId` set for TRC-10 movements.

### Example 6: All Transactions by Contract Type

```json
{
  "type": "tron",
  "fromBlock": 84000000,
  "toBlock": 84000005,
  "transactions": [{"type": ["TriggerSmartContract", "TransferContract"]}],
  "fields": {
    "block": {"number": true, "timestamp": true},
    "transaction": {"transactionIndex": true, "hash": true, "type": true, "result": true, "fee": true, "netUsage": true, "energyUsageTotal": true}
  }
}
```

**Common `type` values** (verified distribution, blocks 84000000–84000004, 1802 txs: `TransferContract` 879, `TriggerSmartContract` 288, `DelegateResourceContract` 249, `UnDelegateResourceContract` 226, `TransferAssetContract` 158, `AccountCreateContract` 2 — exact counts vary by range): also `FreezeBalanceV2Contract` / `UnfreezeBalanceV2Contract` / `UnfreezeBalanceContract` (staking), `WithdrawBalanceContract` (rewards), `VoteWitnessContract` (governance), `CreateSmartContract`. These mirror Tron protobuf contract type names.

---

## Block Fields Reference

| Field | Type | Description |
|-------|------|-------------|
| `number` | integer | Block height |
| `hash` | string | Block hash (bare hex) |
| `parentHash` | string | Previous block hash |
| `txTrieRoot` | string | Transaction trie root |
| `version` | integer | Block version |
| `timestamp` | integer | Unix timestamp in **milliseconds** |
| `witnessAddress` | string | Block producer (Super Representative) address, `41…` hex |
| `witnessSignature` | string | Producer signature |

## Transaction Fields Reference

| Field | Type | Description |
|-------|------|-------------|
| `transactionIndex` | integer | Position in block |
| `hash` | string | Transaction hash (bare hex) |
| `type` | string | Contract type (see Example 6) |
| `parameter` | object | Contract payload `{value, type_url}` — shape depends on `type` (raw JSON passthrough) |
| `ret` | array | Per-contract results, e.g. `[{"contractRet": "SUCCESS"}]` — the reliable success marker for all tx types |
| `result` | string/null | Execution result of a contract call (`"SUCCESS"`, …) — null for plain transfers; check `ret[0].contractRet` instead |
| `contractResult` | string | Return data of a contract call (hex) |
| `contractAddress` | string | Created contract address (for `CreateSmartContract`) |
| `resMessage` | string | Error message on failure |
| `signature` | string[] | Transaction signatures |
| `permissionId` | integer | Multi-sig permission ID |
| `refBlockBytes` / `refBlockHash` | string | TAPOS reference block fields |
| `feeLimit` | string (decimal) | Max fee the sender allows, in SUN |
| `fee` | string (decimal) | Total fee paid, in SUN |
| `timestamp` | integer | Creation time, Unix **milliseconds** |
| `expiration` | integer | Expiration time, Unix **milliseconds** |
| `rawDataHex` | string | Raw transaction bytes (hex) |
| `energyFee` | string (decimal) | Energy burned as TRX, in SUN |
| `energyUsage` | string (decimal) | Energy from the caller's stake |
| `energyUsageTotal` | string (decimal) | Total energy consumed |
| `originEnergyUsage` | string (decimal) | Energy provided by the contract deployer |
| `energyPenaltyTotal` | string (decimal) | Extra energy penalty (popular-contract surcharge) |
| `netUsage` | string (decimal) | Bandwidth consumed (bytes) |
| `netFee` | string (decimal) | Bandwidth burned as TRX, in SUN |
| `withdrawAmount` / `unfreezeAmount` / `withdrawExpireAmount` | string (decimal) | Staking-related amounts, in SUN |
| `cancelUnfreezeV2Amount` | object | Map of unfreeze timestamp → amount |

> **Amounts are decimal strings, not hex** (e.g. `"26400000"`). Parse with `BigInt(value)`. TRX amounts are in SUN: divide by 1e6 for TRX.

## Log Fields Reference

| Field | Type | Description |
|-------|------|-------------|
| `transactionIndex` | integer | Parent transaction position |
| `logIndex` | integer | Log position within the block |
| `address` | string | Emitting contract — 20-byte EVM-style bare hex (no `41` prefix) |
| `topics` | string[] | Event topics (bare hex, 32-byte values) |
| `data` | string | Non-indexed event data (bare hex) |

> There is **no `transactionHash` on logs** — request the parent transaction (`"transaction": true` on the log filter) and join on `transactionIndex`.

## Internal Transaction Fields Reference

| Field | Type | Description |
|-------|------|-------------|
| `transactionIndex` | integer | Parent transaction position |
| `internalTransactionIndex` | integer | Position within the transaction |
| `hash` | string | Internal transaction hash |
| `callerAddress` | string | Calling address (`41…` hex) |
| `transferToAddress` | string | Receiving address |
| `callValueInfo` | array | `[{callValue, tokenId}]` — value in SUN; `tokenId` for TRC-10 |
| `note` | string | Call type note (hex-encoded, e.g. `"call"`) |
| `rejected` | boolean | Whether the internal tx was rejected |
| `extra` | string | Extra data |

---

## EVM Compatibility Mode

`tron-mainnet` also *accepts* `{"type": "evm"}` queries, but this is a **lossy schema-mismatch shim**, not a true EVM view. It accepts the EVM query envelope (top-level `transactions`, `logs`, `traces`, `stateDiffs`) while the tables underneath stay Tron's:

- The Tron-native tables (`transferTransactions`, `transferAssetTransactions`, `triggerSmartContractTransactions`, `internalTransactions`) are **rejected with HTTP 400** — they aren't part of the EVM envelope.
- `traces` returns HTTP 400 `table 'traces' does not exist`; `stateDiffs` has no backing table either.
- `transactions` and `logs` still carry **Tron** columns — requesting `transaction.from` or `log.transactionHash` returns HTTP 400 (`column not found`).
- Hex is still bare (no `0x`): bare-hex evm-mode log filters DO match (342 logs across blocks 84000000–84000005); only `0x`-prefixed filters return nothing.
- The **only** difference from `tron` mode is that timestamps come back in **seconds** instead of milliseconds.

**Always use `"type": "tron"`.** evm mode gives you nothing EVM-native (no `from`/`to`/`value`, no traces, no `0x`), loses ms precision, and hides Tron's transfer/internal/energy tables. The `tron` type matches what Tronscan and TronGrid users expect (41-hex, SUN, ms).

---

## Key Concepts

**SUN, not TRX:** All native amounts (fees, transfer values, staking amounts) are in SUN. 1 TRX = 1,000,000 SUN.

**Energy & Bandwidth:** Tron charges resources instead of gas. `energyUsageTotal` = compute used by a contract call (burned as `energyFee` TRX if not staked); `netUsage` = bandwidth bytes (burned as `netFee` if not staked). A USDT transfer typically costs ~65K energy.

**Token standards:**
- **Native TRX** → `transferTransactions` (or `transactions` with `type: ["TransferContract"]`)
- **TRC-10** (built-in tokens, numeric asset IDs) → `transferAssetTransactions`
- **TRC-20** (smart contracts, e.g. USDT) → `logs` with Transfer topic0, or `triggerSmartContractTransactions`

**USDT dominates:** USDT at `41a614f803b6fd780986a42c78ec9c7f77e6ded13c` (`TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t`) is by far the highest-volume contract on Tron.

**Event signatures match EVM:** TVM uses keccak256 event hashing — the ERC-20 Transfer topic0 (`ddf252ad…`) works on Tron, just without the `0x` prefix.

---

## Common Mistakes

### Mistake 1: `0x`-Prefixed Hex

```json
{"logs": [{"address": ["0xa614f803b6fd780986a42c78ec9c7f77e6ded13c"]}]}  // ❌ no results
{"logs": [{"address": ["a614f803b6fd780986a42c78ec9c7f77e6ded13c"]}]}    // ✅
```
Tron hex is always bare — in filters and in responses.

> Both lines use the 20-byte log form. Dropping the `0x` is necessary but not sufficient: a bare `41…` address in a log filter also returns nothing (see Mistake 2b).

### Mistake 2: Base58 Addresses in Filters

```json
{"transferTransactions": [{"to": ["TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t"]}]}  // ❌
{"transferTransactions": [{"to": ["41a614f803b6fd780986a42c78ec9c7f77e6ded13c"]}]}  // ✅
```
Convert base58 → 41-hex first (see Address Format Conversion).

### Mistake 2b: `41`-Prefixed Address in a Log Filter

```json
{"logs": [{"address": ["41a614f803b6fd780986a42c78ec9c7f77e6ded13c"]}]}  // ❌ no results
{"logs": [{"address": ["a614f803b6fd780986a42c78ec9c7f77e6ded13c"]}]}    // ✅ 20-byte form
```
Log addresses use the EVM-style 20-byte form; only transaction-level filters take the `41…` form.

### Mistake 3: Treating Timestamps as Seconds

```json
{"timestamp": 1782669669000}  // milliseconds!
```
`new Date(block.timestamp)` directly — do NOT multiply by 1000. (EVM datasets return seconds; Tron returns ms.)

### Mistake 4: Reading Amounts as Hex or TRX

Transaction amounts (`fee`, `feeLimit`, `energyUsageTotal`, …) are **decimal strings in SUN**: `BigInt("26400000")` SUN = 26.4 TRX. Log `data` is the exception — it's hex like EVM: `BigInt("0x" + data)`.

### Mistake 5: Expecting `transactionHash` on Logs

Log records only carry `transactionIndex`. Add `"transaction": true` to the log filter and request `transaction: {"hash": true, "transactionIndex": true}`, then join.

### Mistake 6: Wrong `type` Field

```json
{"type": "evm"}   // works, but EVM-shaped: no native transfers, internal txs, or energy fields
{"type": "tron"}  // ✅ full Tron data model
```

### Mistake 7: Decimal TRC-10 Asset ID

```json
{"transferAssetTransactions": [{"asset": ["1005157"]}]}         // ❌ 0 rows (decimal id)
{"transferAssetTransactions": [{"asset": ["31303035313537"]}]}  // ✅ raw hex asset_name
```
The `asset` filter matches the raw hex `asset_name` verbatim (`31303035313537` = hex of ASCII `"1005157"`). The decimal id returns no results.

### Mistake 8: Trusting `result` for Success

`result` is **null for plain transfers** (it's only populated for contract calls). Use `ret[0].contractRet === "SUCCESS"` as the universal success check across every transaction type.

### Mistake 9: Reading `note` / `asset_name` as Text

`internalTransaction.note` and TRC-10 `parameter.value.asset_name` are **hex-encoded ASCII** (`"63616c6c"` = `"call"`, `"31303035313537"` = `"1005157"`) — decode them (e.g. `Buffer.from(x, "hex").toString()`).

---

## Performance Tips

- **Filter by contract/address** — `logs.address`, `triggerSmartContractTransactions.contract` — 10-100x faster
- **Add topic0/sighash** — another 10x on busy contracts (USDT especially)
- **Use narrow block ranges** while exploring (Tron produces a block every 3 seconds — ~28,800 blocks/day)
- **Request only needed fields** — skip `rawDataHex`, `signature`, `parameter` unless required
- **Resolve time ranges** with `GET /datasets/tron-mainnet/timestamps/{unix-seconds}/block` — input is Unix **seconds** (divide the ms stream timestamps by 1000 first). On tron-mainnet the answer is **approximate**: it can return a block ~1000 s (~344 blocks) *before* the requested time — treat it as a nearby anchor, then widen the range. A far-future timestamp does not 404; it clamps to near-head.

---

## MCP Tool Availability

There are **no Tron-specific Portal MCP tools yet** (no `portal_tron_query_*`). Dataset-agnostic tools work with `tron-mainnet`: `portal_list_networks`, `portal_get_network_info`, `portal_get_head`, `portal_debug_resolve_time_to_block`, `portal_debug_query_blocks`. For actual Tron data queries, use the raw Portal Stream API as shown above.

## Official Docs

- **[Tron OpenAPI Schema](https://docs.sqd.dev/en/ai/tron-openapi)** — full Portal Tron API specification
- **[Tron Stream API docs](https://docs.sqd.dev/en/api/tron/stream.md)** — endpoint reference (also `head`, `finalized-head`, `metadata`, `timestamp-block` under `/en/api/tron/`)
- **[Tron dataset page](https://docs.sqd.dev/en/data/tron/tron-mainnet.md)**

## Pipes SDK

For durable Tron indexers, the Pipes SDK ships a native Tron module:

```typescript
import { TronQueryBuilder, tronPortalStream } from '@subsquid/pipes/tron'
```

See the **pipes-sdk** skill for the full pattern.
