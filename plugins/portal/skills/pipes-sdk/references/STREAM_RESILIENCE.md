# Portal Stream Resilience

Patterns for keeping long-running Pipes SDK indexers alive through network failures, timeouts, and session interruptions.

## What the SDK Handles vs. What Kills the Process

Portal API streams over HTTP. Long-running syncs (millions of blocks) will inevitably hit transient failures — and the SDK 1.0 line **retries these itself, indefinitely by default**:

- Connection errors: `ETIMEDOUT`, `ECONNRESET`, `TypeError: terminated`, `fetch failed`
- HTTP timeouts
- Retryable statuses: `429`, `502`, `503`, `504`, `521`–`524`, `529` (since beta.7), and any response that carries `Retry-After` — including Portal's structured `overloaded` (`rate_limit_error`) and `availability_error` responses

It honors the `Retry-After` header when Portal sends one (mandatory on `overloaded`), otherwise backs off on a fixed schedule (10ms → 100ms → 500ms → 2s → 10s → 20s, then 20s repeating). A network blip therefore does *not* kill the process — it shows up as a stalled sync with retry warnings (`HTTP request id:<n> will be retried in <ms> ms`).

### Stalled responses and the stall watchdog

Two mechanisms report a pipe that is alive but not moving. Neither stops the process.

**A response that stops sending data is cut and requested again** (beta.9+; before that the stream failed after 300 s). The limit is 30 s when Portal serves the response from real-time data and 150 s for archive data. The client logs a warning and asks for the rest from the block after the last one it parsed:

```
portal response stalled: no block for 30s, requesting again from block 21000042
```

Change the limit with `bodyTimeout` (milliseconds) in the stream's HTTP client options. It then applies to both kinds of response:

```typescript
evmPortalStream({
  id: 'my-pipe',
  portal: {
    url: 'https://portal.sqd.dev/datasets/ethereum-mainnet',
    http: { bodyTimeout: 60_000 },
  },
  outputs: /* ... */,
})
```

**The stall watchdog names the phase that is stuck** (beta.7+). After 120 s in one place the pipe logs a warning, then repeats it at a doubling interval capped at 15 minutes, so a stall of hours stays a handful of lines:

| Log line | Level | Meaning |
|----------|-------|---------|
| `stalled: waiting for data from the portal for 2m 30s` | warn | No data from Portal. Check Portal status and the network; the pipe continues on its own when data arrives |
| `stalled: processing block 21,000,042 for 2m` or `stalled: processing blocks 21,000,042 → 21,000,150 for 2m` | warn | Your transformers or the target write of that batch have not returned. Look at the database (locks, slow inserts, a hung connection) or a slow `.pipe()` step |
| `recovered: <phase> took 4m 10s` | info | The stalled phase finished |

