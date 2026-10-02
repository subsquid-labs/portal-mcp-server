# ClickHouse Analytics Query Patterns

Query patterns for building real-time dashboards on top of ClickHouse tables populated by Pipes SDK indexers. Covers time bucketing, conditional aggregation, parameterized queries, and performance.

## CollapsingMergeTree Basics

Pipes SDK uses `CollapsingMergeTree(sign)` for reorg handling. A rollback appends a matching row with `sign = -1`; filtering to `sign = 1` leaves the original row visible and is therefore not rollback-safe.

Use `FINAL` for correctness-first row and aggregate queries:

```sql
SELECT count() FROM hl_fills FINAL
```

For high-volume reversible aggregates, you can avoid `FINAL` by including the sign in the arithmetic, for example `sum(notional * sign)` or `sum(sign)`. Aggregates such as `min`, `max`, and exact unique counts generally need `FINAL` (or a separately maintained aggregate design) because they cannot be reversed by multiplying the result by `sign`.

## Time Bucketing

`toStartOfInterval` is the workhorse for time-series charts:

```sql
SELECT
  toStartOfInterval(timestamp, INTERVAL 1 HOUR) AS t,
  sum(volume) AS volume
FROM my_table FINAL
GROUP BY t
ORDER BY t
```

### Interval Mapping

Map user-facing interval labels to SQL:

```typescript
const INTERVAL_MAP: Record<string, string> = {
  '5m':  '5 MINUTE',
  '15m': '15 MINUTE',
  '30m': '30 MINUTE',
  '1h':  '1 HOUR',
  '4h':  '4 HOUR',
  '1d':  '1 DAY',
}

function mapInterval(interval?: string): string {
  return INTERVAL_MAP[interval || '1h'] || '1 HOUR'
}
```

### Window Mapping (Time Range Filter)

Map user-facing window labels to SQL time ranges:

```typescript
const WINDOW_MAP: Record<string, string> = {
  '1h':  '1 HOUR',
  '6h':  '6 HOUR',
  '24h': '24 HOUR',
  '7d':  '7 DAY',
  '30d': '30 DAY',
}

// In WHERE clause:
// timestamp > now() - INTERVAL ${WINDOW_MAP[window]}
```

**Special case: `all`** — omit the time filter entirely to query the full dataset.

## Parameterized WHERE Clause Builder

Build safe, composable WHERE clauses:

```typescript
interface QueryParams {
  interval?: string
  coin?: string
  window?: string
}

interface WhereClause {
  clause: string
  queryParams: Record<string, string>
}

function buildWhereClause(params: QueryParams, extraConditions: string[] = []): WhereClause {
  const conditions: string[] = []
  const queryParams: Record<string, string> = {}

  if (params.window !== 'all') {
    const windowSql = WINDOW_MAP[params.window || '24h'] || '24 HOUR'
    conditions.push(`timestamp > now() - INTERVAL ${windowSql}`)
  }

  if (params.coin) {
    conditions.push('coin = {coin:String}')
    queryParams.coin = params.coin
  }

  // Only pass trusted, static SQL fragments here. Parameterize user input.
  conditions.push(...extraConditions)
  return {
    clause: conditions.length > 0 ? conditions.join(' AND ') : '1',
    queryParams,
  }
}
```

Usage:

```typescript
const { clause, queryParams } = buildWhereClause(params, ['crossed = 1'])
const sql = `SELECT ... FROM hl_fills FINAL WHERE ${clause} GROUP BY t ORDER BY t`
const result = await client.query({
  query: sql,
  query_params: queryParams,
  format: 'JSONEachRow',
})
```

## Conditional Aggregation with sumIf / countIf

ClickHouse's `*If` combinators are powerful for computing multiple metrics in a single pass:

```sql
-- Volume split by side
SELECT
  toStartOfInterval(timestamp, INTERVAL 1 HOUR) AS t,
  sumIf(notional, side = 'Bid') AS bid_volume,
  sumIf(notional, side = 'Ask') AS ask_volume,
  sumIf(notional, side = 'Bid') - sumIf(notional, side = 'Ask') AS delta
FROM hl_fills FINAL
WHERE crossed = 1
GROUP BY t
ORDER BY t
```

```sql
-- Fee breakdown
SELECT
  toStartOfInterval(timestamp, INTERVAL 1 HOUR) AS t,
  sumIf(fee, crossed = 1) AS taker_fees,
  sumIf(fee, crossed = 0) AS maker_fees,
  sum(fee) AS total_fees
FROM hl_fills FINAL
GROUP BY t
ORDER BY t
```

```sql
-- Stats summary
SELECT
  count() AS fill_count,
  sum(notional) / 2 AS total_volume,
  sumIf(notional, crossed = 1) AS taker_volume,
  round(sumIf(notional, crossed = 1) / (sum(notional) / 2) * 100, 2) AS taker_pct,
  sum(fee) AS total_fees,
  countIf(closed_pnl < -1000
    AND dir IN ('Close Long', 'Close Short')
    AND start_position != 0
    AND abs(closed_pnl) > notional * 0.1
  ) AS liquidation_count
FROM hl_fills FINAL
```

## Common Analytics Queries

### Top N by Volume

```sql
SELECT
  coin,
  sum(notional) / 2 AS volume,
  count() AS fills
FROM hl_fills FINAL
WHERE timestamp > now() - INTERVAL 24 HOUR
GROUP BY coin
ORDER BY volume DESC
LIMIT 10
```

### Large Fills Detection

```sql
SELECT
  toStartOfInterval(timestamp, INTERVAL 1 HOUR) AS t,
  coin,
  count() AS large_fills,
  sum(notional) / 2 AS large_volume,
  max(notional) AS max_fill
FROM hl_fills FINAL
WHERE notional > 100000
GROUP BY t, coin
ORDER BY t, large_volume DESC
```

