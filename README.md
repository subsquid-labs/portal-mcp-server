# SQD Portal MCP Server

MCP server for querying blockchain data across EVM, Solana, Bitcoin, and Hyperliquid via the [SQD Portal API](https://docs.sqd.dev/portal/).

## How it works

```
MCP Client  ->  MCP Tools (this server)  ->  Portal API (portal.sqd.dev)
```

This server provides 34 MCP tools that wrap Portal's streaming API. Each tool validates parameters, constructs a Portal request, and returns formatted results — all blockchain data comes from Portal's infrastructure.

## Supported chains

- **EVM** — Ethereum, Base, Arbitrum, Polygon, and 100+ more
- **Solana** — mainnet and devnet
- **Bitcoin** — mainnet
- **Hyperliquid** — trade fills

## Tools

### Dataset tools (2)

| Tool | Description |
|------|-------------|
| `portal_list_datasets` | Search and filter available datasets |
| `portal_get_dataset_info` | Get dataset metadata, tables, and latest block |

### EVM tools (9)

| Tool | Description |
|------|-------------|
| `portal_get_block_number` | Get latest or finalized block number |
| `portal_block_at_timestamp` | Convert Unix timestamp to block number |
| `portal_query_blocks` | Query block data with field presets |
| `portal_query_logs` | Query event logs with address/topic filters |
| `portal_query_transactions` | Query transactions by sender, recipient, or sighash |
| `portal_query_traces` | Query internal transactions and traces |
| `portal_query_state_diffs` | Query storage state changes |
| `portal_get_erc20_transfers` | Get ERC20 token transfers |
| `portal_get_nft_transfers` | Get ERC721/ERC1155 NFT transfers |

### Solana tools (6)

| Tool | Description |
|------|-------------|
| `portal_query_solana_transactions` | Query transactions by fee payer or account |
| `portal_query_solana_instructions` | Query program instructions with account filters |
| `portal_query_solana_balances` | Query SOL balance changes |
| `portal_query_solana_token_balances` | Query SPL token balance changes |
| `portal_query_solana_logs` | Query program log messages |
| `portal_query_solana_rewards` | Query block rewards |

### Bitcoin tools (3)

| Tool | Description |
|------|-------------|
| `portal_query_bitcoin_transactions` | Query Bitcoin transactions |
| `portal_query_bitcoin_inputs` | Query transaction inputs |
| `portal_query_bitcoin_outputs` | Query transaction outputs |

### Hyperliquid tools (2)

| Tool | Description |
|------|-------------|
| `portal_query_hyperliquid_fills` | Query trade fills with PnL, fees, routing |
| `portal_query_hyperliquid_replica_cmds` | Query replica commands |

### Convenience tools (7)

Higher-level tools that combine multiple queries for common tasks.

| Tool | Description |
|------|-------------|
| `portal_get_recent_transactions` | Get recent transactions without manual block math |
| `portal_get_wallet_summary` | Wallet activity: transactions, tokens, NFTs |
| `portal_get_contract_activity` | Contract interaction count, callers, events |
| `portal_get_gas_analytics` | Gas prices, percentiles, cost estimates |
| `portal_get_top_contracts` | Most active contracts by transaction count |
| `portal_get_transaction_density` | Transaction count per block |
| `portal_get_time_series` | Aggregate metrics over time intervals |

### Aggregation tools (2)

| Tool | Description |
|------|-------------|
| `portal_count_events` | Count events by contract or event type |
| `portal_aggregate_transfers` | ERC20 transfer volume and unique address stats |

### Enrichment tools (1)

| Tool | Description |
|------|-------------|
| `portal_get_token_info` | Token metadata from CoinGecko (name, symbol, decimals) |

### Utility tools (2)

| Tool | Description |
|------|-------------|
| `portal_stream` | Raw Portal API streaming queries |
| `portal_decode_logs` | Decode event logs (Transfer, Swap, etc.) |

## Time ranges

Most tools support a `timeframe` parameter (`1h`, `24h`, `7d`, etc.) as an alternative to specifying block numbers. The server converts timeframes to block ranges automatically using Portal's timestamp-to-block API.

## Setup

```bash
pnpm install
pnpm run build
```

### Transports

- **stdio** (default): `pnpm start` — for Claude Desktop and Claude Code
- **HTTP/SSE**: `pnpm start:http` — Streamable HTTP transport with Prometheus metrics at `/metrics`

### Use with Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "sqd-portal": {
      "command": "node",
      "args": ["/path/to/sqd-portal-mcp/dist/index.js"]
    }
  }
}
```

### Docker

```bash
docker build -t sqd-portal-mcp .
docker run -p 3001:3001 sqd-portal-mcp
```

### Test with MCP Inspector

```bash
pnpm run inspect
```

## Development

```bash
pnpm run dev        # stdio transport (tsx)
pnpm run dev:http   # HTTP transport (tsx)
pnpm run test       # smoke tests
```

## Performance

Most queries return in under 2 seconds. Recommended block ranges for fast responses:

- **Logs**: <10,000 blocks
- **Transactions**: <5,000 blocks
- **Traces**: <1,000 blocks

All tools support a `limit` parameter to cap result size, which allows safe queries over large block ranges.
