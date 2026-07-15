# Blockchain Indexing Patterns & Best Practices

Advanced patterns, performance optimization, and troubleshooting for building production-grade blockchain indexers with Subsquid Pipes SDK.

## Overview

This document consolidates:
- **Common Indexing Patterns** - Factory tracking, multi-event processing, aggregations
- **Performance Optimization** - Throughput benchmarks and optimization techniques
- **Error Handling** - Critical error patterns and solutions
- **Production Best Practices** - Data quality, testing, deployment

## When to Use This Reference

Consult this documentation when you need to:
- Implement specific indexing patterns (factory, multi-event, aggregations)
- Optimize indexer performance
- Troubleshoot common errors
- Debug sync issues or missing data
- Handle edge cases (proxy contracts, shared state)
- Build production-grade indexers

## Common Indexing Patterns

### Basic Patterns

#### 1. Single Contract Event Tracking
- Track specific events from known contract
- Simplest pattern, minimal overhead
- **Use when**: Known address, single event type

#### 2. Multiple Events from Single Contract
- Track multiple event types (Deposit/Withdraw)
- Related events from same contract
- **Use when**: Need to process events differently

### Intermediate Patterns

#### 3. Factory Pattern with Pre-Indexing
- Track dynamically deployed contracts
- Wildcard vs pre-indexed approaches
- **Use when**: Uniswap pools, protocol deployments

#### 4. Topic0-Only Global Filtering
- Track events across ALL contracts without knowing addresses
- Omit `contracts` field from `evmDecoder` — filters by topic0 only
- **Use when**: Event signature is unique to the protocol (ReallocateSupply, StrategyReported), factory-deployed contracts where you want all instances
- **Don't use when**: Event signature is generic (Transfer, Deposit) — too many false positives
- **Advantage over factory pattern**: Zero cold-start delay, no SQLite database needed, simpler setup
- **Example**: MetaMorpho vault reallocations (evm/039), Yearn V2 strategy harvests (evm/037)

#### 5. Parallel Event Decoding (multi-output)
- Decode multiple independent event types via `outputs: { a: evmDecoder(...), b: evmDecoder(...) }`
- Parallel processing
- **Use when**: Unrelated events, different contracts

#### 6. Event Parameter Filtering (Server-Side)
- Filter by indexed parameters at Portal
- Dramatically reduce bandwidth
- **Use when**: High-volume contracts, known addresses

#### 6. Factory Event Filtering
- Filter factory creation events
- Limit downstream processing
- **Use when**: Only need subset of deployed contracts

### Advanced Patterns

#### 7. Multi-Stage Pipeline with Aggregations
- Filter → Enrich → Aggregate → Persist
- Complex transformations
- **Use when**: Need reusable stages, complex logic

#### 8. Custom Target Implementation
- Write to custom format/storage
- **Use when**: JSON files, S3, custom database

