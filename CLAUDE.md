# SQD Portal MCP Server

## What This Is

This is an **MCP (Model Context Protocol) wrapper** around the **SQD Portal API**.

**Simple architecture:**
```
Claude/MCP Client  -> MCP Tools (this server)  -> Portal API (https://portal.sqd.dev)
```

## Core Concept

Every tool in this server is a **thin wrapper** that:
1. Takes user-friendly parameters
2. Validates them
3. Constructs a Portal API request
4. Sends it to `https://portal.sqd.dev/datasets/{dataset}/stream`
5. Returns the results

**We are NOT implementing blockchain queries ourselves** - we're just wrapping Portal's existing API.

## Portal API Reference

The actual API we're wrapping is documented here:
- **EVM API**: `/Users/account/sqd-docs-1/en/api/evm/openapi.yaml`
- **Solana API**: `/Users/account/sqd-docs-1/en/api/solana/openapi.yaml`
- **Live endpoint**: `https://portal.sqd.dev/datasets/{dataset}/stream`

When debugging, always check the OpenAPI schema to understand what Portal expects.

## Request Format

All queries use `POST /datasets/{dataset}/stream` with:

```json
{
  "type": "evm" | "solana",
  "fromBlock": 123,
  "toBlock": 456,
  "logs": [{ "address": ["0x..."], "topic0": ["0x..."] }],
  "transactions": [{ "from": ["0x..."] }],
  "fields": {
    "block": { "number": true, "hash": true },
    "log": { "address": true, "topics": true, "data": true }
  }
}
```

## Key Files

- `src/helpers/fetch.ts` - `portalFetch()` and `portalFetchStream()` - the actual API calls
- `src/tools/evm/` - EVM query tools (logs, transactions, traces, etc.)
- `src/tools/solana/` - Solana query tools
- `src/constants/index.ts` - `PORTAL_URL` and other config
- OpenAPI schemas - `/Users/account/sqd-docs-1/en/api/{evm|solana}/openapi.yaml`

## Common Pitfalls

1. **Parameter names must match Portal API**: e.g., `addresses` (array), not `address` (string)
2. **Block ranges**: Keep queries reasonable (<100k blocks for logs). Large ranges can timeout.
3. **Query type**: Must include `type: "evm"` or `type: "solana"` in the body
4. **Address format**: EVM addresses must be lowercase (Portal normalizes them)
5. **CRITICAL - Field vs Filter naming**:
   - **Filter parameters** use `topic0`, `topic1`, `topic2`, etc. (for selecting WHICH logs to fetch)
   - **Response fields** use `topics` (the full array - for WHAT data to return)
   - Example: `logs: [{ topic0: ["0x..."] }]` (filter) vs `fields: { log: { topics: true } }` (response)
   - This confusion caused bugs where `topic0: true` in field selection failed with "unknown field 'topic0'"
6. **Validation with limit parameter**:
   - Unfiltered queries are normally limited to <100 blocks to prevent memory crashes
   - **EXCEPTION**: If `limit <= 100`, any block range is allowed (even unfiltered)
   - Why: The `limit` parameter naturally caps result size, making large ranges safe
   - Example: `timeframe="1h"` (1800 blocks) + `limit=3` works fine without filters
   - This enables common MCP patterns like "show me a few recent transactions"
7. **Timestamp-to-Block Conversion**:
   - Portal provides `GET /datasets/{dataset}/timestamps/{timestamp}/block` endpoint
   - Directly converts Unix timestamps to block numbers - no need to estimate block times!
   - Example: `GET /datasets/base-mainnet/timestamps/1738800000/block` → `{"block_number": 26005327}`
   - Use `src/helpers/timestamp-to-block.ts` helper functions for time-based queries

## Performance Guidelines

### Real-World Benchmarks (Base Mainnet)

Based on actual testing (2026-02-05):

| Query Type | Block Range | Response Time | UX Rating |
|-----------|-------------|---------------|-----------|
| Logs | 1k blocks | ~600ms | [FAST] Excellent |
| Logs | 10k blocks | ~1,300ms | [OK] Good |
| Logs | 100k blocks | ~1,200ms* | [WARN] Acceptable |
| Transactions | 1k blocks | ~130ms | [FAST] Excellent |
| Transactions | 5k blocks | ~900ms | [FAST] Excellent |
| Metadata | - | ~50ms | [FAST] Excellent |

\* Results vary based on event density

### Recommended Ranges for Fast UX (<1-3s)
- **Logs**: <10,000 blocks (~1s response)
- **Transactions**: <5,000 blocks (~500ms response)
- **Traces**: <1,000 blocks (expensive, 2-5s)

### Why These Limits?

The Portal API is very fast (average ~900ms), but:
1. Large result sets take time to transfer
2. User experience: <3s feels instant, >5s feels slow
3. Timeout safety: Default is 15s, stay well below

For larger ranges:
- Use `finalized_only: true` to avoid reorgs
- Paginate in chunks of 5-10k blocks
- Filter by address/topic to reduce result size

See `PERFORMANCE_GUIDE.md` for detailed optimization tips.

### Timeout Configuration
- Default timeout: 30s (regular fetch)
- Stream timeout: 60s (streaming queries)
- Rate limits: 429 errors include `Retry-After` header

## Testing

### Using MCP Tools

Always get the latest block dynamically:

```javascript
// 1. Get latest block (DO THIS FIRST!)
const head = await portal_get_head({ dataset: "base-mainnet" });
const latestBlock = head.number;

// 2. Query recent data
const logs = await portal_query_logs({
  dataset: "base-mainnet",
  from_block: latestBlock - 1000,  // Last 1k blocks
  to_block: latestBlock,
  addresses: ["0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"]
});
```

**NEVER hardcode block numbers** - chains are constantly producing new blocks!

### Testing Portal API Directly

If MCP tool fails, test Portal API directly to isolate issues:

```bash
# Get latest block first
LATEST=$(curl -s https://portal.sqd.dev/datasets/base-mainnet/head | jq '.number')
FROM=$((LATEST - 1000))

# Query recent data
curl -X POST https://portal.sqd.dev/datasets/base-mainnet/stream \
  -H 'Content-Type: application/json' \
  -d "{\"type\":\"evm\",\"fromBlock\":$FROM,\"toBlock\":$LATEST,\"logs\":[{\"address\":[\"0x833589fcd6edb6e08f4c7c32d4f71b54bda02913\"]}],\"fields\":{\"log\":{\"address\":true,\"topics\":true},\"block\":{\"number\":true}}}"
```

This isolates whether the issue is our wrapper or the Portal API itself.

## Development Commands

- `npm run dev` - Start development server
- `npm run build` - Build the application
- `npm run inspect` - Test with MCP Inspector
- `npm run cf:dev` - Test Cloudflare Worker locally
- `npm run cf:deploy` - Deploy to Cloudflare Workers

## Error Handling

Portal API status codes:
- **204**: No data found (empty result)
- **409**: Chain reorg detected (retry with different fromBlock)
- **429**: Rate limited (check Retry-After header)
- **4xx**: Client errors (invalid parameters)
- **5xx**: Server errors (Portal infrastructure issues)

The wrapper includes automatic retry logic for 409 and 429 errors with exponential backoff.
