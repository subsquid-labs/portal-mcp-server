# Portal Stream Resilience

Patterns for keeping long-running Pipes SDK indexers alive through network failures, timeouts, and session interruptions.

## The Problem

Portal API streams over HTTP. Long-running syncs (millions of blocks) will inevitably hit:
- `ETIMEDOUT` — TCP read timeout, connection dropped
- `TypeError: terminated` — fetch aborted due to socket close
- `ECONNRESET` — server-side connection reset
- `429 Too Many Requests` — rate limiting

The Pipes SDK does **not** auto-retry on network errors. A single timeout kills the process.

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

The Pipes SDK writes a sync cursor to `{database}.sync` after each batch commit. On restart:

1. SDK reads `sync` table → finds last committed block
2. Logs `"Resuming indexing from X block"`
3. Requests Portal data from block X onward
4. No duplicate data (CollapsingMergeTree deduplicates via `sign` column)

The only risk is if the sync table is corrupted or shared between indexers. Each indexer should use its own database.

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
- Try skipping ahead: update the sync table manually
  ```sql
  ALTER TABLE my_db.sync UPDATE cursor = '{"block": NEXT_BLOCK}' WHERE id = 'stream'
  ```
- Or drop sync and restart from a later block by changing `range.from` in source config

## Related

- [PATTERNS.md](./PATTERNS.md) — General indexing patterns
- [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) — Error Pattern 2 (Portal API Connection Failed)
