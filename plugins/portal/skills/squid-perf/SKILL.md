---
name: squid-perf
description: Measure how long Squid SDK deployments took to sync, from their sqd logs, as an HTML report plus a Markdown summary. Use when the user invokes /squid-perf, asks how long a squid took to sync or whether one deployment synced faster than another, or wants downtime or restart metrics for an SQD Cloud deployment.
license: Apache-2.0
metadata:
  author: subsquid
  version: "1.1.15"
  category: core
---

# Squid sync performance

Fetches `sqd logs` for one or more SQD Cloud deployments, parses each service's progress, and writes `report.html` and `report.md` under `./squid-perf-output/` in the current working directory. Two or more deployments produce a comparison; one produces its metrics alone.

`<skill-dir>` below is the absolute path of the directory holding this `SKILL.md`. Resolve it once. Run the six steps in order.

## 1. Preflight

```bash
bash <skill-dir>/scripts/preflight.sh
```

It checks `sqd`, `expect`, `node` and the `sqd` login. On a non-zero exit, show the user the script's output as printed (it carries the install and login instructions) and stop there.

Done when the script exits `0`.

## 2. Collect inputs

Accepted requests:

```
/squid-perf <ref1> [<ref2> ...]
/squid-perf --config path/to/compare-syncs.json
/squid-perf <ref1> <ref2> --breakpoints 500K,1M,5M --downtime-threshold 180 --force-refresh
```

| Flag | Effect |
|---|---|
| `--config <path>` | Read refs, `since` and labels from JSON; nothing is asked |
| `--breakpoints <csv>` | Absolute block offsets from each service's first block, replacing the ten percentage breakpoints. Takes `K`, `M`, `B` suffixes |
| `--downtime-threshold <seconds>` | A log gap longer than this counts as downtime. Default `120` |
| `--force-refresh` | Fetch every deployment again, whatever the cache holds |

Each deployment needs three values:

- **`ref`** matches `^[a-zA-Z0-9_-]+/[a-zA-Z0-9_-]+@[a-zA-Z0-9_-]+$` (`<org>/<name>@<hash>`). On a mismatch, name the malformed ref and stop before fetching.
- **`since`** is the deployment time in ISO 8601 with `Z` (`2026-04-16T08:30:59Z`), passed to `sqd logs --since`.
- **`label`** is a short name such as `baseline` or `optimized`. It defaults to one derived from the ref name; give colliding labels `_2`, `_3` suffixes.

Ask for every missing `since` and `label` in one message. With no refs and no `--config`, ask which refs to measure. The measurement choices under "What the report measures" are settled, so those two values and the refs are the only questions.

Create `<run-dir>` = `./squid-perf-output/<UTC now, ISO 8601, colons replaced by dashes>/` and `./squid-perf-output/cache/`, then write the resolved config to `<run-dir>/compare-syncs.json`:

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

Done when `compare-syncs.json` exists and every indexer in it has a valid `ref`, a `since` and a unique `label`.

## 3. Fetch logs

For each indexer:

```bash
cache_name=$(node <skill-dir>/scripts/cache-key.mjs <ref> <since>)
cache_path=./squid-perf-output/cache/$cache_name
slug=${cache_name%.log}
```

Take the name from the helper every time. It appends a SHA-256 suffix of the full ref, which keeps refs such as `a-b/c@d` and `a/b-c@d` apart after sanitising.

A cache entry is complete when both `<cache_path>.done` and `<cache_path>.capture-start` exist. Reuse a complete entry unless `--force-refresh` is set. Fetch everything else, including an entry with one of the two files missing (an interrupted run, or a cache written before capture-start metadata existed).

Start one fetch per indexer, all in parallel, as background shell processes:

```bash
bash <skill-dir>/scripts/fetch-logs.sh <ref> <since> <cache_path>
```

The script pages through `sqd logs`, retries three times, and writes the `.done` sentinel only after a full fetch. Wait for each process to exit, through the runtime's completion notification where it has one.

