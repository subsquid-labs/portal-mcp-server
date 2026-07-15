# Troubleshooting: Error Patterns

Reference for diagnosing and fixing runtime errors in Pipes SDK indexers. Match the user's error to a pattern and follow the diagnostic + fix steps.

## Diagnostic Workflow

1. **Read the error message** — get exact text
2. **Match to a pattern below** — most common issues are catalogued
3. **Read context** — `src/index.ts`, `package.json`, `.env`, stack trace
4. **Verify environment** — database running, Node version, dependencies installed
5. **Apply fix** — edit files or run commands
6. **Restart and verify** — confirm logs show expected behavior
7. **Validate data** — run [VALIDATION.md](VALIDATION.md) checks before declaring success

## Error Pattern 1: ABI Version Mismatch

**Symptoms:**
```
Type 'LogParams' is not assignable to type 'EvmLogParams'
Property 'topics' is missing in type 'LogParams'
```

**Root cause:** `@subsquid/evm-abi` v1.x.x instead of v0.3.1.

**Fix:**
```json
// package.json
{
  "dependencies": {
    "@subsquid/evm-abi": "^0.3.1"
  }
}
```
Then `npm install` and verify types resolve.

## Error Pattern 2: Portal API Connection Failed

**Symptoms:**
```
Error: connect ECONNREFUSED
Error: Portal request failed with status 429
Error: Portal timeout after 30s
```

**Fix options:**
- **429 rate limit** — reduce block range or add delay
- **ECONNREFUSED** — check internet, verify Portal URL
- **Timeout** — increase timeout or reduce batch size

```typescript
// Smaller range reduces load
range: { from: 21_000_000, to: 21_100_000 }
```

## Error Pattern 3: Database Connection Failed

**Symptoms:**
```
Error: connect ECONNREFUSED localhost:5432
Error: ClickHouse authentication failed
Error: Database 'pipes' does not exist
```

**Fix:**
1. Check database is running: `docker ps | grep clickhouse` (or postgres)
2. Verify `.env` connection string
3. Start if needed: `docker start clickhouse` or `docker-compose up -d`
4. Create database if missing:
   ```bash
   docker exec clickhouse clickhouse-client --query "CREATE DATABASE IF NOT EXISTS pipes"
   ```

### Harmless: `Unknown table 'pipes.sync'` on First Run

