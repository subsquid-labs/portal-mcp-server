# Troubleshooting: Error Patterns

For database commands and configuration, use [CREDENTIALS.md](CREDENTIALS.md): inject secrets through the environment or protected client files, and never print them or pass their values as command arguments.

Reference for diagnosing and fixing runtime errors in Pipes SDK indexers. Match the user's error to a pattern and follow the diagnostic + fix steps.

## Diagnostic Workflow

1. **Read the error message** — get exact text
2. **Match to a pattern below** — most common issues are catalogued
3. **Read context** — `src/index.ts`, `package.json`, non-secret configuration, redacted stack trace
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

On a project fresh from the CLI's `custom` EVM template, at the first `npm run dev`:
```
Error [ERR_MODULE_NOT_FOUND]: Cannot find module '<project>/src/contracts/0x<address>.js'
SyntaxError: The requested module '@subsquid/evm-abi' does not provide an export named 'func'
```

**Root cause:** `@subsquid/evm-abi` v1.x.x instead of v0.3.1. `@subsquid/pipes` 1.0.0-beta.11 depends on `@subsquid/evm-abi` `0.3.1` exactly, and CLI-generated EVM projects pin the same version. `@subsquid/evm-typegen@5` depends on `@subsquid/evm-abi` `^1.0.0` and generates code for that API, so generate ABI modules with `@subsquid/evm-typegen@4.6.0` (see [ABI_GUIDE.md](ABI_GUIDE.md)). Re-check with `npm view @subsquid/pipes@1.0.0-beta.11 dependencies --json`.

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

