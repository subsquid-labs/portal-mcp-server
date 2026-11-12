# Substrate — Query Reference

## Overview

Substrate chains (Polkadot, Kusama, and parachains) use a different data model from EVM. The core entities are **events**, **calls**, and **extrinsics** organized by pallet (e.g., `Balances.Transfer`, `Staking.bond`).

**Important:** Real-time streaming is NOT supported for Substrate chains. Only finalized historical data is available. Use the `/finalized-stream` endpoint. If you need real-time Substrate data, schedule a call with the SQD team.

---

## Query Structure

**Basic Substrate event query:**

```json
{
  "type": "substrate",
  "fromBlock": 20000000,
  "toBlock": 20000100,
  "events": [{
    "name": ["Balances.Transfer"]
  }],
  "fields": {
    "block": {
      "number": true,
      "timestamp": true
    },
    "event": {
      "name": true,
      "args": true
    }
  }
}
```

**Field explanations:**
- `type: "substrate"` — **Required for Substrate chains** (not "evm")
- `fromBlock/toBlock` — Block range (inclusive)
- `events` — Array of event filter objects
- `calls` — Array of call filter objects
- `evmLogs` — EVM log filters for Frontier parachains (Astar, Peaq)
- `ethereumTransactions` — EVM transaction filters for Frontier parachains
- `contractsEvents` — ink! smart contract event filters
- `gearMessagesEnqueued` / `gearUserMessagesSent` — Gear/Vara network filters
- `reviveContractEmitted` — Revive smart contract event filters

---

## Data Entities

### Events

Events are emitted by pallets during block execution. Names are qualified as `Pallet.EventName`.

**Filter fields:**
- `name` — Qualified event name (e.g., `"Balances.Transfer"`, `"Staking.Rewarded"`)

**Relation flags (fetch related data):**
- `extrinsic: true` — Fetch the parent extrinsic
- `call: true` — Fetch the call that emitted the event
- `stack: true` — Fetch the full call stack (all parent calls)

### Calls

Calls represent dispatchable functions. Names are qualified as `Pallet.call_name`.

**Filter fields:**
- `name` — Qualified call name (e.g., `"Balances.transfer_keep_alive"`, `"Staking.bond"`)

**Relation flags:**
- `subcalls: true` — Fetch all child calls
- `extrinsic: true` — Fetch the parent extrinsic
- `stack: true` — Fetch all parent calls in the call tree
- `events: true` — Fetch all events emitted by the call

### Extrinsics

Extrinsics are signed or unsigned transactions submitted to the chain. They contain one or more calls.

**Note:** Extrinsics are not directly filterable. They are fetched as related data via `extrinsic: true` on events or calls.

---

## Available Fields

### Block Fields

```json
{
  "block": {
    "number": true,
    "hash": true,
    "parentHash": true,
    "stateRoot": true,
    "extrinsicsRoot": true,
    "digest": true,
    "specName": true,
    "specVersion": true,
    "implName": true,
    "implVersion": true,
    "validator": true,
    "timestamp": true
  }
}
```

**Notes:**
- `timestamp` — Milliseconds since Unix epoch
- `specName` / `specVersion` — Runtime version info (useful for tracking runtime upgrades)
- `validator` — Block author/validator address
- `digest` — Consensus engine data as JSON

### Event Fields

```json
{
  "event": {
    "index": true,
    "extrinsicIndex": true,
    "callAddress": true,
    "name": true,
    "phase": true,
    "topics": true,
    "args": true
  }
}
```

**Notes:**
- `name` — Qualified name like `Balances.Transfer`
- `phase` — One of: `ApplyExtrinsic`, `Finalization`, `Initialization`
- `args` — Event parameters as JSON (structure varies by event type)
- `callAddress` — Position of the emitting call in the extrinsic call tree

### Call Fields

```json
{
  "call": {
    "extrinsicIndex": true,
    "address": true,
    "name": true,
    "success": true,
    "args": true,
    "origin": true,
    "error": true
  }
}
```

**Notes:**
- `name` — Qualified name like `Balances.transfer_keep_alive`
- `address` — Array of integers representing position in the call tree (e.g., `[0]` for root, `[0, 1]` for nested)
- `args` — Call arguments as JSON
- `origin` — Call origin (e.g., signed account)
- `error` — Error data if the call failed (JSON)

### Extrinsic Fields

```json
{
  "extrinsic": {
    "index": true,
    "version": true,
    "success": true,
    "hash": true,
    "fee": true,
    "tip": true,
    "signature": true,
    "error": true
  }
}
```

