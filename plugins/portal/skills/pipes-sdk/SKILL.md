---
name: pipes-sdk
description: Build, configure, deploy, and troubleshoot durable blockchain indexers with the Subsquid Pipes SDK (EVM, Solana, Tron, Bitcoin, Hyperliquid) when Portal MCP or curl previews are insufficient for backfills, recurring syncs, joins, app-owned data, or production analytics.
compatibility: Requires pnpm/pnpx for @subsquid/pipes-cli; Node.js v22 LTS (@subsquid/pipes requires >=22.15.0) — avoid v25+.
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Grep
metadata:
  author: subsquid
  version: "1.2.0"
  category: core
---

# Pipes SDK

One skill for the full Pipes SDK lifecycle: scaffold new indexers, diagnose runtime errors, optimize sync performance, and validate data quality.

## When to Use This Skill

Activate when the user wants to:
- **Create a new indexer** — scaffold EVM or Solana projects with the CLI; set up Tron, Bitcoin, or Hyperliquid indexers manually with the SDK
- **Fix runtime errors** — compilation failures, DB issues, Portal timeouts, decoding errors
- **Optimize sync performance** — slow indexing, high memory, large ranges
- **Validate data quality** — NULL checks, gaps, malformed addresses, duplicate events
- **Deploy an indexer** — local Docker or ClickHouse Cloud
- **Write to analytics sinks** — ClickHouse, PostgreSQL (Drizzle), BigQuery, Parquet files
- **Turn a Portal handoff into durable infrastructure** — when a Portal MCP answer or curl export is not enough

Common trigger phrases: *"create a new indexer"*, *"my indexer crashed"*, *"error"*, *"not working"*, *"slow"*, *"optimize"*, *"deploy to ClickHouse Cloud"*, *"track X events on Ethereum/Solana/Tron/Bitcoin/Hyperliquid"*.

## Portal Handoff Workflow

Use Pipes when a Portal MCP or raw Stream API workflow crosses from exploration into a maintained data product.

Good Pipes triggers:
- long historical backfills
- recurring syncs or scheduled refresh
- protocol-specific joins
- normalized tables for an app/backend
- custom metrics, alerts, or dashboards
- transforms that should be versioned and tested
- data too large for MCP chat responses or one-off curl files

If the input includes a Portal `pipes_handoff` recipe, preserve its network, filters, time window, outputs, and validation hints. Treat the Portal MCP/curl result as the baseline, scaffold the indexer, and validate the first output against the closest Portal query over the same bounded window.

Before scaffolding, say why Pipes is the right surface. Portal MCP is best for bounded answers and investigation pivots; Portal Stream API/curl is best for reproducible one-off extraction; Pipes is best for durable indexing, transforms, and storage.

## Critical Environment Constraints

**Node.js:** v22 LTS. `@subsquid/pipes` declares `engines.node >= 22.15.0` (v20 no longer qualifies); v25.x has zstd decompression bugs that crash during large Portal streams. See [ENVIRONMENT_SETUP.md](references/ENVIRONMENT_SETUP.md).

**CLI:** `@subsquid/pipes-cli@1.0.0-alpha.4`. Always use programmatic mode via `--config '{...}'`. **Never create indexer files manually** — that bypasses scaffolding, dependency setup, and configuration.

**npm dist-tags (trap):** a bare `npm install @subsquid/pipes` resolves to the pre-1.0 `0.1.0-beta.17` — a different, older API. Manual (non-CLI) setups must install `@subsquid/pipes@alpha` (CLI-scaffolded projects already pin `"@subsquid/pipes": "alpha"`). Keep the explicit `pipes-cli@1.0.0-alpha.4` pin: the CLI's `@latest` is the *older* alpha.1.

## Known CLI Quirks

1. **`Unknown table 'pipes.sync'` on first run** — harmless. SDK creates the table and continues.

## Network Coverage

| Network | CLI scaffolding | SDK module |
|---------|----------------|------------|
| EVM chains | ✅ `networkType: "evm"` | `@subsquid/pipes/evm` |
| Solana | ✅ `networkType: "svm"` | `@subsquid/pipes/solana` |
| Tron | ❌ manual setup | `@subsquid/pipes/tron` — `tronPortalStream`, `tronQuery()` |
| Bitcoin | ❌ manual setup | `@subsquid/pipes/bitcoin` — `bitcoinPortalStream`, `bitcoinQuery()` |
| Hyperliquid fills | ❌ manual setup | `@subsquid/pipes/hyperliquid` — `hyperliquidFillsPortalStream` |

Manual setup patterns for Tron, Bitcoin, and Hyperliquid are in [TEMPLATES.md](references/TEMPLATES.md); stream/query APIs in [SDK_FEATURES.md](references/SDK_FEATURES.md).

