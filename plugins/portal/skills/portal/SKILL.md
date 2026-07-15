---
name: portal
description: "Query blockchain data across 230+ datasets with SQD Portal — EVM, Solana, Substrate, Bitcoin, Tron, Hyperliquid — and choose the right execution path: Portal MCP for bounded answers, Portal Stream API/curl for raw exports, or Pipes/Squid for durable pipelines."
allowed-tools:
  - Bash
  - WebFetch
  - WebSearch
metadata:
  author: subsquid
  version: "1.2.0"
  category: portal-core
---

# Portal

Query and analyze blockchain data across 230+ datasets using SQD Portal. Use this skill to decide whether the job belongs in SQD Portal MCP tools, a raw Portal Stream API/curl request, or a durable Pipes/Squid indexer.

This skill should not be treated as a static copy of the MCP tool catalog. When the SQD Portal MCP server is available, read `sqd://tools` for the current grouped tool guide and `sqd://tools/{tool_name}` for exact per-tool guidance.

## When to Use This Skill

Use this skill when you need to:
- Query blockchain event logs, transactions, traces, instructions, Substrate events/calls, Bitcoin UTXOs, Tron transfers, or trade fills
- Find the correct Portal dataset name for a blockchain
- Analyze on-chain activity (token transfers, DeFi events, contract deployments, trading)
- Choose between Portal MCP tools, raw Portal Stream API/curl, or a durable Pipes/Squid indexer

Use Portal MCP tools for bounded interactive answers, summaries, charts, investigation pivots, entity resolution, and normal chat-sized evidence.

Use raw Portal Stream API or curl when the user asks for raw rows, full exports, exact reproducible requests, NDJSON/CSV/files, or a query shape that should run outside the MCP client.

Recommend Pipes or a Squid when the user needs recurring sync, long backfills, joins, transformations, database storage, production APIs, alerts, dashboards, or app-owned indexed state.

---

## Choose the Right SQD Surface

| Need | Use | Why |
|---|---|---|
| Bounded answer in chat | Portal MCP tools | Best defaults, validation, normalized envelopes, pagination, freshness, and coverage notes |
| Network, entity, or tool discovery | `sqd://tools`, `sqd://datasets`, discovery MCP tools | Keeps routing current without duplicating catalogs |
| Raw rows or export | Portal Stream API / curl | Produces reproducible NDJSON and avoids chat preview truncation |
| Production data product | Pipes / Squid | Durable indexing, transforms, storage, retries, and serving APIs |

Default order:
1. Read `sqd://tools` when MCP resources are available.
2. Pick a public MCP tool for the user's job.
3. Use response metadata to decide whether the answer is complete, paginated, sampled, capped, or partial.
4. Fall back to raw Portal Stream API only when the user needs raw/export/reproducible output or MCP output is too compact.
5. Recommend Pipes/Squid when the question is no longer an ad hoc query.

## Step 1: Find the Correct Dataset Name

**Portal uses specific naming conventions that differ from common names.**

### Top Chains (Quick Reference)

| Common Name | Portal Dataset Name | Type |
|-------------|-------------------|------|
| Ethereum | `ethereum-mainnet` | EVM |
| Arbitrum | `arbitrum-one` | EVM |
| Base | `base-mainnet` | EVM |
| Optimism | `optimism-mainnet` | EVM |
| Polygon | `polygon-mainnet` | EVM |
| BSC / Binance | `binance-mainnet` | EVM |
| Avalanche | `avalanche-mainnet` | EVM |
| zkSync Era | `zksync-mainnet` | EVM |
| Blast | `blast-l2-mainnet` | EVM |
| Scroll | `scroll-mainnet` | EVM |
| Linea | `linea-mainnet` | EVM |
| Gnosis | `gnosis-mainnet` | EVM |
| Polkadot | `polkadot` | Substrate |
| Kusama | `kusama` | Substrate |
| Moonbeam (Substrate) | `moonbeam-substrate` | Substrate |
| Solana | `solana-mainnet` | Solana |
| Bitcoin | `bitcoin-mainnet` | Bitcoin |
| Tron | `tron-mainnet` | Tron |
| Hyperliquid Fills | `hyperliquid-fills` | HyperliquidFills |
| HyperEVM | `hyperliquid-mainnet` | EVM |
| Monad | `monad-mainnet` | EVM |
| MegaETH | `megaeth-mainnet` | EVM |
| Plasma | `plasma-mainnet` | EVM |
| Unichain | `unichain-mainnet` | EVM |

