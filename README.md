# SQD Portal MCP Server

MCP server for querying blockchain data across EVM, Solana, Bitcoin, Substrate, and Hyperliquid through the [SQD Portal API](https://portal.sqd.dev).

## What v0.7.7 Changes

`v0.7.7` is a clean product-surface redesign:

- `network` replaces `dataset` in the public API
- `vm` replaces `chain_type` in discovery filters
- raw data tools use `query_*`
- summaries, analytics, and charts use `get_*`
- the public surface is intentionally smaller and grouped by user job

This release exposes:

- 23 public tools
- 3 advanced/debug tools
- 0 legacy tool names

## Product Model

The server is designed around four user jobs:

1. Discover a network
2. Query raw chain data
3. Summarize recent activity or a wallet
4. Chart activity and OHLC data

Raw tools are VM-specific when the underlying data model differs. Convenience tools stay cross-chain when the user intent is the same.

## Best Tool for Common Questions

Start with these tools first. They are the most agent-friendly entry points.

| Question | Best tool | Why |
|------|------|------|
| "What network should I use for Base / Monad / Hyperliquid?" | `portal_list_networks` | Discovers the exact supported network name and aliases |
| "Is this network fresh and indexed?" | `portal_get_network_info` | Shows head, finalized head, lag, and available tables |
| "What is the latest head right now?" | `portal_get_head` | Fastest way to get the current indexed head |
| "Show me recent activity on this chain" | `portal_get_recent_activity` | First-choice recent feed across EVM, Solana, Bitcoin, and Hyperliquid |
| "Summarize this wallet" | `portal_get_wallet_summary` | One-call cross-chain wallet view with shared sections |
| "Chart activity over time" | `portal_get_time_series` | First-choice chart tool for scalar metrics, compare-previous, and grouped trends |
| "Give me raw EVM transactions" | `portal_evm_query_transactions` | Raw transaction tool with optional deeper include flags |
| "Give me raw EVM logs" | `portal_evm_query_logs` | Raw log tool with topic filters and inline `decode: true` |
| "Show token transfers on EVM" | `portal_evm_query_token_transfers` | Easier than building Transfer log filters manually |
| "Which contracts are most active on this EVM network?" | `portal_evm_get_analytics` | Ranked contract analytics rather than raw records |
| "Show me Solana program activity" | `portal_solana_query_instructions` | Raw instruction tool with program/account filters |
| "How is Solana doing right now?" | `portal_solana_get_analytics` | Solana throughput, fee, and program snapshot |
| "Give me raw Bitcoin transactions / UTXO context" | `portal_bitcoin_query_transactions` | Raw Bitcoin tx tool with inline `inputs` / `outputs` |
| "How is Bitcoin doing right now?" | `portal_bitcoin_get_analytics` | Network-level Bitcoin analytics |
| "Show me raw Substrate events" | `portal_substrate_query_events` | Raw Substrate event tool with optional extrinsic and call context |
| "Show me raw Substrate calls" | `portal_substrate_query_calls` | Raw Substrate call tool with optional subcalls, events, and extrinsic context |
| "How is this Substrate network doing?" | `portal_substrate_get_analytics` | Substrate snapshot with event, call, and extrinsic activity rankings |
| "Show me Hyperliquid fills" | `portal_hyperliquid_query_fills` | Raw fill records with trader, coin, fee, and PnL context |
| "How is Hyperliquid trading right now?" | `portal_hyperliquid_get_analytics` | Grouped Hyperliquid trading analytics |
| "Give me candles / OHLC" | `portal_hyperliquid_get_ohlc` or `portal_evm_get_ohlc` | Use OHLC tools only when you truly need candle-shaped output |

## Public Tools

### Discovery

| Tool | Description |
|------|-------------|
| `portal_list_networks` | Search supported networks and filter by `vm`, `network_type`, and related metadata |
| `portal_get_network_info` | Get network metadata, indexed head, lag, tables, and capabilities |
| `portal_get_head` | Get the latest indexed head block or slot for a network |

### Cross-Chain Convenience

| Tool | Description |
|------|-------------|
| `portal_get_recent_activity` | Get recent normalized activity for a network without manual block math |
| `portal_get_wallet_summary` | Get a cross-chain wallet summary with shared `overview`, `activity`, and `assets` sections |
| `portal_get_time_series` | Get time-series metrics, grouped trends, and compare-previous windows across supported VMs |

### EVM

| Tool | Description |
|------|-------------|
| `portal_evm_query_transactions` | Query EVM transactions with optional traces and state-related context |
| `portal_evm_query_logs` | Query EVM logs with address/topic filters and optional inline decoding via `decode: true` |
| `portal_evm_query_token_transfers` | Query token transfer activity on EVM networks |
| `portal_evm_get_contract_activity` | Summarize a contract’s recent interaction activity |
| `portal_evm_get_analytics` | Get network-wide EVM analytics, including top-contract rankings |
| `portal_evm_get_ohlc` | Build chart-ready EVM OHLC candles from supported pool/event sources such as Uniswap v3, Uniswap v4 PoolManager swaps, Aerodrome Slipstream, and generic Sync-derived CPMM pools |

### Solana

| Tool | Description |
|------|-------------|
| `portal_solana_query_transactions` | Query Solana transactions with optional balances, rewards, and logs |
| `portal_solana_query_instructions` | Query Solana instructions with program and account filters |
| `portal_solana_get_analytics` | Get Solana analytics for throughput, fees, and program activity |

### Bitcoin

| Tool | Description |
|------|-------------|
| `portal_bitcoin_query_transactions` | Query Bitcoin transactions and optionally attach `inputs` / `outputs` inline |
| `portal_bitcoin_get_analytics` | Get Bitcoin analytics for transactions, fees, and block-level activity |

### Substrate

| Tool | Description |
|------|-------------|
| `portal_substrate_query_events` | Query Substrate events with optional parent extrinsic, emitting call, and call-stack context |
| `portal_substrate_query_calls` | Query Substrate calls with optional subcalls, parent extrinsic, call stack, and emitted events |
| `portal_substrate_get_analytics` | Get Substrate analytics for event, call, and extrinsic activity over a selected window |

### Hyperliquid

| Tool | Description |
|------|-------------|
| `portal_hyperliquid_query_fills` | Query Hyperliquid fills with trader, coin, fee, and PnL context |
| `portal_hyperliquid_get_analytics` | Get Hyperliquid analytics, including grouped fill aggregates as sections |
| `portal_hyperliquid_get_ohlc` | Build chart-ready Hyperliquid trade OHLC candles with auto intervals |

## Advanced Tools

These tools stay available, but they are not part of the core public surface.

| Tool | Description |
|------|-------------|
| `portal_debug_query_blocks` | ADVANCED: query raw block records for EVM, Solana, Bitcoin, or Substrate |
| `portal_debug_resolve_time_to_block` | ADVANCED: resolve a timestamp to the nearest indexed block/slot on supported networks |
| `portal_debug_hyperliquid_query_replica_commands` | ADVANCED: inspect Hyperliquid replica command records |

## Public API Conventions

### Shared parameter names

- `network`: public network name or alias
- `vm`: discovery filter for virtual machine family
- `timeframe`: natural time window such as `1h`, `24h`, or `7d`
- `from_block` / `to_block`: explicit block or slot window
- `from_timestamp` / `to_timestamp`: natural time input such as relative text, ISO datetimes, or Unix timestamps
- `cursor`: continuation cursor for paging
- `mode`: `fast` or `deep` for heavier summary and chart tools
- `response_format`: `summary`, `compact`, or `full` where supported

### Shared response envelope

Public tools use a shared metadata envelope when applicable:

- `_summary`
- `_llm`
- `_tool_contract`
- `_execution`
- `_freshness`
- `_coverage`
- `_pagination`
- `_ordering`

Chart responses also include `chart`, and time-series / OHLC responses include `gap_diagnostics`.

### LLM-friendly rendering contract

Chart-heavy and dashboard-style responses now also expose:

- `_ui`: a `portal_ui_v1` presentation contract for cards, panels, and follow-up actions
- `_llm`: a `portal_llm_v1` layer with primary paths, flattened key metrics, section order, and render hints
- `chart`: chart metadata with tooltip, interaction, and formatting hints
- `tables`: sortable/searchable table descriptors for primary arrays

### Agent-specific response hints

- `_llm` gives models the shortest path to a good answer: what section to read first, which data path is primary, what metrics to surface, what render/view is preferred, and what follow-up targets exist.
- `_tool_contract` tells an agent what kind of tool it is using: audience, category, intent, VM family, result kind, normalized output, and key support flags such as pagination or response formats.
- `_execution` tells an agent how the result was produced: scan window, fast/deep mode, response format, chart interval, compare/group settings, and similar runtime details.
- Raw query tools now prefer normalized aliases such as `chain_kind`, `record_type`, `primary_id`, `tx_hash`, `timestamp`, and `timestamp_human` so clients can switch between VMs with less custom parsing.

## Supported Networks

- **EVM**: Ethereum, Base, Arbitrum, Optimism, Polygon, Monad, Hyperliquid EVM, and many more
- **Solana**: mainnet and related indexed environments
- **Bitcoin**: mainnet
- **Substrate**: Polkadot-family and related indexed networks, currently without real-time tailing
- **Hyperliquid**: fills and replica-command datasets

## Time Windows

Most tools support either:

- explicit block windows via `from_block` / `to_block`
- natural windows via `timeframe`
- precise windows via `from_timestamp` / `to_timestamp`

Examples:

- `timeframe: "1h"`
- `from_timestamp: "yesterday 09:00", to_timestamp: "today 09:00"`
- `from_timestamp: "6h ago", to_timestamp: "now"`

## Setup

```bash
npm install
npm run build
```

## Run

### stdio

```bash
npm start
```

### HTTP / SSE

```bash
npm run start:http
```

HTTP mode exposes:

- `/metrics` for Prometheus metrics
- `/health` for a simple health check

## Claude Desktop

Add this to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "sqd-portal": {
      "command": "node",
      "args": ["/absolute/path/to/sqd-portal-mcp/dist/index.js"]
    }
  }
}
```

## Docker

```bash
docker build -t sqd-portal-mcp .
docker run -p 3001:3001 sqd-portal-mcp
```

## Development

```bash
npm run dev
npm run dev:http
npm test
npm run test:tools
```

## Notes

- This server is a thin wrapper around the SQD Portal API. It does not index chains itself.
- `limit` is supported across the raw query surface to keep MCP responses manageable.
- For best UX, prefer natural time windows or relatively tight block ranges, then page with `_pagination.next_cursor` when needed.