## Scaffolding an Indexer

See [TEMPLATES.md](references/TEMPLATES.md) for the full catalog: `erc20Transfers`, `uniswapV3Swaps`, `custom` for EVM; `tokenBalances`, `custom` for Solana (`networkType: "svm"`); manual setup for Tron, Bitcoin, and Hyperliquid.

### Step 0: Research Protocol (MANDATORY)

**Before writing any code**, run through [RESEARCH_CHECKLIST.md](references/RESEARCH_CHECKLIST.md):
- Identify which contract emits the target events
- **Check for proxy contracts** — #1 failure mode; ~6 of 9 real indexers need manual proxy resolution
- Find the deployment block (for full history) or pick a recent start block (for faster tests)
- Decide on sink (ClickHouse recommended, PostgreSQL with Drizzle, CSV)
- Name the project

### Step 1: Inspect templates (optional)

```bash
pnpx @subsquid/pipes-cli@1.0.0-alpha.4 init --schema
```

Shows all template IDs (camelCase!), required params, and sink configs.

### Step 2: Generate the project

```bash
pnpx @subsquid/pipes-cli@1.0.0-alpha.4 init --config '{
  "projectFolder": "/path/to/my-indexer",
  "packageManager": "npm",
  "networkType": "evm",
  "network": "ethereum-mainnet",
  "templates": [{"templateId": "erc20Transfers", "params": {"contractAddresses": ["0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"]}}],
  "sink": "clickhouse"
}'
```

Template IDs must be camelCase: `uniswapV3Swaps` (not `uniswap-v3-swaps`), `erc20Transfers` (not `erc20-transfers`).

### Step 3: Post-generation checklist

> **Proxy check is #1 priority** — see [ABI_GUIDE.md](references/ABI_GUIDE.md) for full proxy handling.

1. **Proxy contract check (custom template):**
   ```bash
   grep "export const events" <project>/src/contracts/*.ts
   ```
   If only `Upgraded`, it's a proxy. Regenerate types from the implementation and update the import in `src/index.ts` — but keep the proxy address in `contracts:`.