**Notes:**
- `fee` — Decimal string (not integer)
- `tip` — Decimal string
- `signature` — Signature data as JSON object
- `error` — Error data if the extrinsic failed

---

## Frontier EVM on Substrate

Some Substrate parachains run an EVM via the Frontier pallet (Astar, Peaq). Query that activity from their **Substrate datasets** (`astar-substrate`, `peaq-mainnet-substrate`) with the filter types below.

### EVM Logs (Frontier)

Filter EVM.Log events on Frontier parachains:

```json
{
  "type": "substrate",
  "fromBlock": 5000000,
  "toBlock": 5000100,
  "evmLogs": [{
    "address": ["0x..."],
    "topic0": ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"]
  }],
  "fields": {
    "block": {"number": true, "timestamp": true},
    "event": {"name": true, "args": true}
  }
}
```

**Filter fields:** `address`, `topic0`, `topic1`, `topic2`, `topic3`
**Relation flags:** `extrinsic`, `call`, `stack`

### Ethereum Transactions (Frontier)

Filter Ethereum.transact calls:

```json
{
  "type": "substrate",
  "fromBlock": 5000000,
  "toBlock": 5000100,
  "ethereumTransactions": [{
    "to": ["0x..."],
    "sighash": ["0xa9059cbb"]
  }],
  "fields": {
    "block": {"number": true, "timestamp": true},
    "call": {"name": true, "args": true, "success": true}
  }
}
```

**Filter fields:** `to` (contract address), `sighash` (4-byte function selector)
**Relation flags:** `extrinsic`, `stack`, `events`

---

## ink! Smart Contracts

Filter `Contracts.ContractEmitted` events for ink! contracts:

```json
{
  "type": "substrate",
  "fromBlock": 1000000,
  "toBlock": 1000100,
  "contractsEvents": [{
    "contractAddress": ["0x..."]
  }],
  "fields": {
    "block": {"number": true, "timestamp": true},
    "event": {"name": true, "args": true}
  }
}
```

**Important:** Contract addresses must be **hexadecimal** (decoded from SS58) and **lowercase**.

**Relation flags:** `extrinsic`, `call`, `stack`

---

## Gear/Vara Networks

### Messages Enqueued

```json
{
  "type": "substrate",
  "gearMessagesEnqueued": [{
    "programId": ["0x..."]
  }],
  "fields": {
    "event": {"name": true, "args": true}
  }
}
```

### User Messages Sent

```json
{
  "type": "substrate",
  "gearUserMessagesSent": [{
    "programId": ["0x..."]
  }],
  "fields": {
    "event": {"name": true, "args": true}
  }
}
```

**Relation flags for both:** `extrinsic`, `call`, `stack`

---

## Revive Smart Contracts

Filter `Revive.ContractEmitted` events:

```json
{
  "type": "substrate",
  "reviveContractEmitted": [{
    "contract": ["0x..."],
    "topic0": ["0x..."]
  }],
  "fields": {
    "event": {"name": true, "args": true}
  }
}
```

**Filter fields:** `contract`, `topic0`, `topic1`, `topic2`, `topic3`
**Relation flags:** `extrinsic`, `call`, `stack`

---

## Examples

### Example 1: Track DOT Transfers on Polkadot

```json
{
  "type": "substrate",
  "fromBlock": 20000000,
  "toBlock": 20000100,
  "events": [{
    "name": ["Balances.Transfer"]
  }],
  "fields": {
    "block": {
      "number": true,
      "timestamp": true
    },
    "event": {
      "name": true,
      "args": true,
      "extrinsicIndex": true
    }
  }
}
```

**Dataset:** `polkadot` | **Event:** `Balances.Transfer`
**Notes:** `args` contains `from`, `to`, and `amount` fields. Amount is in plancks (1 DOT = 10^10 plancks).

---

### Example 2: Track Staking Calls with Extrinsics

```json
{
  "type": "substrate",
  "fromBlock": 20000000,
  "toBlock": 20000100,
  "calls": [{
    "name": ["Staking.bond", "Staking.unbond", "Staking.nominate"],
    "extrinsic": true
  }],
  "fields": {
    "block": {
      "number": true,
      "timestamp": true
    },
    "call": {
      "name": true,
      "args": true,
      "success": true
    },
    "extrinsic": {
      "hash": true,
      "fee": true,
      "success": true
    }
  }
}
```

**Dataset:** `polkadot` | **Calls:** Staking pallet bond/unbond/nominate
**Notes:** `extrinsic: true` in the call filter fetches the parent extrinsic for each matching call.

---

### Example 3: Track Governance Proposals