### Liquidation Heuristic

Hyperliquid doesn't flag liquidations explicitly. This heuristic detects them:

```sql
SELECT
  timestamp, user, coin, dir, px, sz, notional, closed_pnl, fee
FROM hl_fills FINAL
WHERE closed_pnl < -1000
  AND dir IN ('Close Long', 'Close Short')
  AND start_position != 0
  AND abs(closed_pnl) > notional * 0.1
ORDER BY timestamp DESC
LIMIT 100
```

Logic:
- `closed_pnl < -1000` — significant loss
- `dir IN ('Close Long', 'Close Short')` — position being closed
- `start_position != 0` — had an open position
- `abs(closed_pnl) > notional * 0.1` — loss is >10% of trade size (not just fees)

### Liquidation Timeline (Aggregated)

```sql
SELECT
  toStartOfInterval(timestamp, INTERVAL 1 HOUR) AS t,
  count() AS liquidations,
  sum(notional) AS liquidation_volume,
  sum(abs(closed_pnl)) AS total_loss
FROM hl_fills FINAL
WHERE closed_pnl < -1000
  AND dir IN ('Close Long', 'Close Short')
  AND start_position != 0
  AND abs(closed_pnl) > notional * 0.1
GROUP BY t
ORDER BY t
```

## Query Execution Wrapper

Wrap all queries with timing metadata:

```typescript
async function query<T>(sql: string): Promise<{
  data: T[]
  meta: { query_ms: number; rows: number }
}> {
  const start = performance.now()
  const result = await client.query({ query: sql, format: 'JSONEachRow' })
  const data = await result.json<T>()
  const query_ms = Math.round(performance.now() - start)
  return { data, meta: { query_ms, rows: data.length } }
}
```

This lets the frontend display query performance and row counts — useful for debugging and user confidence.

## ClickHouse Client Setup

This example connects only to a local development ClickHouse with user `default` and password `default`. For another database, have the user configure the connection directly in their application. Do not read an existing password from their environment or files, or ask them to paste it into chat.

```typescript
import { createClient } from '@clickhouse/client'

const client = createClient({
  url: 'http://localhost:8123',
  database: 'my_dashboard',
  username: 'default',
  password: 'default',
  clickhouse_settings: {
    date_time_output_format: 'iso',  // returns ISO strings, not Unix timestamps
  },
})
```

**`date_time_output_format: 'iso'`** is critical — without it, DateTime64 columns return platform-dependent formats that are hard to parse consistently in JavaScript.

## Performance Tips

### Partitioning

For tables with >100M rows, partition by month:

```sql
CREATE TABLE hl_fills (
  ...
) ENGINE = CollapsingMergeTree(sign)
ORDER BY (coin, block_number, user, dir)
PARTITION BY toYYYYMM(timestamp)
```

Benefits:
- Queries with time filters skip irrelevant partitions entirely
- `timestamp > now() - INTERVAL 24 HOUR` only reads the current month's partition
- Dropping old data is instant: `ALTER TABLE DROP PARTITION 202501`

### LowCardinality

Use `LowCardinality(String)` for columns with limited distinct values:

```sql
coin LowCardinality(String),     -- ~200 distinct values
side LowCardinality(String),     -- 2 values: Bid, Ask
dir LowCardinality(String),      -- ~7 values
user LowCardinality(String),     -- thousands, but still benefits
fee_token LowCardinality(String) -- ~5 values
```

Typically 2-5x compression improvement and faster GROUP BY.

### ORDER BY Matters

The `ORDER BY` in the table definition determines the primary index. Put the most-filtered column first:

```sql
-- Good: coin is almost always in WHERE clause
ORDER BY (coin, block_number, user, dir)

-- Bad: block_number first means coin filters scan everything
ORDER BY (block_number, coin, user, dir)
```

### Query-Level Optimizations

```sql
-- Use FINAL to collapse rollback pairs before evaluating the query
SELECT ... FROM hl_fills FINAL WHERE ...

-- For reversible aggregates at high volume, account for both signs explicitly
SELECT
  sum(notional * sign) AS volume,
  sum(sign) AS fill_count
FROM hl_fills
WHERE ...

-- Never use WHERE sign = 1 as a substitute for FINAL: it retains cancelled rows
```

```sql
-- Limit GROUP BY cardinality
-- Bad: GROUP BY t, coin, user (millions of groups)
-- Good: GROUP BY t, coin (thousands of groups)
-- Best: GROUP BY t (one group per time bucket)
```

## API Server Pattern

Minimal Bun server with route-to-query mapping:

```typescript
const routes: Record<string, (params: QueryParams) => Promise<any>> = {
  '/api/stats': getStats,
  '/api/volume': getVolume,
  '/api/fees': getFeeAnalysis,
}

Bun.serve({
  port: 3000,
  async fetch(req) {
    const url = new URL(req.url)
    const handler = routes[url.pathname]
    if (handler) {
      const params = {
        interval: url.searchParams.get('interval') || undefined,
        coin: url.searchParams.get('coin') || undefined,
        window: url.searchParams.get('window') || undefined,
      }
      const result = await handler(params)
      return Response.json(result, {
        headers: { 'Access-Control-Allow-Origin': '*' },
      })
    }
    // ... static file serving
  },
})
```

**Always include `Access-Control-Allow-Origin: *`** for local development — the frontend may be served from a different port.

## Related

- [PATTERNS.md](./PATTERNS.md) — General indexing patterns
- [PERFORMANCE.md](./PERFORMANCE.md) — Sync speed optimization
- [SCHEMA_GUIDE.md](./SCHEMA_GUIDE.md) — table design guide