On a brand-new indexer, the SDK tries to read the sync table for resume state, fails (it doesn't exist yet), then creates it. **Ignore this error on first run.**

## Error Pattern 4: Event Decoding Failed

**Symptoms:**
```
Error: Cannot decode event with signature '0x...'
TypeError: Cannot read property 'from' of undefined
```

**Fix:**
1. Verify ABI import in `src/index.ts`
2. Check contract address is correct
3. Confirm event ABI matches the signature:
   ```typescript
   events: { swap: uniswapV3.events.Swap }  // not commonAbis.erc20.events.Transfer
   ```
4. For custom contracts, regenerate ABI:
   ```bash
   npx @subsquid/evm-typegen@latest src/contracts 0x... --chain-id 1
   ```

## Error Pattern 4b: Proxy Contract ABI — Crash on Startup

**Symptoms:**
```
TypeError: Cannot read properties of undefined (reading 'topic')
    at evmDecoder (evm-decoder.ts:322:70)
```

**Diagnosis:** CLI/typegen fetched the proxy ABI (only `Upgraded` event), but `index.ts` references events like `Supply`, `Borrow`, etc. that only exist on the implementation.

**Confirm:**
```bash
grep "export const events" src/contracts/*.ts
# Only "Upgraded" = proxy
```

**Fix:**
1. Find implementation address on Etherscan → "Read as Proxy" tab
2. Regenerate types from implementation:
   ```bash
   npx @subsquid/evm-typegen@latest src/contracts <IMPL_ADDRESS> --chain-id <CHAIN_ID>
   ```
3. Update import in `src/index.ts` to the implementation file
4. **Keep the proxy address** in `contracts:` — events emit from the proxy

See [ABI_GUIDE.md](ABI_GUIDE.md) for the full proxy handling guide, including non-standard patterns (Aragon, Diamond).

## Error Pattern 5: Missing Data

**Symptoms:** Indexer runs but database is empty or partial.

**Fix checklist:**
1. **Start block is before events occurred** — verify deployment block on Etherscan
2. **Contract is not a proxy** — check Error Pattern 4b
3. **Event names match ABI exactly** — case-sensitive
4. **Filter logic is not over-restrictive**
5. **Sync table conflict** — if another indexer used this database, yours may resume from the wrong block:
   ```bash
   docker exec <container> clickhouse-client --password <pw> \
     --query "SELECT * FROM <database>.sync FORMAT Vertical"
   ```
   Fix: use a separate database per indexer, or drop the sync table.

## Error Pattern 5b: Factory Indexer Shows Zero Data

**Symptoms:** Factory-pattern indexer syncs blocks but DB has 0 rows for 30–60+ seconds.

**Diagnosis:** The factory pattern only discovers child contracts from `range.from` forward. If no new children were created in the synced range, there's no data yet.

**This is expected, not a bug.**

**Fix:**
- Wait 60–90 seconds
- To track ALL historical children, set `range.from` to the factory's deployment block
- Verify contracts are being discovered: `ls -la <project>/*.sqlite` (size > 0)

## Error Pattern 5c: Timestamps Show 1970 Dates

**Symptoms:** All dates in ClickHouse show as `1970-01-28`, `1970-01-21`, or similar.

**Diagnosis:** The JS value's precision doesn't match the column's — and this fails in **both** directions, so "1970" alone doesn't tell you which way. Check the column type first:
```bash
docker exec clickhouse clickhouse-client --password <pw> \
  --query "DESCRIBE TABLE <db>.<table>" | grep timestamp
```
ClickHouse parses `DateTime(3)` as `DateTime64(3)` (millisecond precision). A **seconds** value in that column lands in 1970 just as badly as a **milliseconds** value in a plain `DateTime` (verified: `1782669669` → `1970-01-21`).

**Fix:** Match the JS value to the column precision:

| Column type | Precision | Correct JS value |
|-------------|-----------|------------------|
| `DateTime` | seconds | `Math.floor(d.timestamp.getTime() / 1000)` |
| `DateTime(3)` / `DateTime64(3)` | milliseconds | `d.timestamp.getTime()` (do **not** divide) |

CLI-generated tables use `timestamp DateTime(3)`, so the scaffold's transformers correctly emit undivided `getTime()` — do **not** "fix" them by dividing. The `enrichEvents` helper (custom templates only) emits seconds, matching a plain `DateTime` column.

**Recovery:** Drop tables + sync, delete SQLite (if factory), restart.

## Error Pattern 6: Memory Issues

**Symptoms:**
```
Error: JavaScript heap out of memory
Process killed (signal 9)
```

**Fix options:**
1. Reduce block range
2. Reduce tracked contracts
3. Process smaller batches
4. Raise Node memory limit:
   ```bash
   NODE_OPTIONS="--max-old-space-size=4096" npm run dev
   ```

## Error Pattern 7: ClickHouse Schema Issues

**Symptoms:**
```
Error: Table already exists
Error: Column type mismatch
Error: Cannot insert NULL into NOT NULL column
```

**Fix:**
1. Drop and recreate:
   ```bash
   docker exec clickhouse clickhouse-client --password=default \
     --query "DROP TABLE IF EXISTS pipes.table_name"
   ```
2. Verify schema matches data types (addresses = String, amounts = Float64, block numbers = UInt64, timestamps = DateTime(3))
3. Clear sync for fresh start:
   ```bash
   docker exec clickhouse clickhouse-client --password=default \
     --query "DROP TABLE IF EXISTS pipes.sync"
   ```

## Error Pattern 8: Process Crashed / Indexer Died Mid-Sync

**Symptoms:** Process exited, `npm run dev` was killed, partial data in database.

**Diagnosis:** Normal crash recovery. The sync table tracks progress.

**Fix:**
1. Restart — it resumes automatically:
   ```bash
   cd <project-folder>
   npm run dev
   ```
2. Verify `Resuming from X` log line shows a block near where it crashed
3. If data looks corrupted, drop sync + data tables and start fresh

## Error Pattern 9: Node.js Version Compatibility Issues

**Symptoms:**
```
ZSTD_error_prefix_unknown
TypeError: terminated (ZstdDecompress)
```
Or random crashes during large syncs.

**Diagnosis:** Node.js v25+ has known zstd decompression bugs.

**Fix — switch to LTS:**
```bash
nvm install 22 && nvm use 22
# or: brew install node@22; export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
```

**If you can't switch:** v25 tends to crash on large syncs (millions of blocks). Recent-block tests (~100K) often work.

**Hyperliquid-specific:** v25 crashes are especially common during large fills syncs (50M+ blocks). Checkpoint/resume works reliably — let it crash and restart until sync completes.

**Prevention:** always use Node.js LTS (v20 or v22).

## Error Pattern 10: Hyperliquid Validation — SDK vs Portal Block Batching

**Symptoms:** `validate.ts` Portal cross-reference shows wildly different fill counts vs ClickHouse, even though spot-checks pass and data looks correct.

**Diagnosis:** Pipes SDK batches Hyperliquid blocks differently from raw Portal queries. The SDK may merge, split, or reorder blocks internally — a Portal query for `fromBlock: X, toBlock: Y` may return a different count than what the SDK indexed for the same nominal range.

**This is NOT a bug.** Data is correct; counting methodology differs.

**Fix — use spot-checks as primary truth verification:**
```typescript
// DON'T rely on block-range count comparison
// ClickHouse: 15,234 vs Portal: 14,891 → misleading 2.3% diff

// DO use transaction-level spot-checks:
// 1. Pick 3–5 specific fills from ClickHouse (by hash or tid)
// 2. Query Portal for the same block
// 3. Verify field-level match: coin, px, sz, side, dir, user
```

Treat count comparisons as approximate sanity checks (20–30% tolerance) and spot-checks as authoritative.

## Error Pattern 10b: Hyperliquid addFill Missing Range

**Symptoms:**
```
TypeError: Cannot read properties of undefined (reading 'from')
    at parsePortalRange
    at HyperliquidFillsQueryBuilder.addRequest
    at HyperliquidFillsQueryBuilder.addFill
```

**Diagnosis:** `addFill()` requires a `range` parameter. Unlike EVM decoders where range is set once, each Hyperliquid fill filter needs its own range.

**Fix:**
```typescript
// WRONG
.addFill({ request: { coin: ['BTC'] } })

// CORRECT
.addFill({ range: { from: 920000000 }, request: { coin: ['BTC'] } })
```

Dataset starts at block **750,000,000**. In SDK 1.0+, use `hyperliquidFillsQuery()` instead of `new HyperliquidFillsQueryBuilder()`.

## Prevention Tips

1. **Always use Pipes CLI** — never manually create indexer files
2. **Verify environment first** — see [ENVIRONMENT_SETUP.md](ENVIRONMENT_SETUP.md)
3. **Start with recent blocks** — faster iteration, faster failures
4. **Check proxy status** before running — single biggest failure mode
5. **Use dedicated databases** — prevents sync table conflicts
