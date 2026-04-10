# SQD Portal MCP Server

Thin MCP wrapper around the [SQD Portal API](https://portal.sqd.dev) for blockchain data queries.

This server does not index chains itself. It validates user input, maps it onto Portal requests, and returns MCP-friendly responses.

## Current public surface

- `23` public tools
- `3` advanced/debug tools
- public params use `network`
- discovery filters use `vm`
- no legacy tool aliases in `v0.7.7`

Raw query tools default to compact responses. Ask for `response_format: "full"` only when you need the larger payload.

## Tool groups

Discovery:
- `portal_list_networks`
- `portal_get_network_info`
- `portal_get_head`

Cross-chain convenience:
- `portal_get_recent_activity`
- `portal_get_wallet_summary`
- `portal_get_time_series`

EVM:
- `portal_evm_query_transactions`
- `portal_evm_query_logs`
- `portal_evm_query_token_transfers`
- `portal_evm_get_contract_activity`
- `portal_evm_get_analytics`
- `portal_evm_get_ohlc`

Solana:
- `portal_solana_query_transactions`
- `portal_solana_query_instructions`
- `portal_solana_get_analytics`

Bitcoin:
- `portal_bitcoin_query_transactions`
- `portal_bitcoin_get_analytics`

Substrate:
- `portal_substrate_query_events`
- `portal_substrate_query_calls`
- `portal_substrate_get_analytics`

Hyperliquid:
- `portal_hyperliquid_query_fills`
- `portal_hyperliquid_get_analytics`
- `portal_hyperliquid_get_ohlc`

Advanced/debug:
- `portal_debug_query_blocks`
- `portal_debug_resolve_time_to_block`
- `portal_debug_hyperliquid_query_replica_commands`

## Supported data

- EVM networks indexed by Portal, including Base, Ethereum, Optimism, Arbitrum, Monad, Hyperliquid EVM, and others
- Solana mainnet
- Bitcoin mainnet
- Hyperliquid fills and replica commands
- Substrate networks indexed by Portal

Substrate support is currently historical only. It does not have a real-time tail.

## Response shape

Most tools return a normal result body plus shared metadata such as:

- `_freshness`
- `_coverage`
- `_pagination`
- `_ordering`

Chart-oriented tools also return chart and table descriptors so MCP clients or LLMs can render them without reverse-engineering the payload.

The server does not ship its own frontend. It returns structured data and rendering hints for the client to use.

## Observability

HTTP mode already exposes Prometheus metrics at `/metrics`.

What you can track out of the box:

- tool call counts
- tool latency
- in-flight tool calls
- tool error counts by type
- tool response size
- queries by network and VM
- calls by tool intent
- Portal upstream request counts
- server version

What you can also ship to Grafana Loki directly:

- one structured event per tool call
- tool name, transport, server version, network, VM, intent, duration, response format, mode
- sanitized argument summaries
- error type and truncated error message
- optional forwarded user query text

The MCP server does not see the original human prompt by default. If you want exact user-question capture, your client or proxy must forward it explicitly, for example via `x-mcp-user-query`.

Environment variables:

```bash
# Emit structured JSON telemetry to stderr
OBS_LOG_JSON=true

# Allow capture of forwarded raw user query text from x-mcp-user-query
OBS_CAPTURE_USER_QUERY=false

# Optional direct Loki push
GRAFANA_LOKI_URL=https://<your-loki-host>/loki/api/v1/push
GRAFANA_LOKI_USERNAME=<optional-basic-auth-user>
GRAFANA_LOKI_PASSWORD=<optional-basic-auth-password>
# or:
GRAFANA_LOKI_TOKEN=<optional-bearer-token>

# Optional labels for telemetry
OBS_SERVICE_NAME=sqd-portal-mcp
OBS_ENV=production
GRAFANA_LOKI_TIMEOUT_MS=2500
```

Recommended Grafana setup:

- scrape `/metrics` with Prometheus or Grafana Alloy
- use Loki for structured tool-call events
- chart usage by `tool`, `intent`, `network`, `vm`, `status`, and `server_version`

Starter dashboard:

- import [grafana/portal-mcp-dashboard.json](grafana/portal-mcp-dashboard.json)

Useful PromQL queries:

```promql
# top tools over the selected range
topk(10, sum by (tool) (increase(mcp_tool_calls_total[$__range])))

# p95 tool latency
histogram_quantile(
  0.95,
  sum by (le, tool) (rate(mcp_tool_call_duration_seconds_bucket[$__rate_interval]))
)

# error rate by tool
sum by (tool) (increase(mcp_tool_calls_total{status="error"}[$__range]))
/
clamp_min(sum by (tool) (increase(mcp_tool_calls_total[$__range])), 1)

# top queried networks
topk(15, sum by (dataset) (increase(mcp_dataset_queries_total[$__range])))

# version adoption
sum by (server_version) (increase(mcp_tool_calls_total[$__range]))
```

Useful Loki queries:

```logql
# recent tool-call errors
{app="sqd-portal-mcp", event="mcp_tool_call", status="error"} | json

# recent forwarded user questions
{app="sqd-portal-mcp", event="mcp_tool_call"} | json | user_query!=""

# recent OHLC calls on Base
{app="sqd-portal-mcp", event="mcp_tool_call"} | json | tool="portal_evm_get_ohlc" | network="base-mainnet"
```

If you only have Grafana access and not Cloudflare access, the most realistic deployment path is:

- ask whoever deploys the MCP to expose `/metrics` so Grafana can scrape it
- ask them to set `GRAFANA_LOKI_*` env vars if you want direct Loki push from the MCP server
- optionally ask them to forward `x-mcp-client-name`, `x-mcp-client-version`, `x-mcp-session-id`, and `x-mcp-user-query`

Recommended forwarded headers in HTTP mode:

- `x-request-id`
- `x-mcp-client-name`
- `x-mcp-client-version`
- `x-mcp-session-id`
- `x-mcp-user-query`

## Install

```bash
npm install
npm run build
```

## Run

stdio:

```bash
npm start
```

HTTP:

```bash
npm run start:http
```

## Claude Desktop

Add an entry like this to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "sqd-portal": {
      "command": "node",
      "args": ["/absolute/path/to/sqd-portal-mcp-server/dist/index.js"]
    }
  }
}
```

## Usage notes

- If you do not know the exact network name, start with `portal_list_networks`.
- If you need recent indexed state, use `portal_get_network_info` or `portal_get_head` first.
- If the question is broad, start with `portal_get_recent_activity`, `portal_get_wallet_summary`, or `portal_get_time_series` before dropping to raw queries.
- Use `portal_evm_get_ohlc` and `portal_hyperliquid_get_ohlc` only when you actually need candle-shaped output.
- For large or exploratory queries, prefer `response_format: "compact"` unless you need the full record shape.

## Tests

```bash
npm test
npm run test:tools
npm run test:routing
npm run test:substrate
npm run test:conversations
npm run test:negative
npm run test:quality
npm run test:ci
```

## License

[MIT](LICENSE)