#### 9. Memory Target (internal / testing only)
- In-memory storage with rollback handling
- **Not publicly importable**: `createMemoryTarget` exists in the SDK source but is **not** exported from the published `@subsquid/pipes@alpha` (alpha.16) package — there is no `./targets/memory` export and it is not re-exported from the root index, so application code cannot import it. (The CLI's `memory` sink separately throws `"Memory sink is not supported"`.)
- **Use when**: SDK-internal tests only — for a lightweight external option, use a custom target instead

#### 10. RPC Latency Monitoring
- Compare Portal vs RPC block-arrival latency by feeding a latency watcher into a stream's `outputs`
- **API**: `evmRpcLatencyWatcher({ rpcUrl: string[] })` (from `@subsquid/pipes/evm`) and `bitcoinRpcLatencyWatcher({ rpcUrl, intervalMs? })` (from `@subsquid/pipes/bitcoin`), plus a Solana watcher — all wrap the generic `rpcLatencyWatcher({ watcher })`. Each emitted `LatencySample` carries `{ url, receivedAt, portalDelayMs }` and the RPC block hash.
- **Use when**: Monitoring infrastructure, measuring Portal head lag against your own RPC providers

```typescript
import { evmPortalStream, evmRpcLatencyWatcher } from '@subsquid/pipes/evm'

const stream = evmPortalStream({
  id: 'indexing-latency',
  portal: 'https://portal.sqd.dev/datasets/base-mainnet',
  outputs: evmRpcLatencyWatcher({
    rpcUrl: ['https://base.drpc.org', 'https://base-rpc.publicnode.com'],
  }),
})

for await (const { data } of stream) {
  if (!data) continue
  console.table(data.rpc) // [{ url, receivedAt, portalDelayMs }]
}
```

Bitcoin uses the same shape with `bitcoinRpcLatencyWatcher` (polls Bitcoin Core JSON-RPC, no WebSocket) from `@subsquid/pipes/bitcoin`.

## Critical Error Patterns

### 1. Missing range Parameter in evmDecoder

**ERROR**: `TypeError: Cannot read properties of undefined (reading 'from')`

**Cause**: The `range` parameter is **REQUIRED** in `evmDecoder` but was omitted.

```typescript
// WRONG - Missing range
evmDecoder({
  contracts: [CONTRACT_ADDRESS],
  events: { deposit: abi.events.Deposit },
})

// CORRECT - Range included
evmDecoder({
  range: { from: 21_000_000 },  // REQUIRED!
  contracts: [CONTRACT_ADDRESS],
  events: { deposit: abi.events.Deposit },
})
```

### 2. Wrong Data Structure - Iterating Instead of Mapping

**ERROR**: `TypeError: batch.data is not iterable`

**Cause**: Using `for...of` loop on `batch.data` instead of accessing named event arrays.

```typescript
// WRONG - Trying to iterate batch.data
.pipe((batch) => {
  for (const item of batch.data) {  // NOT iterable!
    if (item.event.name === "deposit") { /* ... */ }
  }
})

// CORRECT - Access named arrays and map
.pipe((data) => {
  const deposits = data.deposits.map((d) => ({
    blockNumber: d.block.number,
    txHash: d.rawEvent.transactionHash,
    sender: d.event.sender,
    assets: d.event.assets.toString(),
  }));

  return { deposits };
})
```

### 3. Shared Sync Table Conflict

**SYMPTOM**: Indexer starts from wrong block (e.g., 27M instead of 21M)

**Cause**: Multiple indexers share the same ClickHouse `sync` table.

**Solution**:
```bash
# Option A: Clear sync table before starting
docker exec clickhouse clickhouse-client --password=default \
  --query "TRUNCATE TABLE pipes.sync"

# Option B: Use separate database
CLICKHOUSE_DATABASE=my_unique_db npm run dev
```

**Prevention**: Always verify start block in logs:
```bash
tail -f indexer.log | head -1
# Expected: "Start indexing from [your-block]"
# Wrong: "Resuming from [different-block]"
```

### 4. ClickHouse Format Error

**ERROR**: `Cannot parse input: expected '[' before: '{"blockNumber"...`

**Cause**: Missing format specification in `store.insert()`.

```typescript
// WRONG - Missing format
await store.insert({
  table: "transfers",
  values: data,
})

// CORRECT - With format
await store.insert({
  table: "transfers",
  values: data,
  format: "JSONEachRow",  // REQUIRED!
})
```

### 5. Wrong ClickHouse API

**ERROR**: `TypeError: clickhouse.insertTable is not a function`

**Cause**: Using outdated API from old documentation.

```typescript
// CORRECT - Current API
import { clickhouseTarget } from "@subsquid/pipes/targets/clickhouse";
import { createClient } from "@clickhouse/client";

const client = createClient({
  url: process.env.CLICKHOUSE_URL || "http://localhost:8123",
  database: process.env.CLICKHOUSE_DATABASE || "default",
  username: "default",
  password: "default",
});

clickhouseTarget({
  client,
  onStart: async ({ store }) => {
    await store.command({ query: "CREATE TABLE..." });
  },
  onData: async ({ store, data }) => {
    await store.insert({
      table: "transfers",
      values: data,
      format: "JSONEachRow",
    });
  },
})
```

## Common Issues and Solutions (Continued)

### Issue 7: Indexer Crashed Mid-Sync — How to Resume

**Symptoms**: Process was killed (OOM, terminal closed, machine restart). Partial data exists.

**Solution**: The sync table tracks progress. Simply restart:
```bash
cd <project-folder>
npm run dev
```

The indexer reads the sync table and resumes from the last committed block. Verify the "Resuming from X" log line shows the expected block.

**If you want a clean restart instead**:
```bash
docker exec <container> clickhouse-client --password <pw> \
  --query "DROP TABLE IF EXISTS pipes.sync; DROP TABLE IF EXISTS pipes.<your_table>"
npm run dev
```

**Note**: On first-ever start, the sync table does not exist yet. The SDK logs an error (`Unknown table expression identifier 'pipes.sync'`) and then creates it. This is harmless — do not treat it as a failure.

## Performance Optimization

### Throughput Benchmarks

| Pattern | Events/Second | Notes |
|---------|--------------|-------|
| Simple EVM decoder | ~23,000 | Single contract, no transformations |
| EVM with ClickHouse | ~18,000 | Includes database writes |
| EVM with PostgreSQL | ~12,000 | YMMV by database setup |
| Multi-output (3 decoders) | ~15,000 | Parallel decoding overhead |
| Multi-stage (4 stages) | ~8,000 | Each stage adds overhead |
| Memory target | ~25,000 | No persistence overhead |

### Optimization Techniques

#### 1. Use Parameter Filtering

**Impact**: Reduces bandwidth by 10-100x when targeting specific addresses.

```typescript
// BAD: Fetch all, filter client-side
evmDecoder({
  events: { transfer: commonAbis.erc20.events.Transfer },
}).pipe((data) => {
  return data.transfer.filter(t => t.event.from === TARGET);
})

// GOOD: Filter server-side
evmDecoder({
  events: {
    transfer: {
      event: commonAbis.erc20.events.Transfer,
      params: { from: TARGET },  // Filter at Portal!
    },
  },
})
```

#### 2. Minimize Transformation Stages

**Impact**: Each stage adds 20-40% overhead.

```typescript
// BAD: 4 separate pipes
.pipe(stage1)
.pipe(stage2)
.pipe(stage3)
.pipe(stage4)

// GOOD: Combine into 1-2 stages
.pipe((data) => {
  // Do all transformations here
  return finalTransform(data);
})
```

#### 3. Batch Inserts

**Impact**: 10-100x faster than individual inserts.

```typescript
// BAD: Insert one at a time
for (const transfer of data.transfer) {
  await db.insert(transfers).values(transfer);
}

// GOOD: Batch insert
await store.insert({
  table: "transfers",
  values: data.transfer,
  format: "JSONEachRow",
})
```

#### 4. Use Pre-Indexing for Factory Patterns

**Impact**: Targeted streaming is 5-10x faster than wildcards.

```typescript
// SLOW: Wildcard (but discovers all contracts)
wildcardContracts: [{ address: "*", events: { swap } }]

// FAST: Pre-indexed list (if you know addresses)
contracts: [pool1, pool2, pool3, ...]
```

### Optimization Checklist

- [ ] Use server-side parameter filtering for known addresses
- [ ] Minimize transformation stages (1-2 stages max)
- [ ] Batch database inserts (never one-by-one)
- [ ] Choose appropriate database (ClickHouse vs PostgreSQL)
- [ ] Use pre-indexing for factory patterns when possible
- [ ] Monitor memory usage (keep < 500 MB)
- [ ] Profile with metrics (enable profiling in development)
- [ ] Test with small ranges before full deployment

## Common Issues and Solutions

### Issue 1: Pipeline Not Processing Events

**Symptoms**: No events in database, pipeline runs but no output

**Possible Causes**:
- Wrong block range (events outside specified range)
- Wrong contract address (typo or wrong network)
- Wrong event signature (ABI mismatch)
- Filter too restrictive (no events match)

**Solution**:
```typescript
// 1. Verify contract address and block range
evmDecoder({
  range: { from: 21_230_000, to: 21_235_000 },
  contracts: [USDC_ADDRESS.toLowerCase()], // Ensure lowercase
  events: { transfer: commonAbis.erc20.events.Transfer },
})

// 2. Test without filter first
// 3. Verify ABI matches contract
// 4. Check for proxy contracts
```

### Issue 2: Pipeline Crashes with Out of Memory

**Symptoms**: Process exits with OOM error

**Solution**:
```typescript
// Use database target instead of memory
await stream.pipeTo(clickhouseTarget({ /* config */ }))

// Process in batches
for await (const { data } of stream) {
  await persistBatch(data);
}
```

### Issue 3: Slow Performance

**Symptoms**: Pipeline takes hours for small dataset

**Solution**: Apply optimization techniques from Performance section

### Issue 4: Data Missing After Restart

**Symptoms**: Pipeline restarts from beginning

**Solution**: Implement cursor saving in custom target

### Issue 5: Duplicate Data After Chain Reorganization

**Symptoms**: Duplicate records after reorg

**Solution**: Implement fork handler to handle rollbacks

### Issue 6: Events Not Decoded Correctly

**Symptoms**: Event fields are undefined or wrong values

**Possible Causes**:
- Wrong ABI (event signature mismatch)
- Wrong contract (different ABI version)
- Proxy contract (need implementation ABI)

**Solution**:
```bash
# Regenerate ABI from contract
npx @subsquid/evm-typegen@latest src/contracts \
  0xYourContractAddress \
  --chain-id 1
```

### Issue 8: Sync Table Conflict Between Indexers

**Symptoms**: Second indexer resumes from wrong block, produces wrong data or no data

**Cause**: All indexers write to `{database}.sync` with `id = 'stream'`. Sharing a database means the second indexer picks up the first's sync position.

**Solution**: Use a dedicated database per indexer project:
```bash
# Create separate databases
docker exec <container> clickhouse-client --password <pw> \
  --query "CREATE DATABASE IF NOT EXISTS usdc_transfers"
docker exec <container> clickhouse-client --password <pw> \
  --query "CREATE DATABASE IF NOT EXISTS uniswap_swaps"
```

If you must share a database, drop the sync table between indexer runs:
```bash
docker exec <container> clickhouse-client --password <pw> \
  --query "DROP TABLE IF EXISTS <database>.sync"
```

### Issue 9: Custom Template Table Names

**Symptoms**: Querying `{contractName}_events` returns "table not found"

**Cause**: The custom template creates **one table per event**, named `{contractName}_{eventName}` in snake_case. There is no combined events table.

**Example**: Contract "WETH" with events "Deposit" and "Withdrawal" creates:
- `weth_deposit` (not `weth_events`)
- `weth_withdrawal`

**Solution**: Query each table separately, or create a VIEW to combine them:
```sql
CREATE VIEW weth_events AS
  SELECT 'deposit' as event_type, dst as address, wad, block_number, tx_hash, timestamp FROM weth_deposit
  UNION ALL
  SELECT 'withdrawal' as event_type, src as address, wad, block_number, tx_hash, timestamp FROM weth_withdrawal
```

### Issue 10: Timestamps Show 1970 Dates in ClickHouse

**Symptoms**: All timestamps in ClickHouse display as `1970-01-28` or similar early dates, even though the indexer is processing recent blocks.

**Cause**: The JS value's precision doesn't match the ClickHouse column's. The divisor depends on the **column type**, not a blanket rule:
- `DateTime` (no precision arg) stores **seconds** → feed `Math.floor(getTime()/1000)`. Passing raw ms (`getTime()`) lands in 1970.
- `DateTime(3)` / `DateTime64(3)` stores **milliseconds** (ClickHouse parses `DateTime(3)` as `DateTime64(3)`) → feed `getTime()` undivided. Passing seconds here **also** lands in 1970 (e.g. `1782669669` → `1970-01-21`).

Because **both** mismatches produce ~1970 dates, "1970" alone doesn't tell you which direction is wrong — check the column type first with `DESCRIBE TABLE`.

**Solution**: Match the JS value to the column precision:
```typescript
// Column: DateTime  (seconds)
timestamp: Math.floor(d.timestamp.getTime() / 1000),

// Column: DateTime(3) / DateTime64(3)  (milliseconds) — the CLI default scaffold
timestamp: d.timestamp.getTime(),  // do NOT divide
```

**Note**: CLI-generated tables use `timestamp DateTime(3)` and the generated erc20/uniswap transformers emit `getTime()` (ms, undivided) — so blanket-dividing by 1000 breaks the default scaffold. The `enrichEvents` helper (used only by the `custom` templates) emits **seconds**, matching a plain `DateTime` column.

**Recovery**: If you've already inserted bad timestamps:
```bash
# Drop affected tables and sync state
docker exec <container> clickhouse-client --password <pw> \
  --query "DROP TABLE IF EXISTS <db>.<table>; DROP TABLE IF EXISTS <db>.sync"
# If using factory pattern, also delete the SQLite file
rm <project>/*.sqlite
# Restart
npm run dev
```

### Issue 11: Proxy Contract Crashes Indexer on Startup

**Symptoms**: Indexer crashes immediately with `TypeError: Cannot read properties of undefined (reading 'topic')` at `evmDecoder`.

**Cause**: The contract is behind a proxy (EIP-1967, TransparentUpgradeableProxy, etc.). Both the CLI and `evm-typegen` fetch the proxy ABI, which only contains the `Upgraded` event. The generated `index.ts` references events (e.g., `Supply`, `Borrow`) that don't exist in the proxy ABI.

**Detection**: After CLI generation, inspect the contract file:
```bash
grep "export const events" src/contracts/*.ts
# Proxy: only "Upgraded" event
# Implementation: all expected events (Supply, Borrow, Swap, etc.)
```

**Solution**:
1. Find implementation address: Go to `https://etherscan.io/address/<proxy>` → "Read as Proxy" tab → copy implementation address
2. Generate types from implementation:
   ```bash
   npx @subsquid/evm-typegen@latest src/contracts <IMPLEMENTATION_ADDRESS> --chain-id <CHAIN_ID>
   ```
3. Update import in `src/index.ts` to point to the implementation file
4. Keep the proxy address in `contracts:` array (events are emitted from the proxy)

**Common proxy contracts**: Aave V3 Pool, Compound V3, Lido stETH, USDC. Rule of thumb: if it's a major DeFi protocol, assume proxy until proven otherwise.

### Issue 12: Factory Indexer Shows Zero Data for 30-60+ Seconds

**Symptoms**: Factory-pattern indexer starts successfully, syncs blocks, but produces zero rows in the database for an extended period.

**Cause**: The factory pattern only discovers child contracts from the `range.from` block forward. If the factory hasn't deployed any new child contracts in the blocks being synced, there's nothing to track yet.

**This is expected behavior, not a bug.**

**When to worry vs. when to wait**:
- If the factory is active (deploying new contracts regularly): wait 60-90 seconds
- If the factory is inactive (no new deployments in your block range): you'll never get data until the indexer reaches a block where the factory creates a new child
- If you need ALL historical child contracts: set `range.from` to the factory's deployment block

**Verification**:
```bash
# Check if the factory SQLite database is being populated
ls -la <project>/*.sqlite
# Size > 0 means child contracts are being discovered

# Check how many child contracts have been found
sqlite3 <project>/*.sqlite "SELECT COUNT(*) FROM factory_contracts" 2>/dev/null || echo "No contracts yet"
```

## Pattern Selection Guide

### Single Contract Event Tracking
**Use when**:
- Known contract address
- Single event type
- Simple transformations

### Factory Pattern
**Use when**:
- Dynamically deployed contracts
- Need all historical deployments
- Known contract list

### Parallel Decoding (multi-output)
**Use when**:
- Multiple independent event types
- Different contracts
- Want parallel processing

**DON'T use when**:
- Events depend on each other
- Single contract

### Multi-Stage Pipeline
**Use when**:
- Complex transformations
- Multiple data formats needed
- Reusable transformation logic

**DON'T use when**:
- Simple event → database mapping
- Performance critical

### Parameter Filtering
**Use when**:
- Known addresses to track
- High-volume contracts
- Indexed parameters available

**DON'T use when**:
- Need all events anyway
- Non-indexed parameters

### Custom Target
**Use when**:
- Custom data format (JSON, CSV, Parquet)
- Custom storage (S3, GCS, IPFS)
- Custom database not supported

**DON'T use when**:
- ClickHouse (use clickhouseTarget)
- PostgreSQL (use drizzleTarget)

### Memory Target
**Not publicly importable in alpha.16** (SDK-internal / testing only — see pattern #9). For a lightweight external store, use a custom target. Characteristics of the internal target:

**Use when**:
- SDK-internal testing
- Small datasets (< 10M records)
- No persistence needed

**DON'T use when**:
- Application code (it cannot be imported)
- Large datasets
- Need persistence across restarts

## Production Best Practices

### 1. Error Prevention

- Always include `range` in `evmDecoder`
- Always use `.map()` on named event arrays
- Always include `format: "JSONEachRow"` in ClickHouse inserts
- Always convert BigInt to string before JSON serialization
- Always clear sync table when starting new indexer

### 2. Performance Optimization

- Use server-side parameter filtering for high-volume contracts
- Minimize transformation stages (1-2 max)
- Batch database inserts
- Monitor memory usage (< 500 MB)
- Test with small ranges before full deployment

### 3. Data Quality

- Verify data within 30 seconds of starting
- Check for NULL values in critical fields
- Validate addresses, amounts, timestamps
- Monitor row count increasing over time
- Implement fork handler for rollback protection

### 4. Debugging Workflow

1. Check logs for error messages
2. Enable profiling to measure performance
3. Test with small range (100 blocks)
4. Verify data in database with SQL queries
5. Review TROUBLESHOOTING.md for matching pattern

## Database Comparison: ClickHouse vs PostgreSQL

### ClickHouse (Recommended for Analytics)

**Pros**:
- 5-10x faster for analytical queries
- Efficient columnar storage
- Excellent for time-series data
- Better compression (smaller storage)

**Cons**:
- No strong ACID transactions
- Limited UPDATE/DELETE support
- Less familiar for web developers

**Best for**:
- Analytics dashboards
- Historical data analysis
- High-volume event streams
- Aggregation-heavy queries

### PostgreSQL (Recommended for Relational)

**Pros**:
- ACID transactions
- Rich query capabilities (JOINs, subqueries)
- More familiar to developers
- Better tooling ecosystem

**Cons**:
- Slower for large analytical queries
- Higher storage requirements
- More expensive to scale

**Best for**:
- Relational data models
- Transactional workloads
- Complex queries with JOINs
- Web application backends

## Key Pattern Principles

### 1. Start Simple, Scale Smart

```typescript
// Start: Single contract, simple events
evmDecoder({
  range: { from: RECENT_BLOCK },  // Test with recent blocks
  contracts: [CONTRACT],
  events: { transfer: abi.Transfer },
})

// Scale: Add filtering, expand range
evmDecoder({
  range: { from: DEPLOYMENT_BLOCK },  // Full history
  contracts: [CONTRACT],
  events: {
    transfer: {
      event: abi.Transfer,
      params: { from: TARGET_ADDRESSES },  // Filter
    },
  },
})
```

### 2. Test Before Deploying

```bash
# Always test with small range first
range: { from: 21_230_000, to: 21_230_100 }  # 100 blocks

# Then expand
range: { from: 21_230_000, to: 21_235_000 }  # 5,000 blocks

# Finally full history
range: { from: DEPLOYMENT_BLOCK }
```

### 3. Verify Data Immediately

```bash
# Check within 30 seconds of starting
docker exec clickhouse clickhouse-client --password=default \
  --query "SELECT COUNT(*) FROM pipes.my_table"

# Should be > 0
# If 0: Check logs, verify contract, check ABI
```

### 4. Handle Edge Cases

```typescript
// Always convert BigInt to string
value: transfer.event.value.toString()

// Always use rawEvent for transaction hash
txHash: transfer.rawEvent.transactionHash

// Always include format in ClickHouse inserts
format: "JSONEachRow"

// Always check for proxy contracts
// Use implementation ABI, not proxy ABI
```

## Key Takeaways

1. **Start with proven patterns** - Use validated patterns from reference docs
2. **Read error catalog first** - Most errors are documented with solutions
3. **Optimize early** - Use parameter filtering from the start
4. **Test small** - Always test with recent blocks first
5. **Verify immediately** - Check data within 30 seconds
6. **Monitor continuously** - Use profiling and metrics in production

## Related Documentation

- RESEARCH_CHECKLIST.md - Protocol research workflow
- ENVIRONMENT_SETUP.md - Development prerequisites
- DEPLOYMENT_OPTIONS.md - Production deployment strategies