2. **Project-specific database (MANDATORY):**
   CLI defaults the database to `pipes`. On `@subsquid/pipes` ≤ alpha.14, two indexers sharing `pipes` collide on the sync cursor (second one resumes from the first's position). alpha.15+ keys the cursor by pipe `id`, but identically named data tables (e.g. two `erc20_transfers`) still collide — keep one database per project.
   ```bash
   DB_NAME=$(basename <project-folder> | tr '-' '_')
   docker exec <container> clickhouse-client --password <pw> \
     --query "CREATE DATABASE IF NOT EXISTS $DB_NAME"
   sed -i '' "s/CLICKHOUSE_DATABASE=.*/CLICKHOUSE_DATABASE=$DB_NAME/" <project-folder>/.env
   ```

3. **ClickHouse password matches container:**
   ```bash
   grep CLICKHOUSE_PASSWORD <project-folder>/.env
   # For an existing standalone container: match the container's password
   # For the generated docker-compose: "password" is correct
   ```

4. **Contract addresses present (custom template):**
   ```bash
   grep "contracts:" <project>/src/index.ts
   ```

5. **Know your table names (custom template):** one table per event, named `{contractName}_{eventName}` in snake_case. There is no combined table.

### Step 4: Start and validate

```bash
cd <project-folder>
npm run dev
```

Verify the first log line shows your intended start block. If it says `Resuming from X`, decide whether resume is correct:

| Scenario | Action |
|----------|--------|
| Indexer crashed mid-sync, want to continue | Keep it — verify X is near where it stopped |
| Changed start block or contract address | Drop sync (`DROP TABLE IF EXISTS <db>.sync`) |
| Different indexer on same database | Drop sync OR use a separate database |
| Brand new project, first run | Drop sync — shouldn't exist |
| Re-index from scratch | Drop sync + data tables |

Full deployment (local Docker, ClickHouse Cloud, Railway) in [DEPLOYMENT.md](references/DEPLOYMENT.md).

## Troubleshooting

Match the user's symptom to a pattern. Full diagnostics in [TROUBLESHOOTING.md](references/TROUBLESHOOTING.md).

| Symptom | Root cause | See |
|---------|-----------|-----|
| `Type 'LogParams' not assignable` | `@subsquid/evm-abi` v1 instead of v0.3.1 | [TROUBLESHOOTING.md](references/TROUBLESHOOTING.md#error-pattern-1-abi-version-mismatch) |
| Portal 429 / timeout / ECONNREFUSED | Rate limit or network | [TROUBLESHOOTING.md](references/TROUBLESHOOTING.md#error-pattern-2-portal-api-connection-failed) |
| `ClickHouse authentication failed` | DB creds / not started | [TROUBLESHOOTING.md](references/TROUBLESHOOTING.md#error-pattern-3-database-connection-failed) |
| `Cannot read properties of undefined (reading 'topic')` | Proxy ABI loaded | [TROUBLESHOOTING.md](references/TROUBLESHOOTING.md#error-pattern-4b-proxy-contract-abi--crash-on-startup) |
| DB empty after run | Start block / proxy / filter / sync conflict | [TROUBLESHOOTING.md](references/TROUBLESHOOTING.md#error-pattern-5-missing-data) |
| Factory indexer: 0 rows for 30–60s | Cold-start from `range.from` forward | [TROUBLESHOOTING.md](references/TROUBLESHOOTING.md#error-pattern-5b-factory-indexer-shows-zero-data) |
| Timestamps show 1970 | JS value precision doesn't match column precision | [TROUBLESHOOTING.md](references/TROUBLESHOOTING.md#error-pattern-5c-timestamps-show-1970-dates) |
| `heap out of memory` / killed | Batch too large | [TROUBLESHOOTING.md](references/TROUBLESHOOTING.md#error-pattern-6-memory-issues) |
| `Table already exists` / type mismatch | Schema drift | [TROUBLESHOOTING.md](references/TROUBLESHOOTING.md#error-pattern-7-clickhouse-schema-issues) |
| `ZSTD_error_prefix_unknown` | Node v25+ zstd bug | [TROUBLESHOOTING.md](references/TROUBLESHOOTING.md#error-pattern-9-nodejs-version-compatibility-issues) |
| Hyperliquid validate counts wildly off | SDK vs Portal block batching | [TROUBLESHOOTING.md](references/TROUBLESHOOTING.md#error-pattern-10-hyperliquid-validation--sdk-vs-portal-block-batching) |
| `addFill ... reading 'from'` | Missing `range` on `addFill()` | [TROUBLESHOOTING.md](references/TROUBLESHOOTING.md#error-pattern-10b-hyperliquid-addfill-missing-range) |

Standard diagnostic flow: read error → match pattern → read `src/index.ts`, `package.json`, `.env` → apply fix → restart → validate data.

## Key SDK Patterns

The Pipes SDK is feature-rich — a handful of patterns cover 80% of use cases.

- **Event parameter filtering** (server-side): filter by indexed params at the decoder for max throughput — see [PATTERNS.md](references/PATTERNS.md#6-event-parameter-filtering-server-side).
- **Factory pattern**: track dynamically deployed children (Uniswap pools, MetaMorpho vaults). Includes SQLite cache, cold-start delay, `d.factory?.event.*` metadata — see [PATTERNS.md](references/PATTERNS.md#3-factory-pattern-with-pre-indexing).
- **Topic0-only filtering**: track events across ALL contracts that emit a specific signature, no address list needed. Best for protocol-unique events — see [PATTERNS.md](references/PATTERNS.md#4-topic0-only-global-filtering).
- **Multi-output decoders**: run multiple named decoders in one pipeline via `outputs: { transfers: ..., swaps: ... }` — see [PATTERNS.md](references/PATTERNS.md#5-parallel-event-decoding-multi-output).
- **SDK 1.0 features**: time-based ranges, `defineAbi`, typed errors, testing library — see [SDK_FEATURES.md](references/SDK_FEATURES.md).
- **Tron & Bitcoin streams**: native query builders and portal streams for `tron-mainnet` and `bitcoin-mainnet` — see [SDK_FEATURES.md](references/SDK_FEATURES.md#tron-portal-streams).
- **BigQuery & Parquet targets**: `bigqueryTarget` (auto-created partitioned tables, fork-safe DELETEs) and `parquetTarget` (finalized-only rotating files for DuckDB/Spark/Athena) — see [SDK_FEATURES.md](references/SDK_FEATURES.md#target-configuration).
- **Pipe-id-keyed cursors (alpha.15+)**: targets key sync state by the pipe `id`, so multiple pipes can share one database. Legacy ClickHouse cursors migrate automatically — see [SDK_FEATURES.md](references/SDK_FEATURES.md#cursor-keying--upgrading-to-alpha15).
- **`evmPortalSource` alias**: CLI-scaffolded `src/index.ts` calls `evmPortalSource(...)`, an exported alias of `evmPortalStream` — same function, no behavioral difference.
- **Portal response cache**: `portalSqliteCache` (from `@subsquid/pipes/portal-cache/node`) caches Portal stream responses on disk (SQLite + zstd) to speed up re-runs and backfills over the same range; wire it via the stream's `cache` option — see [SDK_FEATURES.md](references/SDK_FEATURES.md).
- **Observability**: Prometheus metrics via `metricsServer()` (`@subsquid/pipes/metrics/node`, stream `metrics` option) and OpenTelemetry tracing via `opentelemetryProfiler()` (`@subsquid/pipes/opentelemetry`, stream `profiler` option) — see [SDK_FEATURES.md](references/SDK_FEATURES.md).

### DeFi Protocol Forks

Many DeFi protocols share ABIs across forks — reuse saves time:
- **Aave V3 forks** (same Pool ABI): SparkLend, Radiant, Seamless, Granary
- **Uniswap V2 forks** (same Pair/Factory): SushiSwap, PancakeSwap, TraderJoe, Camelot
- **Compound V2 forks** (same cToken): Venus, Benqi, Tectonic

Detect by matching topic0 hashes or checking "forked from" in protocol docs.

## Performance

Full benchmarks and tuning in [PERFORMANCE.md](references/PERFORMANCE.md).

**Sync speed factors:**
- Block range: 1M blocks ≈ 5–10 min, 5M ≈ 30–60 min, full chain ≈ 2–4 hours
- Filtering: contract events (fastest) > factory (medium) > address (slowest)
- Contract count: fewer = faster

**Quick testing strategy:**
1. Start with recent blocks (`range.from: '21,000,000'`)
2. Limit to 1–3 contracts first
3. Expand once working

## Data Validation

Before declaring an indexer production-ready, run the checks in [VALIDATION.md](references/VALIDATION.md):

- [ ] Table structure matches design
- [ ] No NULLs in required fields
- [ ] Addresses match `^0x[0-9a-fA-F]{40}$`
- [ ] Transaction hashes are 66 chars
- [ ] Block range complete (no gaps)
- [ ] Data increases over time
- [ ] Sample rows match block explorer

## Long-Running Indexers

For production indexers that must survive crashes and reboots, see [STREAM_RESILIENCE.md](references/STREAM_RESILIENCE.md): retry patterns, pm2 supervisor, nohup for dev sessions.

## Analytics Queries

Dashboard-grade ClickHouse patterns (time bucketing, conditional aggregation, parameterized WHERE) in [CLICKHOUSE_ANALYTICS.md](references/CLICKHOUSE_ANALYTICS.md).

## Reference Files

| File | Purpose |
|------|---------|
| [ENVIRONMENT_SETUP.md](references/ENVIRONMENT_SETUP.md) | Prerequisites, Node version, platform notes |
| [RESEARCH_CHECKLIST.md](references/RESEARCH_CHECKLIST.md) | Protocol research workflow before scaffolding |
| [TEMPLATES.md](references/TEMPLATES.md) | EVM/Solana/Hyperliquid template catalog and manual setup |
| [ABI_GUIDE.md](references/ABI_GUIDE.md) | Fetching ABIs, `commonAbis`, proxy handling |
| [SCHEMA_GUIDE.md](references/SCHEMA_GUIDE.md) | ClickHouse engine selection, ORDER BY, BigInt handling |
| [HYPERLIQUID_GUIDE.md](references/HYPERLIQUID_GUIDE.md) | Hyperliquid fills: manual setup, coins, benchmarks |
| [DEPLOYMENT.md](references/DEPLOYMENT.md) | Local Docker and ClickHouse Cloud deployment |
| [SDK_FEATURES.md](references/SDK_FEATURES.md) | SDK 1.0 features, testing library, event field access |
| [PATTERNS.md](references/PATTERNS.md) | Factory, topic0-only, multi-output, aggregations |
| [TROUBLESHOOTING.md](references/TROUBLESHOOTING.md) | Full error catalog with diagnostics and fixes |
| [VALIDATION.md](references/VALIDATION.md) | Data quality SQL checks and final checklist |
| [PERFORMANCE.md](references/PERFORMANCE.md) | Sync speed tuning, benchmarks |
| [STREAM_RESILIENCE.md](references/STREAM_RESILIENCE.md) | pm2, nohup, retry patterns for production |
| [CLICKHOUSE_ANALYTICS.md](references/CLICKHOUSE_ANALYTICS.md) | Dashboard query patterns |

## Official Docs

- **llms.txt quick reference:** [docs.sqd.dev/llms.txt](https://docs.sqd.dev/llms.txt)
- **Full documentation:** [docs.sqd.dev/llms-full.txt](https://docs.sqd.dev/llms-full.txt)
- **Comprehensive SDK guide:** [docs.sqd.dev/skill.md](https://docs.sqd.dev/skill.md)
- **Available datasets:** [portal.sqd.dev/datasets](https://portal.sqd.dev/datasets)

## Related

- **portal** — query blockchain data across 230+ chains via Portal MCP or the SQD Portal Stream API. Use it to verify contract events, discover dataset names, cross-check indexed data, and decide when a query should become a Pipes/Squid pipeline.
