---
name: squid-perf
description: Compare sync-time performance across one or more Squid SDK deployments. Fetches logs via sqd CLI, parses per-service progress, and generates a self-contained HTML report plus a Markdown summary with wall-clock/active-time/downtime breakdowns at percentage-based block breakpoints. Supports single-indexer mode (metrics only, no comparison). Use when the user invokes "/squid-perf", asks to compare Squid deployment sync times, or references squid performance profiling.
metadata:
  author: subsquid
  version: "1.1.13"
  category: core
---

# Squid performance comparison

Compare sync-time performance across one or more Squid SDK deployments. Produces a self-contained HTML report and a Markdown summary in the current working directory.

**Skill dir:** Resolve the directory containing this `SKILL.md` once and use its absolute path as `<skill-dir>`. Do not assume a Claude-specific installation path.
**Output dir:** `./squid-perf-output/` (CWD-relative; created if missing)

---

## Locked-in design (do not re-litigate)

These are settled — don't ask the user again unless they change something.

- **Comparison unit:** per-service (e.g., compare `settlement-arbitrum` in deployment A vs B independently of other services). Services present in every compared deployment go in comparison tables; services present in only some go in a "solo metrics" section with a warning.
- **Sync time metric:** report **wall-clock elapsed** (headline), **active processing time** (excludes gaps > 120s — configurable via `--downtime-threshold`), and **downtime** (wall − active). All three per breakpoint. If a restart occurs, measure the final uninterrupted processor segment and report the full restart count separately.
- **Block alignment:** assume all compared indexers cover the same block ranges (user's stated assumption). Use relative-from-first-log per deployment. If detected ranges diverge noticeably across deployments for a given service, emit a loud warning in the summary but still render.
- **Tier of metrics extracted:**
  - Tier 1 (always): `sqd:processor` / `sqd:batch-processor` progress lines → `(ts, current_block, target_block, rate, mapping_rate, items_per_sec, eta)`.
  - Tier 2 (always if present): `sqd:multicall` latency lines, restarts (detected via `current_block` going backward), and warning/error/critical totals. Detailed warning/error samples are capped at 1000/service.
  - Tier 3 (auto-discovered): any logger namespace appearing ≥10 times in ALL compared deployments for the SAME service; extract numeric fields; render as a small stats table (count, mean, median, p95).
- **Breakpoint selection:** percentage-based — 10 evenly-spaced breakpoints at 10%, 20%, ..., 100% of each service's **effective range**, where effective range = `(catchupBlock - firstBlock)`. `catchupBlock` = first progress row where `current >= target - 10` (indexer reached chain tip). Anything past this is steady-state, not sync, and is **excluded** from the metric.
  - Rationale: fraction-based clips (e.g., "99.9% of observed range") fail when the idle tail has many progress rows but few blocks — a deployment synced in 4 min and idled 10 days ends up with 99.9% of its blocks still inside the sync phase but 100% of the time inside the tail.
  - If a service has no catchup point in the logs (`stillSyncing`), falls back to actual `lastBlock` with a "never caught up" warning.
  - If a service was already caught up at the first progress row (`wasAlreadyCaughtUp`), the entire captured window is the idle tail — emit a warning and fall back to `lastBlock` (metrics reflect steady-state latency, not sync).
  - For multi-deployment comparison: shared effective range = `min(catchupBlock across deployments) - firstBlock`.
  - Output surfaces both the percentage and the absolute block count (e.g., "10% (500K blocks)"). Override via `--breakpoints 500K,1M,5M,10M,20M` (absolute block offsets from firstBlock; catchup logic does NOT apply to overrides).
- **Catchup gap threshold:** `CATCHUP_GAP_BLOCKS = 10` (constant in `report.mjs`). Matches the indexer's own steady-state lag behind chain head; tuneable if a chain's head noise is higher.
- **Output:** self-contained HTML (charts drawn by the template's own canvas code, no external scripts or CDN), plus Markdown with tables only (no charts in MD, link to HTML at the top).
- **HTML template:** the HTML report MUST be rendered from `<skill-dir>/templates/report.html`. `report.mjs` resolves this path relative to itself and substitutes placeholders rather than building markup via string concatenation. Edit the template to change layout/styling; do not inline HTML in the script.
- **Output layout:**
  ```
  ./squid-perf-output/
  ├── cache/
  │   └── <ref-slug>__<since>.log (+ .capture-start metadata and .done sentinel)
  ├── <ISO-timestamp>/
  │   ├── compare-syncs.json
  │   ├── parsed/<ref-slug>.json
  │   ├── report.html
  │   ├── report.md
  │   └── run.log
  └── latest -> <ISO-timestamp>/
  ```
- **Caching:** `(ref, since)` keyed; `.done` sentinel written atomically after successful fetch. `--force-refresh` ignores cache. Interrupted runs (no sentinel) are treated as absent.
- **Fetching:** parallel Bash (not subagents), one per deployment, wraps `sqd logs` in `expect` to handle the `"type \"it\" to fetch more logs"` pagination prompt. Retries 3× with 10s backoff. Partial success is OK (continue with ≥1 fetched deployment); if all fail, abort.
- **Script language:** Node (ESM, zero deps). Uses stdlib only. Shell scripts use bash + expect.
- **Still-syncing detection:** if last log timestamp ≤ 60s of fetch-start, flag as "live/partial" in summary.

---

## Orchestration

Execute the following phases **in order**. Track progress with the agent's task mechanism when one is available.

### Phase 0 — Preflight

Run `bash <skill-dir>/scripts/preflight.sh`.
- On non-zero exit: print the script's error output verbatim, then **stop**. Do not proceed.
- On zero exit: continue.

### Phase 1 — Collect inputs

Parse the user's request or slash-command arguments. Accepted shapes:

```
/squid-perf <ref1> [<ref2> ...]
/squid-perf --config path/to/compare-syncs.json
/squid-perf <ref1> <ref2> --breakpoints 500K,1M,5M --downtime-threshold 180 --force-refresh
```

Flags (all optional):
- `--config <path>`: read refs/since/labels from JSON (skips prompts entirely).
- `--breakpoints <csv>`: override auto-generated breakpoints. Accepts `K`/`M`/`B` suffixes.
- `--downtime-threshold <seconds>`: gap > N seconds counts as downtime (default 120).
- `--force-refresh`: ignore cache, re-fetch every deployment.

For each positional ref the user supplied:
1. Regex-validate the shape: `^[a-zA-Z0-9_-]+/[a-zA-Z0-9_-]+@[a-zA-Z0-9_-]+$`. On invalid shape, report which ref is malformed and stop.
2. If `since` or `label` for that ref is missing (not in config), ask for all missing values together:
   - "Deployment date for `<ref>` (ISO 8601 with `Z`, e.g., `2026-04-16T08:30:59Z`) — used for `sqd logs --since`?"
   - "Short label for `<ref>` (e.g., 'baseline', 'optimized')? Default: derived from ref name."
3. After collecting: resolve label collisions (append `_2`, `_3`, …).

If **zero** positional refs and no `--config`, prompt: "Which indexer refs would you like to compare? Enter space-separated refs in the form `<org>/<name>@<hash>`, or just one for single-indexer mode."

Write the resolved config to `<run-dir>/compare-syncs.json`:
```json
{
  "createdAt": "2026-04-21T14:22:03Z",
  "downtimeThresholdSec": 120,
  "breakpointsOverride": null,
  "indexers": [
    { "ref": "void/gmx-optimized-multichain-v2@oe4zvr", "since": "2026-04-16T08:30:59Z", "label": "optimized" },
    { "ref": "void/gmx-baseline-multichain-v1@xyz123",  "since": "2026-03-20T12:00:00Z", "label": "baseline" }
  ]
}
```

Where `<run-dir>` is `./squid-perf-output/<now-ISO-Z-with-colons-replaced-by-dash>/`. Create it now; also `./squid-perf-output/cache/` if missing.

### Phase 2 — Fetch logs (parallel Bash)

For each indexer in the resolved config, compute:
- `cache_name = node <skill-dir>/scripts/cache-key.mjs <ref> <since>`
- `cache_path = ./squid-perf-output/cache/<cache_name>`
- `slug = <cache_name without the .log suffix>`
- `sentinel_path = <cache_path>.done`
- `capture_start_path = <cache_path>.capture-start`

The helper combines a readable prefix with a SHA-256 suffix from the complete ref. Do not recreate only the readable prefix: refs such as `a-b/c@d` and `a/b-c@d` collapse to the same sanitized text, while the hash suffix keeps their cache, parsed, and sentinel paths distinct.

If `sentinel_path` and `capture_start_path` both exist and `--force-refresh` is NOT set: skip fetch, reuse cache. A legacy cache without capture-start metadata must be fetched again so live-state detection remains accurate.

Otherwise, launch the fetches **in parallel** using the agent's available shell/background mechanism — one process per indexer:

```
bash <skill-dir>/scripts/fetch-logs.sh <ref> <since> <cache_path>
```

Wait for each process to finish. Do not add proactive polling sleeps when the runtime can notify on completion.

The fetch script handles:
- Retry logic (3× with 10s backoff).
- Writes to `<cache_path>.partial` then atomic rename + `.done` sentinel on success.
- Persists the successful attempt's fetch-start time to `<capture_start_path>` before writing the sentinel.
- On permanent failure: exits non-zero with a clear error on stderr.

After all fetches return:
- For each failure, record in `failed_fetches[]`.
- If **all** failed: write a minimal `report.md` with the failure summary, print path, exit.
- Otherwise continue with whichever deployments succeeded. If only 1 left: single-indexer mode.

### Phase 3 — Parse

For each successfully-fetched deployment, run (can be parallel, but sequential is fine — parse is fast):

```
node <skill-dir>/scripts/parse.mjs \
  --input <cache_path> \
  --output <run-dir>/parsed/<slug>.json \
  --label <label>
```

The parser streams the log and emits structured JSON per service. See `scripts/parse.mjs` for the exact schema it produces. `errorCount` counts every WARN/ERROR line while `errors` retains at most 1,000 detailed samples.
The parser reads `<cache_path>.capture-start` automatically and measures live state against fetch start, not parser wall-clock time.

If parse fails for a deployment: record, continue. If all fail: stop with error.

Before rendering, write every fetch and parse failure to `<run-dir>/failures.json` as a JSON array. Use one object per failed deployment:

```json
[
  {
    "label": "experimental",
    "ref": "org/indexer@hash",
    "stage": "fetch",
    "message": "fetch failed after retries"
  }
]
```

Use only `"fetch"` or `"parse"` for `stage`. Write `[]` when nothing failed. Keep `message` concise and do not include credentials. The renderer adds these failures to the HTML warning payload and the Markdown summary so a partial comparison cannot appear complete.

### Phase 4 — Compute metrics & render

```
node <skill-dir>/scripts/report.mjs \
  --run-dir <run-dir> \
  [--breakpoints <csv>] \
  [--downtime-threshold <seconds>]
```

This reads `<run-dir>/compare-syncs.json` + all `<run-dir>/parsed/*.json`, computes breakpoints per service, calculates wall/active/downtime at each breakpoint per deployment, runs Tier-3 auto-discovery, generates the summary findings, writes:
- `<run-dir>/report.html` (self-contained)
- `<run-dir>/report.md`

### Phase 5 — Finalize

1. Update the `./squid-perf-output/latest` symlink atomically:
   ```
   ln -sfn <ISO-timestamp-dir> ./squid-perf-output/latest
   ```
2. Print to the user:
   ```
   ✓ Report: ./squid-perf-output/<id>/report.html
     Markdown: ./squid-perf-output/<id>/report.md
     Cached logs: ./squid-perf-output/cache/ (re-used on next run)
     Failed deployments: <fetch and parse failures, or "none">
   ```
3. Mark all tasks completed.

---

## Error handling

- **Preflight fails:** stop immediately, print install instructions from the script. Never proceed without sqd/expect/node/auth.
- **Malformed ref:** stop before fetching, surface the exact bad ref.
- **Fetch fails for one deployment:** continue with the rest. Summary gets a prominent warning.
- **Fetch fails for all:** write a minimal failure report and stop.
- **Parse fails:** treat like fetch failure for that deployment.
- **Interrupted (Ctrl-C):** partial cache files have no `.done` sentinel, so next run re-fetches. Never treat a partial as complete.
- **Live deployment:** if a deployment's most recent log is within 60s of fetch start, flag `"live": true` in parsed JSON; renderer prints a warning.
- **Range divergence:** if two deployments' starting blocks, effective sync ranges, or raw captured ranges differ by > 5% for the same service, emit a warning banner in summary.
- **Service missing from some deployments:** intersection only for comparison tables; solo section per missing service; warning in summary.

---

## Single-indexer mode

Triggered when only 1 ref is supplied (or only 1 fetch succeeded). Behavior:
- Skip "verdict" findings (no comparison).
- HTML/MD still show breakpoint table + Tier 2/3 stats per service.
- Line chart shows one series (that deployment).
- Summary block just lists services, block ranges, wall-time-to-end, and warnings.

---

## Notes for future maintenance

- The `"type \"it\" to fetch more logs"` pagination prompt is hard-coded in `fetch-logs.sh`. If the sqd CLI changes its prompt, update that string.
- `templates/report.html` is plain, readable HTML with inline CSS and JavaScript. Its `drawLineChart` function draws the progress and Tier-3 charts on a canvas, so the report needs no chart library and `report.mjs` fetches nothing. Edit the template directly to change the client renderer; don't replace it with a bundled or minified build.
- `report.mjs` injects a `ReportData` JSON payload (schema defined inside `templates/report.html` as a TEMPLATE CONTRACT comment) into the `<script id="__REPORT_DATA__">` slot. If the schema changes, update both the template contract and `buildReportData` in lockstep.
- To extend Tier-3 discovery (e.g., add known log shapes), edit `parse.mjs`'s `TIER3_EXTRACTORS`.