- Some fetches failed: record each one for `failures.json` (step 4) and continue with the rest. One remaining deployment gives a single-deployment report.
- Every fetch failed: write a `report.md` in `<run-dir>` that lists the failures, give the user its path, and stop.

Done when every indexer has either a complete cache entry or a recorded failure.

## 4. Parse

For each fetched deployment:

```bash
node <skill-dir>/scripts/parse.mjs \
  --input <cache_path> \
  --output <run-dir>/parsed/<slug>.json \
  --label <label>
```

A deployment whose parse fails is recorded and skipped, like a failed fetch. When every parse fails, stop and report the errors.

Then write every fetch and parse failure to `<run-dir>/failures.json`, or `[]` when nothing failed:

```json
[
  { "label": "experimental", "ref": "org/indexer@hash", "stage": "fetch", "message": "fetch failed after retries" }
]
```

`stage` is `"fetch"` or `"parse"`. Keep `message` to one short line with credentials removed. The renderer puts these failures in both reports, which is how a partial comparison shows as partial.

Done when `<run-dir>/parsed/` holds one JSON file per deployment that parsed and `failures.json` exists.

## 5. Render

```bash
node <skill-dir>/scripts/report.mjs \
  --run-dir <run-dir> \
  [--breakpoints <csv>] \
  [--downtime-threshold <seconds>]
```

Done when `<run-dir>/report.html` and `<run-dir>/report.md` both exist.

## 6. Hand over

```bash
ln -sfn <run-dir-name> ./squid-perf-output/latest
```

Tell the user:

```
Report:    ./squid-perf-output/<run-dir-name>/report.html
Markdown:  ./squid-perf-output/<run-dir-name>/report.md
Cached logs: ./squid-perf-output/cache/ (reused on the next run)
Failed deployments: <label and stage of each, or "none">
```

Then answer the question they asked (which deployment synced faster, how long the sync took) from `report.md`, and repeat every warning the report raises next to the numbers it qualifies.

Done when the user has both paths, the failed deployments, and an answer that carries the report's warnings.

## What the report measures

Use this to read the report and to answer questions about its numbers.

- **Per service.** Each service (say `settlement-arbitrum`) is compared with the same service in the other deployments. Services present in every deployment get comparison tables; a service present in only some gets a solo section with a warning.
- **Three times.** *Wall-clock* elapsed is the headline. *Active* time leaves out log gaps longer than the downtime threshold. *Downtime* is wall minus active. After a restart (the current block moves backward), the times cover the final uninterrupted run and the restart count is reported beside them.
- **Sync ends at catch-up.** A service has caught up at its first progress line within 10 blocks of the target. Everything later is steady state and stays out of the metric, so a squid that synced in four minutes and then idled for ten days reports four minutes.
- **Breakpoints.** Ten of them, at 10% to 100% of the range from the first block to the catch-up block, each shown with its block count. A comparison uses the shortest range among the deployments. `--breakpoints` replaces them with absolute offsets and skips the catch-up logic.
- **Same ranges assumed.** Deployments are aligned from their own first log line, on the assumption that they index the same blocks.
- **Other signals.** Multicall latency, warning and error totals (up to 1,000 samples kept per service), and count, mean, median and p95 for numeric fields of any logger that appears at least 10 times in the same service of every deployment.

| Warning in the report | Meaning |
|---|---|
| "never reached chain tip within the captured logs" | The logs end before catch-up. 100% means the last block seen, and the sync was still in progress or the logs were truncated |
| "was already at chain tip when logs begin" | No sync phase was captured. The numbers describe steady-state latency |
| "deployment was running live" | The last log line is within 60 s of the fetch, so the deployment was still running |
| A range-divergence banner | Start blocks or ranges differ by more than 5% between deployments for one service, which weakens the same-ranges assumption |
| A failed deployment | A fetch or parse failed and the comparison leaves that deployment out |