> **Full mapping:** See `references/dataset-mapping.md` for all 230+ datasets including L2s, alt-L1s, and testnets, plus the real-time dataset list.

### Common Mistakes

```
❌ "ethereum" → Should be "ethereum-mainnet"
❌ "arbitrum" → Should be "arbitrum-one"
❌ "bsc" → Should be "binance-mainnet"
```

### Verify a Dataset Name

```bash
curl -I https://portal.sqd.dev/datasets/{dataset-name}/metadata
# 200 = exists, 404 = wrong name
```

Or use MCP: `portal_list_networks` with `query: "arbitrum"` to search.

If the user names a token, contract, protocol, pool, or Hyperliquid coin, resolve it before querying. Use `portal_resolve_entity` when MCP is available; otherwise use trusted token lists, protocol docs, or Portal API evidence rather than memory.

---

## Step 2: Choose Your Data Type

| What You Need | Data Type | Reference | Type Field |
|---|---|---|---|
| Token transfers, DeFi events, NFT activity | **EVM Logs** | `references/evm-logs.md` | `"type": "evm"` |
| Wallet activity, function calls | **EVM Transactions** | `references/evm-transactions.md` | `"type": "evm"` |
| Internal calls, contract deployments | **EVM Traces** | `references/evm-traces.md` | `"type": "evm"` |
| Solana program calls, SPL transfers | **Solana Instructions** | `references/solana.md` | `"type": "solana"` |
| Polkadot/Kusama events, calls, staking | **Substrate** | `references/substrate.md` | `"type": "substrate"` |
| Bitcoin transactions, UTXOs, addresses | **Bitcoin** | `references/bitcoin.md` | `"type": "bitcoin"` |
| Tron TRC-20 logs, TRX/TRC-10 transfers, contract calls | **Tron** | `references/tron.md` | `"type": "tron"` |
| Hyperliquid perpetual fills | **Hyperliquid Fills** | `references/hyperliquid.md` | `"type": "hyperliquidFills"` |

**Each reference file contains:** query structure, filter fields, indexing status, examples, and data-type-specific gotchas.

---

## Step 3: Construct Your Query

All Portal queries use the same endpoint pattern:

```
POST https://portal.sqd.dev/datasets/{dataset-name}/stream
Content-Type: application/json
Accept: application/x-ndjson
```

### Minimal Query Template

```json
{
  "type": "<evm|solana|substrate|bitcoin|tron|hyperliquidFills>",
  "fromBlock": <start-block>,
  "toBlock": <end-block>,
  "<data-key>": [{ <filters> }],
  "fields": {
    "<field-key>": { <field-selection> }
  }
}
```

| Data Type | Data Key | Field Key |
|---|---|---|
| EVM Logs | `"logs"` | `"log"` |
| EVM Transactions | `"transactions"` | `"transaction"` |
| EVM Traces | `"traces"` | `"trace"` |
| Solana Instructions | `"instructions"` | `"instruction"` |
| Substrate Events | `"events"` | `"event"` |
| Substrate Calls | `"calls"` | `"call"` |
| Bitcoin Transactions | `"transactions"` | `"transaction"` |
| Bitcoin Inputs | `"inputs"` | `"input"` |
| Bitcoin Outputs | `"outputs"` | `"output"` |
| Tron Logs | `"logs"` | `"log"` |
| Tron Transactions | `"transactions"` | `"transaction"` |
| Tron Internal Txs | `"internalTransactions"` | `"internalTransaction"` |
| Hyperliquid Fills | `"fills"` | `"fill"` |

> Tron also has dedicated request keys for native TRX transfers (`"transferTransactions"`), TRC-10 (`"transferAssetTransactions"`), and contract calls (`"triggerSmartContractTransactions"`) — see `references/tron.md`.

### Quick Examples

**EVM: USDC Transfers on Base**
```json
{
  "type": "evm",
  "fromBlock": 10000000, "toBlock": 10000100,
  "logs": [{"address": ["0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"], "topic0": ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"]}],
  "fields": {"log": {"address": true, "topics": true, "data": true, "transactionHash": true}}
}
```
Dataset: `base-mainnet`