The BigQuery target has its own 15 s watchdog on each append; see [BIGQUERY_TARGET.md](BIGQUERY_TARGET.md#observability). The portal line measures the time since the pipe last received a batch, so on a chain or filter that is quiet for minutes at the head, read it against the expected block time before treating it as a fault.

What still kills the process (and what supervisors are for):
- **Decode errors** — an undecodable record is fatal by default (see the `onError` hook in [SDK_FEATURES.md](SDK_FEATURES.md#decode-error-hook-onerror))
- **Sink failures** — ClickHouse/Postgres down or misconfigured, schema drift; for BigQuery, a missing dataset or a declared schema that no longer matches the live table (see [BIGQUERY_TARGET.md](BIGQUERY_TARGET.md))
- **Non-retryable Portal errors** — `invalid_request_error` (`malformed_request`, `unknown_dataset`): the request is wrong and retrying can't help
- **Process-level faults** — OOM kills, unhandled exceptions in your `.pipe()` transforms, host reboots

## Pattern 1: Process Supervisor (Recommended for Production)

Use a process manager that auto-restarts on crash. The indexer's sync table in ClickHouse tracks progress, so restarts resume from the last committed block.

### pm2

```bash
# Install
npm install -g pm2

# Start with auto-restart
pm2 start "npx tsx src/index.ts" --name my-indexer --restart-delay 5000

# Monitor
pm2 logs my-indexer
pm2 monit

# Stop
pm2 stop my-indexer
pm2 delete my-indexer
```

Key flags:
- `--restart-delay 5000` — wait 5s before restart (avoids hammering Portal after outage)
- `--max-restarts 50` — give up after 50 crashes (something is fundamentally wrong)
- `--exp-backoff-restart-delay 1000` — exponential backoff: 1s, 2s, 4s, 8s...

### supervisord

```ini
[program:my-indexer]
command=npx tsx src/index.ts
directory=/path/to/indexer
autorestart=true
startretries=50
startsecs=10
stderr_logfile=/var/log/indexer.err.log
stdout_logfile=/var/log/indexer.out.log
```

### Simple bash loop

For development — not production:

```bash
#!/bin/bash
# restart-indexer.sh
MAX_RETRIES=20
RETRY_DELAY=5
attempt=0

while [ $attempt -lt $MAX_RETRIES ]; do
  echo "[$(date)] Starting indexer (attempt $((attempt + 1))/$MAX_RETRIES)"
  npx tsx src/index.ts
  exit_code=$?

  if [ $exit_code -eq 0 ]; then
    echo "[$(date)] Indexer exited cleanly"
    break
  fi

  attempt=$((attempt + 1))
  echo "[$(date)] Indexer crashed (exit $exit_code). Restarting in ${RETRY_DELAY}s..."
  sleep $RETRY_DELAY
  RETRY_DELAY=$((RETRY_DELAY * 2))  # exponential backoff
  [ $RETRY_DELAY -gt 300 ] && RETRY_DELAY=300  # cap at 5 minutes
done
```

## Pattern 2: Running Indexers During Development

When working in Claude Code or other AI-assisted sessions, background tasks may get killed by session timeouts. Use `nohup` to detach the process:

```bash
# Start detached — survives session end
cd /path/to/indexer
nohup npx tsx src/index.ts > /tmp/my-indexer.log 2>&1 &
echo "PID: $!"

# Monitor
tail -f /tmp/my-indexer.log

# Check if still running
ps aux | grep tsx | grep -v grep

# Stop
kill $(pgrep -f "tsx src/index.ts")
```

**Why not `npm run dev &`?** The `&` keeps the process as a child of the current shell. If the shell exits (session timeout), the process may be killed. `nohup` prevents SIGHUP from killing it.

## Pattern 3: Wrapper with Retry Logic

For cases where you want retry logic inside the Node.js process itself (e.g., you want to log retries, send alerts, etc.):

```typescript
// src/run-with-retry.ts
import { spawn } from 'child_process'

const MAX_RETRIES = 20
const BASE_DELAY = 5000 // 5 seconds

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function main() {
  let attempt = 0
  let delay = BASE_DELAY

  while (attempt < MAX_RETRIES) {
    attempt++
    console.log(`[${new Date().toISOString()}] Starting indexer (attempt ${attempt}/${MAX_RETRIES})`)

    const exitCode = await new Promise<number>((resolve) => {
      const child = spawn('npx', ['tsx', 'src/index.ts'], {
        stdio: 'inherit',
        cwd: process.cwd(),
      })
      child.on('exit', (code) => resolve(code ?? 1))
    })

    if (exitCode === 0) {
      console.log('Indexer exited cleanly')
      break
    }

    console.log(`Indexer crashed (exit ${exitCode}). Retrying in ${delay / 1000}s...`)
    await sleep(delay)
    delay = Math.min(delay * 2, 300_000) // cap at 5 minutes
  }
}

main()
```

## When Each Pattern Applies

| Scenario | Pattern |
|----------|---------|
| Production deployment | pm2 or supervisord |
| Development in Claude Code / AI session | `nohup` + log file |
| CI/CD or one-off backfill | Bash restart loop |
| Custom alerting on crash | Node.js wrapper |

## Why Restarts Are Safe

The Pipes SDK writes a sync cursor to `{database}.sync` after each batch commit, keyed by the pipe's `id` (since alpha.15; older versions used a static `'stream'` key). On restart:

1. SDK reads `sync` table → finds the last committed block for this pipe `id`
2. Logs `"Resuming indexing from X block"`
3. Requests Portal data from block X onward
4. Calls the target's `onRollback({ reason: 'recovery', safeCursor, store })` hook so rows written past the saved cursor can be removed before replay

`CollapsingMergeTree(sign)` does not deduplicate two identical `sign = 1` rows. Persistent ClickHouse targets therefore need an `onRollback` handler that calls `store.removeRowsAfter(safeCursor, { tables })`; without it, an unclean restart can replay duplicates and a hot-stream fork is refused (E2007). The target saves a start cursor before the first batch's data, so a crash inside the first batch is repaired the same way. The hook API is described in [SDK_FEATURES.md](SDK_FEATURES.md#clickhouse). The remaining risks include a corrupted sync table or two pipes sharing the same `id` and database. Keep one database per project and don't rename a pipe's `id` casually — the cursor is keyed by it, so a rename orphans the old cursor and the pipe re-syncs from its range start.

## Diagnosing Repeated Crashes

If the indexer crashes repeatedly at the same block:

```bash
# Check the last few log lines before crash
tail -50 /tmp/my-indexer.log | grep -B5 "Error\|TypeError\|ETIMEDOUT"

# Check which block it's stuck on
grep "Resuming" /tmp/my-indexer.log | tail -3
```

If it always resumes from the same block and crashes:
- The data at that block may be malformed
- Do not hand-edit cursor columns. Current state is split across `current`, `finalized`, and `rollback_chain`; changing only one can corrupt recovery.
- Fix or explicitly exclude the malformed data, then restart. If the user deliberately abandons the old range, use a new pipe id and a new/cleared data target, or reset only the confirmed cursor row after backing up the database.

## Related

- [PATTERNS.md](./PATTERNS.md) — General indexing patterns
- [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) — Error Pattern 2 (Portal API Connection Failed)
