# SQD Portal MCP Server

MCP server wrapping the SQD Portal API.

## Architecture

This MCP server is a **thin wrapper** around the [SQD Portal API](https://docs.sqd.dev/portal/).

```
Claude/MCP Client  -> MCP Tools (this server)  -> Portal API (https://portal.sqd.dev)
```

All blockchain data queries are handled by Portal's infrastructure. This server simply:
- Provides MCP tool interfaces
- Validates parameters
- Constructs Portal API requests
- Returns formatted results

For API details, see:
- **EVM API**: OpenAPI schema at `/Users/account/sqd-docs-1/en/api/evm/openapi.yaml`
- **Solana API**: OpenAPI schema at `/Users/account/sqd-docs-1/en/api/solana/openapi.yaml`
- **Development Guide**: See `CLAUDE.md` for architecture details and common pitfalls

## Performance

**Average response time**: ~200ms
**Target**: All queries complete in <3 seconds

### Recommended Block Ranges
- **Logs**: <10,000 blocks (~500ms)
- **Transactions**: <5,000 blocks (~100ms)
- **Traces**: <1,000 blocks (~2s)

**Pro tip**: Always use `portal_get_head` to fetch the latest block dynamically. Never hardcode block numbers!

See [PERFORMANCE_GUIDE.md](PERFORMANCE_GUIDE.md) for detailed optimization tips.

## Tools

| Tool | Endpoint |
|------|----------|
| `portal_list_datasets` | GET /datasets |
| `portal_get_metadata` | GET /datasets/{dataset}/metadata |
| `portal_get_head` | GET /datasets/{dataset}/head |
| `portal_get_finalized_head` | GET /datasets/{dataset}/finalized-head |
| `portal_block_at_timestamp` | GET /datasets/{dataset}/timestamps/{timestamp}/block |
| `portal_stream` | POST /datasets/{dataset}/stream |
| `portal_finalized_stream` | POST /datasets/{dataset}/finalized-stream |

## Setup

```bash
pnpm install
pnpm run build
```

## Test with MCP Inspector

```bash
pnpm run inspect
```

## Use with Claude Desktop

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

### Architecture

The Cloudflare Worker version uses:
- `src/worker.ts` - Main worker entry point
- `WebStandardStreamableHTTPServerTransport` from MCP SDK - Standards-compliant HTTP/SSE transport
- Standard Fetch API for Portal API calls
- JSON-RPC 2.0 over Server-Sent Events (SSE)

### Important Notes

- The worker currently includes only a basic `portal_list_datasets` tool as a proof-of-concept
- To add more tools, either:
  1. Copy tool registrations from `src/index.ts` into `src/worker.ts`, or
  2. Refactor `src/index.ts` to export a reusable server creation function
- The MCP protocol requires:
  - `Accept: application/json, text/event-stream` header
  - Initialize the connection before calling tools
  - Responses are in SSE format (`event: message\ndata: {...}`)