**Solana: Jupiter Swaps**
```json
{
  "type": "solana",
  "fromBlock": 250000000, "toBlock": 250001000,
  "instructions": [{"programId": ["JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"], "d8": ["0x5703feb8e7573909"]}],
  "fields": {"instruction": {"programId": true, "accounts": true, "data": true}}
}
```
Dataset: `solana-mainnet`

**Substrate: DOT Transfers on Polkadot**
```json
{
  "type": "substrate",
  "fromBlock": 20000000, "toBlock": 20000100,
  "events": [{"name": ["Balances.Transfer"]}],
  "fields": {"block": {"number": true, "timestamp": true}, "event": {"name": true, "args": true}}
}
```
Dataset: `polkadot`

> **Note:** Real-time streaming is not supported for Substrate chains. Only finalized historical data is available.

**Bitcoin: Payments to an Address**
```json
{
  "type": "bitcoin",
  "fromBlock": 940000, "toBlock": 940110,
  "outputs": [{"scriptPubKeyAddress": ["bc1qxhmdufsvnuaaaer4ynz88fspdsxq2h9e9cetdj"], "transaction": true}],
  "fields": {"block": {"number": true, "timestamp": true}, "transaction": {"txid": true}, "output": {"value": true, "scriptPubKeyAddress": true}}
}
```
Dataset: `bitcoin-mainnet`

**Tron: USDT (TRC-20) Transfers**
```json
{
  "type": "tron",
  "fromBlock": 84000000, "toBlock": 84000010,
  "logs": [{"address": ["a614f803b6fd780986a42c78ec9c7f77e6ded13c"], "topic0": ["ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"], "transaction": true}],
  "fields": {"block": {"number": true, "timestamp": true}, "log": {"address": true, "topics": true, "data": true, "transactionIndex": true}, "transaction": {"hash": true, "transactionIndex": true}}
}
```
Dataset: `tron-mainnet`

> **Tron gotchas:** all hex is bare (no `0x`); transaction-level addresses are 21-byte `41…` hex, but **log addresses use the 20-byte form without `41`** (never base58 `T…`); timestamps are **milliseconds**. See `references/tron.md`.

**Hyperliquid: BTC Fills**
```json
{
  "type": "hyperliquidFills",
  "fromBlock": 920000000, "toBlock": 920000100,
  "fills": [{"coin": ["BTC"]}],
  "fields": {"fill": {"coin": true, "side": true, "px": true, "sz": true, "user": true, "dir": true}}
}
```
Dataset: `hyperliquid-fills`

> **More examples:** See the reference file for each data type.

---

## Working with Time Ranges (Timestamp → Block)

To query a time range like "last 4 hours" or "since yesterday" without guessing blocks, resolve a Unix timestamp (in seconds) to the first block at or after that time:

```
GET https://portal.sqd.dev/datasets/{dataset}/timestamps/{unix-seconds}/block
→ {"block_number": 25043068}
```

**Works for both archived AND real-time data** — resolve timestamps from minutes ago, not just historical ranges. Available on every dataset (EVM, Solana, Substrate, Bitcoin, Tron, Hyperliquid).

### Example: "USDC transfers on Base in the last 4 hours"

```bash
NOW=$(date +%s)
FROM=$(curl -s https://portal.sqd.dev/datasets/base-mainnet/timestamps/$((NOW - 4*3600))/block | jq -r .block_number)
TO=$(curl -s https://portal.sqd.dev/datasets/base-mainnet/head | jq -r .number)
# Use $FROM and $TO as fromBlock / toBlock in your stream query
```

### MCP equivalent

`portal_debug_resolve_time_to_block` does the same in one call and works for real-time blocks too.

### Errors

- `404 {"message":"block not in hotblocks"}` — timestamp is in the future, or beyond the dataset head
- `404 Unknown dataset` — wrong dataset name (see Step 1)

> **Don't estimate blocks from `(now - ts) / block_time`** — block times vary and the result drifts by hundreds of blocks. Use this endpoint instead.

---

## MCP Tools Quick Reference

If Portal MCP tools are available, prefer them for bounded interactive work. The current Portal MCP server exposes 25 public tools plus 3 advanced/debug tools. Legacy aliases are not exposed. Public query params use `network`; discovery filters use `vm`.

Use `sqd://tools` or HTTP `/tools` when available for the live catalog. The table below is a compact orientation, not the source of truth.