```json
{
  "type": "substrate",
  "fromBlock": 20000000,
  "toBlock": 20100000,
  "events": [{
    "name": ["Referenda.Submitted", "Referenda.Approved", "Referenda.Rejected"]
  }],
  "fields": {
    "block": {
      "number": true,
      "timestamp": true
    },
    "event": {
      "name": true,
      "args": true
    }
  }
}
```

**Dataset:** `polkadot` | **Events:** OpenGov referenda lifecycle

---

### Example 4: XCM Cross-Chain Messages

```json
{
  "type": "substrate",
  "fromBlock": 20000000,
  "toBlock": 20000100,
  "events": [{
    "name": ["XcmPallet.Sent", "MessageQueue.Processed"]
  }],
  "fields": {
    "block": {
      "number": true,
      "timestamp": true
    },
    "event": {
      "name": true,
      "args": true
    }
  }
}
```

**Dataset:** `polkadot` | **Events:** XCM message send and processing

---

### Example 5: EVM Transfers on Astar (Frontier)

```json
{
  "type": "substrate",
  "fromBlock": 5000000,
  "toBlock": 5000100,
  "evmLogs": [{
    "topic0": ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"]
  }],
  "fields": {
    "block": {
      "number": true,
      "timestamp": true
    },
    "event": {
      "name": true,
      "args": true
    }
  }
}
```

**Dataset:** `astar-substrate` | **Event:** ERC20 Transfer via Frontier EVM (returns `EVM.Log` events; checked 2026-11-11)
**Notes:** Use the `-substrate` suffixed dataset for Substrate-level queries on Frontier parachains.

---

### Example 6: Track All Calls with Their Events

```json
{
  "type": "substrate",
  "fromBlock": 20000000,
  "toBlock": 20000010,
  "calls": [{
    "name": ["Balances.transfer_keep_alive"],
    "events": true,
    "extrinsic": true
  }],
  "fields": {
    "block": {
      "number": true,
      "timestamp": true
    },
    "call": {
      "name": true,
      "args": true,
      "success": true
    },
    "event": {
      "name": true,
      "args": true
    },
    "extrinsic": {
      "hash": true,
      "fee": true
    }
  }
}
```

**Notes:** `events: true` on the call filter fetches all events emitted by the matching calls. Useful for correlating call execution with its side effects.

---

### Example 7: Runtime Upgrades

```json
{
  "type": "substrate",
  "fromBlock": 0,
  "toBlock": 25000000,
  "events": [{
    "name": ["System.CodeUpdated"]
  }],
  "fields": {
    "block": {
      "number": true,
      "timestamp": true,
      "specName": true,
      "specVersion": true
    },
    "event": {
      "name": true
    }
  }
}
```

**Dataset:** `polkadot` | **Event:** Runtime upgrade events
**Notes:** `specVersion` in block fields tracks the runtime version. Useful for tracking chain upgrades over time.

---

## Common Mistakes

### Using `"type": "evm"` for Substrate Chains

```json
{"type": "evm", "fromBlock": 20000000, "events": [{"name": ["Balances.Transfer"]}]}
```
**Wrong.** Substrate chains require `"type": "substrate"`.

---

### Using EVM-Style Filters on Substrate

```json
{"type": "substrate", "logs": [{"address": ["0x..."]}]}
```
**Wrong.** Substrate uses `events` and `calls`, not `logs` and `transactions`. For EVM data on Frontier parachains, use `evmLogs` and `ethereumTransactions`.

---

### Expecting Real-Time Data

Substrate datasets do **not** support real-time streaming. Only finalized historical data is available. The `/stream` endpoint works but only returns finalized blocks. Use `/finalized-stream` for explicit finalized-only queries.

---

### Using SS58 Addresses in ink! Contract Filters

```json
{"contractsEvents": [{"contractAddress": ["5GrwvaEF..."]}]}
```
**Wrong.** Contract addresses must be **hex** (decoded from SS58) and **lowercase**.

---

### Wrong Dataset Name for Frontier Parachains

```
POST /datasets/astar-mainnet/stream  (with type: "substrate")
```
**Wrong.** Frontier parachains use `-substrate` suffixed datasets for Substrate queries:
- `astar-substrate` (`astar-mainnet` is the EVM dataset and takes `"type": "evm"`)

---

## Performance Tips

1. **Filter by event/call name** — always specify pallet and name, don't fetch all events
2. **Use narrow block ranges** when exploring (100-1000 blocks)
3. **Request only needed fields** — reduces response size significantly
4. **Use relation flags selectively** — `extrinsic: true` and `events: true` add data per match
5. **Prefer `/finalized-stream`** — explicitly signals finalized-only intent
6. **Combine event and call queries** — a single request can filter both events and calls simultaneously