**Fix for the fresh `custom` project** (reproduced on 2026-11-11 with CLI 1.0.0-beta.3, reported as [subsquid/pipes-sdk#220](https://github.com/subsquid/pipes-sdk/issues/220); re-check a newer CLI before applying): the CLI generates `src/contracts/` with `@subsquid/evm-typegen@latest`, which is 5.0.0. Typegen 5 writes a directory per contract plus `abi.support.ts` for the evm-abi 1.x API, while `src/index.ts` imports `./contracts/<address>.js` and `package.json` pins evm-abi `0.3.1`. Keep the pins and regenerate the contract module with typegen 4.6.0, which writes the single `<address>.ts` file the import expects:

```bash
rm -rf src/contracts/0x<address> src/contracts/abi.support.ts
npx @subsquid/evm-typegen@4.6.0 src/contracts 0x<address> --chain-id <chain-id>
```

That fetches the ABI by address, as the CLI did. To generate from a reviewed local ABI file, name it `0x<address>.json` and follow [ABI_GUIDE.md](ABI_GUIDE.md). The pipe then loads and goes on to connect to its target. `erc20Transfers` and `uniswapV3Swaps` projects are unaffected: they ship their ABI modules and run no typegen.

## Error Pattern 2: Portal API Connection Failed

**Symptoms:**
```
Error: connect ECONNREFUSED
Error: Portal request failed with status 429
{"error":{"type":"rate_limit_error","code":"overloaded","message":"..."}}
Error: Portal timeout after 30s
```

**First, know what the SDK already does:** the Pipes SDK retries retryable Portal failures **indefinitely by default** — connection errors (`ECONNREFUSED`, `ECONNRESET`, `ETIMEDOUT`, `terminated`), HTTP timeouts, and 429, 502, 503, 504, 521–524 and 529 responses (529 since beta.7) — honoring the `Retry-After` header when present, otherwise backing off on a schedule (10ms → 20s). A transient blip does not kill the pipe; sustained failures show up as a stalled sync with retry warnings in the log.

Portal returns **structured errors** (`{"error": {"type", "code", ...}}`): `rate_limit_error`/`overloaded` (429/529, always carries `Retry-After`) and `availability_error` (`no_workers`, `retries_exhausted`, `upstream_unavailable`; 502/503) are retried by the SDK. `invalid_request_error` (`malformed_request`, `unknown_dataset`) is **not retryable** — the request itself is wrong.

**Fix options:**
- **Persistent 429/529 `overloaded`** — Portal is at capacity: reduce concurrent indexers (especially Solana), or wait
- **`unknown_dataset` (404)** — wrong dataset name in the portal URL; verify with `curl -I https://portal.sqd.dev/datasets/{name}/metadata`
- **ECONNREFUSED that never recovers** — check internet, verify Portal URL
- **Timeout loops** — reduce batch size / block range

```typescript
// Smaller range reduces load
range: { from: 21_000_000, to: 21_100_000 }
```

**A response that stops sending data is not an error.** The client cuts it after 30 s on real-time data or 150 s on archive data, logs `portal response stalled: no block for <duration>, requesting again from block <N>`, and continues from the next block. A pipe that makes no progress for two minutes logs `stalled: waiting for data from the portal for <duration>` or `stalled: processing block <N> for <duration>`, which tells you whether the portal or your own transform and target write is stuck. The log lines and the `bodyTimeout` override are in [STREAM_RESILIENCE.md](STREAM_RESILIENCE.md#stalled-responses-and-the-stall-watchdog).

## Error Pattern 3: Database Connection Failed

**Symptoms:**
```
Error: connect ECONNREFUSED localhost:5432
Error: ClickHouse authentication failed
Error: Database 'pipes' does not exist
```

**Fix:**
1. Check database is running: `docker ps | grep clickhouse` (or postgres)
2. Verify the configured endpoint and authentication without displaying the connection secret
3. Start if needed: `docker start clickhouse` or `docker-compose up -d`
4. Create database if missing:
   ```bash
   docker exec clickhouse clickhouse-client --query "CREATE DATABASE IF NOT EXISTS pipes"
   ```

**BigQuery sink:** failures look nothing like this — there is no local process and no connection string. Credentials come from Google application-default credentials, and the dataset must already exist (the target creates tables, never datasets). Configuration failures surface as `E2201`–`E2213` codes; see [BIGQUERY_TARGET.md](BIGQUERY_TARGET.md).

### Harmless: `Unknown table 'pipes.sync'` on First Run

On a brand-new indexer, the SDK tries to read the sync table for resume state, fails (it doesn't exist yet), then creates it. **Ignore this error on first run.** At beta.11 the SDK catches the `UNKNOWN_TABLE` answer without logging it, so the pipe's own log stays clean; the message appears in the ClickHouse server log and in `system.query_log`. The name follows your config: `<database>.<settings.table>`, `pipes.sync` with the CLI defaults.

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
   # First save and validate the local ABI following ABI_GUIDE.md
   npx @subsquid/evm-typegen@4.6.0 src/contracts ./abi/contract.json
   ```

## Error Pattern 4b: Proxy Contract ABI — Crash on Startup

**Symptoms:**
```
TypeError: Cannot read properties of undefined (reading 'topic')
    at evmEventDecoder (evm-decoder.ts:...)   // "at evmDecoder" on alpha-era installs
```

**Diagnosis:** CLI/typegen fetched the proxy ABI (only `Upgraded` event), but `index.ts` references events like `Supply`, `Borrow`, etc. that only exist on the implementation.

**Confirm:**
```bash
grep "export const events" src/contracts/*.ts
# Only "Upgraded" = proxy
```

**Fix:**
1. Find implementation address on Etherscan → "Read as Proxy" tab
2. Save and validate `abi/implementation.json` following [ABI_GUIDE.md](ABI_GUIDE.md), then regenerate types:
   ```bash
   # First save and validate the local ABI following ABI_GUIDE.md
   npx @subsquid/evm-typegen@4.6.0 src/contracts ./abi/implementation.json
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
   docker exec <container> clickhouse-client \
     --query "SELECT * FROM <database>.sync FORMAT Vertical"
   ```
   Fix: use a separate database per indexer. If sharing is deliberate, confirm the pipe id and delete only that cursor row; never drop a shared `sync` table.

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
docker exec clickhouse clickhouse-client \
  --query "DESCRIBE TABLE <db>.<table>" | grep timestamp
```
ClickHouse parses `DateTime(3)` as `DateTime64(3)` (millisecond precision). A **seconds** value in that column lands in 1970 just as badly as a **milliseconds** value in a plain `DateTime` (verified: `1782669669` → `1970-01-21`).

**Fix:** Match the JS value to the column precision:

| Column type | Precision | Correct JS value |
|-------------|-----------|------------------|
| `DateTime` | seconds | `Math.floor(d.timestamp.getTime() / 1000)` |
| `DateTime(3)` / `DateTime64(3)` | milliseconds | `d.timestamp.getTime()` (do **not** divide) |

CLI-generated tables use `timestamp DateTime(3)`, so the scaffold's transformers correctly emit undivided `getTime()` — do **not** "fix" them by dividing. The `enrichEvents` helper (custom templates only) emits seconds, matching a plain `DateTime` column.

**Recovery:** Drop this pipe's data tables, delete its cursor row (`SELECT id, current, finalized FROM <db>.sync`, confirm the id, then delete that row), delete the SQLite file if it is a factory indexer, and restart.

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
   docker exec clickhouse clickhouse-client \
     --query "DROP TABLE IF EXISTS pipes.table_name"
   ```
2. Verify schema matches data types (addresses = String, amounts = Float64, block numbers = UInt64, timestamps = DateTime(3))
3. Clear the affected pipe's data and confirmed cursor row for a fresh start:
   ```bash
   docker exec clickhouse clickhouse-client \
     --query "ALTER TABLE pipes.sync DELETE WHERE id = '<confirmed-pipe-id>' SETTINGS mutations_sync=1"
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
3. If data looks corrupted, drop this pipe's data tables, delete its cursor row from `<db>.sync`, and start fresh. Drop the whole `sync` table only on a database that holds this one pipe

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

**Prevention:** use Node.js 22 LTS at version 22.15.0 or later. Node 20 does not satisfy the current package engine.

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

## Error Pattern 10b: Hyperliquid addFillRequest Missing Range

**Symptoms:**
```
TypeError: Cannot read properties of undefined (reading 'from')
    at parsePortalRange
    at HyperliquidFillsQueryBuilder.addRequest
    at HyperliquidFillsQueryBuilder.addFillRequest
```

**Diagnosis:** `addFillRequest()` requires a `range` parameter. Unlike EVM decoders where range is set once, each Hyperliquid fill filter needs its own range.

**Fix:**
```typescript
// WRONG
.addFillRequest({ request: { coin: ['BTC'] } })

// CORRECT
.addFillRequest({ range: { from: 920000000 }, request: { coin: ['BTC'] } })
```

Dataset starts at block **750,000,000**. In SDK 1.0+, use `hyperliquidFillsQuery()` instead of `new HyperliquidFillsQueryBuilder()`.

## Error Pattern 11: Renamed SDK Exports After Reinstall

**Symptoms:** a previously working project fails after a fresh `npm install` / lockfile regeneration:
```
TypeError: evmDecoder is not a function
SyntaxError: The requested module '@subsquid/pipes/evm' does not provide an export named 'evmPortalSource'
```

**Diagnosis:** the project pins the floating `"alpha"` dist-tag (the old alpha CLI's default), which resolves to `1.0.0-alpha.25` as of 2026-11-11 (`npm view @subsquid/pipes dist-tags --json`). That version already carries the beta-line renames: `evmDecoder` → `evmEventDecoder`, the `evmPortalSource`/`solanaPortalSource`/`hyperliquidFillsPortalSource` aliases removed (only `*PortalStream` remain), `evmPortalMockStream` → `mockEvmPortalStream` (itself deprecated since beta.9 in favour of `mockPortal({ blocks })`), `batchForInsert`/`chunk` → `chunkForInsert`, and query methods such as `addLog` → `addLogRequest`. Confirm with:
```bash
npm ls @subsquid/pipes        # installed version
grep '"@subsquid/pipes"' package.json   # "alpha" = floating tag
```

**Fix (pick one):**
1. **Migrate (recommended):** rename the imports/calls to the current names (see [SDK_FEATURES.md](SDK_FEATURES.md#renamed-in-the-beta-line)) and pin `"@subsquid/pipes": "^1.0.0-beta.10"`, the range the current CLI generates.
2. **Freeze:** pin the exact version the code was written for, e.g. `"@subsquid/pipes": "1.0.0-alpha.16"`, and migrate later.

## Error Pattern 12: Coded SDK Errors

SDK errors carry a code and a `See: https://docs.sqd.dev/en/sdk/pipes-sdk/errors/<code>` line. The full list is `docs/errors.md` in the SDK repository; the code ranges are in [SDK_FEATURES.md](SDK_FEATURES.md#typed-error-system). The entries below are the checks added between beta.7 and beta.11. Most fire at startup, before any data is written, on configurations that earlier versions ran with wrong results.

### E0003: Solana instruction decoder configuration

**Symptoms** (one of):
```
Instruction "swap" is not one of the program's instructions.
The decoder has no program address: `program` has no `programId`.
Instruction(s) "swap" have no discriminator (d1/d2/d4/d8).
Instructions "a" and "b" share the discriminator 0x... (d8).
A decoder mixes discriminator widths (d1, d8); the portal rejects more than one width per request.
```

**Cause:** `solanaInstructionDecoder` got an instruction that does not belong to its `program`, a `program` without an address, an event or malformed entry in place of an instruction, or instructions of several programs in one decoder. An Anchor discriminator is derived from the instruction name alone, so a same-named instruction of another program would decode under the wrong key.

**Fix:** pass the typegen module as `program` and take every entry from `program.instructions`. Give each program its own decoder under its own `outputs` key. For a second deployment of the same program use `program: { ...abi, programId: '<other address>' }`. If one program really has instructions of two discriminator widths, use one decoder per width. Example in [TEMPLATES.md](TEMPLATES.md#anchor-programs-use-typegen).

### E0004: Two EVM decoder entries match the same log

**Symptom:**
```
Events "a" and "b" can match the same log: Transfer(address,address,uint256), topic0 0xddf2...
```

**Cause:** two entries in one `evmEventDecoder({ events })` have the same topic0 and the same number of indexed parameters, and no indexed parameter is filtered in both on value lists that share no value. A log goes to one entry only, so the other entry would miss it without any error.

**Fix:** put each overlapping filter in its own `evmEventDecoder()` under its own `outputs` key; every output then receives all the logs its filter matches. Two entries stay legal when they cannot collide: ERC-20 and ERC-721 `Transfer` (different indexed-parameter count), or `{ from: ALICE }` and `{ from: BOB }` on the same event.

### E1006: Portal delivered a block out of order

**Symptoms:**
```
The portal delivered block 21,000,005 after block 21,000,005: a duplicate or out-of-order block.
The portal delivered block 20,999,990, below the requested start 21,000,000.
```

**Cause:** the portal sent a duplicate block, a lower block, or a block outside the requested range. The pipe stops before that block reaches any transformer or target, so nothing wrong was written. A gap between blocks is normal and is not this error.

**Fix:** nothing in your code. Restart; the pipe resumes from its persisted cursor. If it repeats, report it against the portal with the dataset name and block number.

### E1003 after a deep fork

A fork never rolls back finalized data (beta.9+). When no block the target retained above the persisted finalized block is on the canonical chain, `resolveFork()` returns nothing and the pipe stops with E1003. Restarting repeats the same failure. Index again from a block below the fork; for the BigQuery target follow [Manual rewind](BIGQUERY_TARGET.md#manual-rewind).

### E2321: Parquet directory holds another pipe's state

**Symptom:**
```
Parquet output directory './out' holds another pipe's state (_sqd_parquet_state.other.json), but this pipe's state file is '_sqd_parquet_state.my-pipe.json'.
```

**Cause:** the `dir` contains a state file under another key: another pipe's `_sqd_parquet_state.<id>.json`, or an id-less `_sqd_parquet_state.json` from before pipe ids. Crash recovery deletes files it cannot attribute, so two pipes in one directory would delete each other's output. The check runs at startup before any file is touched.

**Fix:** give each pipe its own `dir`. `settings.id` names the state file and does not let pipes share a directory. If the foreign file is this pipe's own state (the pipe `id` changed, or the state predates pipe ids), stop the pipe and rename the file to the name in the message to resume from it.

### E2411: Pub/Sub state schema mismatch

**Cause:** the SQLite state file was written by an SDK version whose state schema the installed version cannot open. A schema 3 file from `1.0.0-beta.4` migrates in place and is refused only while its outbox still holds signal operations, which later versions cannot publish.

**Fix:** for a beta.4 file, run beta.4 until the outbox drains, then upgrade. For any other version, run the SDK version that wrote the file, or start with fresh state under a fresh `namespace` and re-bootstrap consumers. Do not delete the state file of a namespace that has published: the sequence restarts and BigQuery ignores the lower sequence numbers.

### E2426: Pub/Sub state write failed

**Cause:** a write to the state file failed because its volume is full, gone, unreadable or remounted read-only. The transaction was rolled back. The message says whether the batch had already been published, which tells you whether consumers will see a redelivery.

**Fix:** free space or repair the volume, then restart. Keep the state file on a persistent volume sized for the outbox backlog, never on ephemeral container storage.

## Prevention Tips

1. **Always use Pipes CLI** — never manually create indexer files
2. **Verify environment first** — see [ENVIRONMENT_SETUP.md](ENVIRONMENT_SETUP.md)
3. **Start with recent blocks** — faster iteration, faster failures
4. **Check proxy status** before running — single biggest failure mode
5. **Use dedicated databases** — prevents sync table conflicts