Current hosted-server behaviors worth relying on:
- **Unified response envelope** — every tool returns the same contract keys (`answer`, `display`, `next_steps`, `investigation`, `_freshness`, `_pagination`, `_coverage`, `_ordering`, `_execution`, `_tool_contract`); read these to judge completeness and next pivots.
- **Natural-language time windows** — time-based tools accept human ranges (`"last hour"`, `"past 30 minutes"`, `"30 minutes ago"`) directly, so you can pass a time range instead of resolving blocks yourself.
- **`token_symbols` inputs** — `portal_evm_query_logs` / `portal_evm_query_token_transfers` accept `token_symbols`, and `portal_evm_query_transactions` accepts `from_token_symbols` / `to_token_symbols` (token-list backed).

### Discovery & Overview

| Tool | Use Case |
|------|----------|
| `portal_list_networks` | Search networks by name, chain type, network type |
| `portal_get_network_info` | Get dataset metadata: latest block, start block, tables |
| `portal_get_head` | Get current/latest block for a dataset |
| `portal_resolve_entity` | Resolve token symbols, contracts, protocols, pools, and Hyperliquid coins into query-ready filters |
| `portal_get_recent_activity` | Recent activity on a dataset with auto block calculation |
| `portal_debug_resolve_time_to_block` | Find block number at a timestamp — works for real-time blocks too |
| `portal_debug_query_blocks` | Inspect raw block headers for diagnostics |

### EVM Queries

| Tool | Use Case |
|------|----------|
| `portal_evm_query_logs` | Query event logs with address/topic filters |
| `portal_evm_query_transactions` | Query transactions by sender/recipient/sighash |
| `portal_evm_query_token_transfers` | ERC20/ERC721/ERC1155 transfers with optional token info |
| `portal_evm_get_contract_activity` | Contract interaction stats |
| `portal_evm_get_contract_deployment` | Look up deployment block/tx for a contract address |
| `portal_evm_get_analytics` | Aggregate metrics: tx counts, gas, transfer volumes, top contracts |
| `portal_evm_get_ohlc` | OHLC candles from on-chain DEX swap data |

### Solana Queries

| Tool | Use Case |
|------|----------|
| `portal_solana_query_instructions` | Instructions with program/discriminator/account filters |
| `portal_solana_query_transactions` | Transactions by fee payer or account |
| `portal_solana_get_analytics` | Aggregate Solana metrics |

### Substrate Queries

| Tool | Use Case |
|------|----------|
| `portal_substrate_query_events` | Pallet events with section/method filters |
| `portal_substrate_query_calls` | Extrinsic calls with section/method filters |
| `portal_substrate_get_analytics` | Aggregate Substrate metrics |

### Hyperliquid Queries

| Tool | Use Case |
|------|----------|
| `portal_hyperliquid_query_fills` | Trade fills by coin, user, direction |
| `portal_hyperliquid_get_analytics` | Aggregate fill metrics (volume, count, by coin) |
| `portal_hyperliquid_get_ohlc` | OHLC candles from Hyperliquid fills |
| `portal_debug_hyperliquid_query_replica_commands` | Advanced/debug access to low-level replica commands |

### Bitcoin Queries

| Tool | Use Case |
|------|----------|
| `portal_bitcoin_query_transactions` | Raw Bitcoin txs by block/time range; optionally attach inputs & outputs inline (`include_inputs`/`include_outputs`). No address/type filtering — use the Stream API for that |
| `portal_bitcoin_get_analytics` | Bitcoin network snapshot: block cadence, fees, SegWit/Taproot adoption, unique-address activity |

### Tron Queries

No Tron-specific MCP tools yet. Dataset-agnostic tools (`portal_list_networks`, `portal_get_network_info`, `portal_get_head`, `portal_debug_resolve_time_to_block`) accept `tron-mainnet`; for Tron data queries use the raw Portal Stream API with `"type": "tron"` — see `references/tron.md`.

### Cross-Chain Analytics

| Tool | Use Case |
|------|----------|
| `portal_get_wallet_summary` | Wallet txs + token transfers in one call |
| `portal_get_time_series` | Bucketed metrics over time (tx count, gas, etc.) |

---

## Raw Portal Stream API / Curl Fallback

Use raw Stream API when:
- The user asks for raw rows, the last N records, an export, CSV/JSON/NDJSON, or reproducible curl.
- MCP compact output proves the query shape but truncates the payload.
- You need exact Portal request bodies for debugging or handoff.
- The user needs to run the same request outside the MCP client.

Endpoint shape:

```bash
curl -sS -X POST "https://portal.sqd.dev/datasets/{dataset}/stream" \
  -H "content-type: application/json" \
  -H "accept: application/x-ndjson" \
  --data @query.json > results.ndjson
```

Always keep raw queries bounded. Prefer a short MCP discovery step first, such as current head/network freshness or entity resolution, then use that evidence to construct the curl request.

---

## Durable Pipelines: Pipes and Squid

Do not stretch ad hoc Portal queries into production architecture.

Recommend Pipes or a Squid when the user needs:
- repeated polling or real-time ingestion
- historical backfills
- joins across entities or datasets
- durable storage
- transformations and decoded domain models
- app/backend APIs
- alerts, dashboards, or scheduled jobs

Phrase the handoff clearly: Portal MCP is for answering and exploring; raw Stream API is for reproducible one-off extraction; Pipes/Squid is for maintained data pipelines.

---

## Response Format

All Portal responses use **JSON Lines** (NDJSON) — one JSON object per line:

```
{"header":{"number":19500000,"hash":"0x...","parentHash":"0x...","timestamp":1234567890}}
{"logs":[...]}
{"transactions":[...]}
```

**Parsing:** Split by newlines, parse each line as JSON. First line is always the block header.

---

## Common Mistakes (All Data Types)

### Wrong Dataset Name
```
POST /datasets/ethereum/stream  ❌
POST /datasets/ethereum-mainnet/stream  ✅
```
Always verify with the mapping table or `portal_list_networks`.

### Missing `type` Field
```json
{"fromBlock": 19500000, "logs": [{}]}  ❌ — missing "type": "evm"
```
Every query MUST include `type`.

### Wrong `type` for Dataset
- EVM chains (Ethereum, Arbitrum, Base, etc.) → `"type": "evm"`
- Solana → `"type": "solana"`
- Substrate chains (Polkadot, Kusama, parachains) → `"type": "substrate"` (NOT `"evm"`)
- Bitcoin → `"type": "bitcoin"` (NOT `"evm"`)
- Tron (`tron-mainnet`) → `"type": "tron"` (bare hex — no `0x`; `41…` addresses; ms timestamps)
- Hyperliquid fills → `"type": "hyperliquidFills"`
- HyperEVM (`hyperliquid-mainnet`) → `"type": "evm"` (NOT `"hyperliquidFills"`)
- Frontier parachains (`moonbeam-substrate`) → `"type": "substrate"` (NOT `"evm"`; use `evmLogs` filter)

### Too Broad Query
```json
{"fromBlock": 0, "logs": [{}]}  ❌ — millions of results
```
Always add address/topic/programId filters and reasonable block ranges.

---

## Performance Tips

1. **Always filter by address/programId** — 10-100x faster
2. **Add topic0/sighash/discriminator** — another 10x
3. **Use narrow block ranges** when exploring (100-10K blocks)
4. **Request only needed fields** — reduces response size
5. **Use MCP summary, analytics, and time-series tools** for overview before querying full data

---

## Additional Resources

- **[Available Datasets](https://portal.sqd.dev/datasets)** — Complete list of supported networks
- **[Portal MCP Server](https://docs.sqd.dev/en/ai/mcp-server)** — Hosted MCP endpoint and current tool reference
- **[llms.txt](https://docs.sqd.dev/llms.txt)** — Quick reference for Portal API
- **[llms-full.txt](https://docs.sqd.dev/llms-full.txt)** — Complete Portal documentation
- **[EVM OpenAPI Schema](https://docs.sqd.dev/en/ai/evm-openapi)** — EVM API specification
- **[Solana OpenAPI Schema](https://docs.sqd.dev/en/ai/solana-openapi)** — Solana API specification
- **[Substrate OpenAPI Schema](https://docs.sqd.dev/en/ai/substrate-openapi)** — Substrate API specification
- **[Bitcoin OpenAPI Schema](https://docs.sqd.dev/en/ai/bitcoin-openapi)** — Bitcoin API specification
- **[Tron OpenAPI Schema](https://docs.sqd.dev/en/ai/tron-openapi)** — Tron API specification
- **[Hyperliquid Fills OpenAPI](https://docs.sqd.dev/en/ai/hyperliquid-openapi)** — Hyperliquid API specification
- **Event Signature Calculator:** https://www.4byte.directory/
- **Function Selector Database:** https://www.4byte.directory/
