# BigQuery Target Deep Reference

Reference for running the Pipes SDK BigQuery target in production: GCP prerequisites and IAM, the complete settings surface, blockchain type mapping, fork and crash-recovery semantics, query cost control, and an error lookup keyed on literal error text. The basic config shape and a first example live in [SDK_FEATURES.md](SDK_FEATURES.md#bigquery).

## Contents

- [Version Grounding](#version-grounding)
- [What This Target Is For](#what-this-target-is-for)
- [Prerequisites and Auth](#prerequisites-and-auth)
- [Minimal Working Pipe](#minimal-working-pipe)
- [Settings Surface](#settings-surface)
- [Schema and Type Mapping](#schema-and-type-mapping)
- [Operations](#operations)
- [Querying What You Wrote, Affordably](#querying-what-you-wrote-affordably)
- [Porting from the ClickHouse Target](#porting-from-the-clickhouse-target)
- [Troubleshooting by Error Text](#troubleshooting-by-error-text)
- [Related](#related)

## Version Grounding

Everything below was checked on **2026-11-11** against `@subsquid/pipes@1.0.0-beta.11`: the nine files under `src/targets/bigquery/` in the published tarball, which are identical to the repository at tag `pipes-v1.0.0-beta.11`. On that date npm `latest` was `1.0.0-beta.11` and the npm `beta` tag was `1.0.0-beta.4`; re-read `npm view @subsquid/pipes dist-tags --json` before pinning.

The reference was first written from the beta.6 tarball. Between beta.6 and beta.11 three files changed (`git diff pipes-v1.0.0-beta.6 pipes-v1.0.0-beta.11 -- packages/pipes/src/targets/bigquery`): `bigquery-state.ts` pages fork history in pages of `maxRows`, `bigquery-store.ts` reports stalled appends, transport errors and retried calls through the pipe's logger, and `bigquery-target.ts` hands the store that logger. `tables.ts`, `bigquery-tracker.ts`, `utils.ts`, `index.ts`, `errors.ts` and `integration-helpers.ts` are unchanged.

The upstream `main` branch is at the same version and carries the BigQuery tests next to the source (`bigquery-state.test.ts`, `bigquery-target.test.ts`, `bigquery-target.lifecycle.test.ts` and two integration tests gated behind `BIGQUERY_TEST_PROJECT`).

The published tarball ships `dist`, `src` (tests excluded), `package.json`, `README.md` and `LICENSE`, so it has no examples and no changelog. The repository's BigQuery example is `docs/examples/evm/16.bigquery.example.ts`; one of its comments is wrong for the current code (see [Stale comments in the source](#stale-comments-in-the-source)).

## What This Target Is For

**Append-only.** `store.insert` is the only write path. There is no update, upsert, `MERGE`, or delete-by-key; the only `DELETE` the target issues is the block-range reorg cleanup it manages itself.

`onData` also cannot read back rows it just inserted — `commitBatch()` runs after `onData` returns — so mutable state (balances, positions, open orders, per-key dedupe) cannot be maintained incrementally inside the batch. Model that state as an append-only event log and derive it with SQL: window functions, `QUALIFY ROW_NUMBER()`, scheduled queries, or materialized views over the tracked tables. If your indexer genuinely needs read-modify-write inside the batch, use the ClickHouse or Postgres target instead.

## Prerequisites and Auth

### Packages

Both Google packages are **optional peer dependencies pinned to exact versions** in beta.11, so nothing installs them for you:

```bash
pnpm add @subsquid/pipes@1.0.0-beta.11 \
         @google-cloud/bigquery@8.3.0 \
         @google-cloud/bigquery-storage@5.1.0
```

> **Hold the exact pins.** `bigquery-store.ts` imports its row encoder from a non-public path inside the storage package — `@google-cloud/bigquery-storage/build/src/managedwriter/encoder.js`. A different minor can move that file and break the import at runtime, not at type-check.

### Import specifier

`@subsquid/pipes/targets/bigquery` is the **only** specifier that resolves. The root `@subsquid/pipes` entry re-exports `./core` only, and `package.json` `exports` has no wildcard, so deep paths such as `@subsquid/pipes/targets/bigquery/tables.js` are unresolvable.

Exported (beta.11 `index.ts`): `bigqueryTarget`, `BigQueryWriter`, `BigQuerySyncState`, `BigQueryTableRegistry`, `BIGQUERY_ERROR_CODES`, `BigQueryTargetError`, `ensureTrackedTable`, `partitioningWithDefaults`, `syncTableDdl`, `trackedTableDdl`, plus the types `BigQueryClients`, `BigQuerySettings`, `BigQueryStateOptions`, `PartitioningOptions`, `PartitioningSetting`, `SyncTableLocation`, `TrackedTable`.

Named in public signatures but **not** exported, so you cannot name them in your own types: `CommitTableStats` (the return of `commitBatch()` / `getBufferStats()`), `BigQueryStoreOptions` (third ctor arg of `BigQueryWriter`), `ProtoWriterFactory`, `TrackedTableLocation` (ctor arg of `BigQuerySyncState`), and everything in `utils.ts`. This only bites when hand-constructing the writer or state, or typing a `commitBatch()` result — a pipeline author needs `bigqueryTarget` and `TrackedTable` and nothing else.

`TableField` — the type of every `schema` entry — comes from `@google-cloud/bigquery`, not from pipes.

### Two Google services, two clients

| Client | Service | What the target does with it |
|--------|---------|------------------------------|
| `BigQuery` (REST) — you construct it | `bigquery.googleapis.com` | `CREATE TABLE` for tracked tables and the sync table, `getMetadata` schema validation, all `SELECT`s, all `DELETE` DML |
| `managedwriter.WriterClient` (gRPC) — optional | `bigquerystorage.googleapis.com` | `createWriteStream`, `appendRows` for every data row and every WAL row |

`BigQueryClients` is `{ bigquery: BigQuery; writer?: managedwriter.WriterClient }`. Omit `writer` and the target builds `new managedwriter.WriterClient({ projectId })` itself and closes it in `write()`'s `finally`; supply your own and the target never closes it — that is your job, and it is the cleaner shutdown story (see [What is NOT guaranteed](#what-is-not-guaranteed)). The source is explicit that the REST `apiEndpoint` is **not** forwarded to the writer: for a non-default endpoint you must construct `client.writer` yourself.

Both APIs must be enabled on the project.

`projectId` resolves as `options.projectId ?? client.bigquery.projectId`. If neither is set, construction throws `BigQueryTargetError` **E2201** before any I/O.

### Credentials

The target never touches credentials. It constructs Google clients with a `projectId` and nothing else, so both clients fall through to the Google auth library's Application Default Credentials chain. Credential resolution is Google client-library behaviour; the SDK source asserts nothing about it.

- **Local development:** `gcloud auth application-default login`, then pass only `projectId`.
- **Service-account key file:** set `GOOGLE_APPLICATION_CREDENTIALS` to the JSON key path. Never commit the key; never inline it in the pipe.
- **On GCP compute (GCE, GKE, Cloud Run):** attach a service account and set nothing — the metadata server supplies the token.
- **Custom credentials, endpoint or retry settings:** construct `client.writer` yourself and pass it in, then close it yourself on shutdown.

### Minimum IAM

Derive the permission set from what the target actually calls:

| Target operation | BigQuery surface | Needed because |
|------------------|------------------|----------------|
| `CREATE TABLE IF NOT EXISTS` per tracked table (missing only) and for the sync table | Query job, DDL | Auto-creation and lazy sync-table creation |
| `getMetadata` on each tracked table at startup | Tables read | Schema validation before the first batch |
| `createWriteStream` + `appendRows` on every tracked table and the sync table | Storage Write API | The entire write path |
| `DELETE` DML — fork cleanup, crash recovery, sync retention | Query job, DML | Reorg rollback and WAL trim |
| `SELECT` — sync cursor read, fork paging (`maxRows` rows per page), orphan probes | Query job | Resume and fork resolution |

> **These role names are Google-side, not read from the SDK.** Check them against Google's current BigQuery IAM reference before granting.
>
> The usual minimum is `roles/bigquery.dataEditor` **on the dataset** (create, read, update and delete tables and their data) plus `roles/bigquery.jobUser` **on the project** (permission to run query and DML jobs). `dataEditor` does not let the principal create the dataset itself — that needs a dataset-creation right on the project, which is a one-time operator action anyway.

### The dataset must pre-exist

**Nothing in the target path creates the dataset.** The only `createDataset` call in the whole package is in `src/targets/bigquery/integration-helpers.ts` (test scaffolding). A missing dataset surfaces as a raw BigQuery error from the first `CREATE TABLE`, not as an `E22xx` code.

### Dataset location

The target never sets a `location` on any client, query job, or table — grep the beta.11 BigQuery sources and there is none. Every job therefore inherits the dataset's location, which is fixed at dataset creation and cannot be changed afterwards.

Decide before you create the dataset:

- A query job cannot join datasets in different locations, so the tracked tables, the sync table and anything you later join against must share one location.
- Put the dataset near the indexer process. Every `appendRows` call crosses the network per batch.
- Storage and analysis rates differ by region. Check Google's current BigQuery pricing page for the region you pick.

### Local development and testing

**There is no offline mode.** The write path is the Storage Write API, and the REST `apiEndpoint` is deliberately not forwarded to the writer, so a REST-level emulator does not intercept writes. Every local run appends to a real dataset and bills real Storage Write ingest plus real query jobs for the WAL `SELECT`s and cleanup `DELETE`s. The package's own BigQuery integration tests are gated behind `BIGQUERY_TEST_PROJECT` for the same reason.

Develop against a scratch dataset in a sandbox project with a short table expiration, a small block range, and project- and user-level custom quotas as the spend ceiling — the target sets no `maximumBytesBilled` of its own.

## Minimal Working Pipe

Base config shape: [SDK_FEATURES.md](SDK_FEATURES.md#bigquery). This example adds the operator-side steps the deep reference is about — dataset pre-creation, the BIGNUMERIC clamp, the microsecond timestamp, a rollback hook, and an explicit shutdown path. Every option name and hook signature is checked against `src/targets/bigquery/bigquery-target.ts`.

```typescript
import { BigQuery } from '@google-cloud/bigquery'
import { managedwriter } from '@google-cloud/bigquery-storage'
import { commonAbis, evmEventDecoder, evmPortalStream } from '@subsquid/pipes/evm'
import { type BigQueryWriter, bigqueryTarget } from '@subsquid/pipes/targets/bigquery'

const PROJECT = process.env.BIGQUERY_PROJECT!
const DATASET = process.env.BIGQUERY_DATASET ?? 'eth_transfers'
const LOCATION = process.env.BIGQUERY_LOCATION ?? 'US'   // fixed at dataset creation, never changeable

// See "The uint256 / BIGNUMERIC precision limit". Out-of-range values become NULL rather
// than saturating: a clamped value would silently corrupt every SUM over the column.
const BIGNUMERIC_INT_MAX = 10n ** 38n - 1n
const asBignumeric = (v: bigint) => (v > BIGNUMERIC_INT_MAX ? null : v.toString())

async function main() {
  const bigquery = new BigQuery({ projectId: PROJECT })
  // Own the writer yourself so there is exactly one shutdown path — store.close() below
  // tears down the per-table streams and this client. See "What is NOT guaranteed".
  const writer = new managedwriter.WriterClient({ projectId: PROJECT })
  let store: BigQueryWriter | undefined

  // The target creates TABLES, never the DATASET. This is the operator's one-time call, and
  // it needs bigquery.datasets.create on top of the roles listed under "Minimum IAM".
  // The location is fixed here forever — see "Dataset location" before picking one.
  const [exists] = await bigquery.dataset(DATASET).exists()
  if (!exists) await bigquery.createDataset(DATASET, { location: LOCATION })

  await evmPortalStream({
    id: 'erc20-transfers',                       // this id keys the WAL cursor — renaming it orphans progress
    portal: { url: 'https://portal.sqd.dev/datasets/ethereum-mainnet' },
    outputs: evmEventDecoder({
      range: { from: 21_000_000, to: 21_100_000 },
      events: { transfers: commonAbis.erc20.events.Transfer },
    }),
  }).pipeTo(
    bigqueryTarget({
      client: { bigquery, writer },
      dataset: DATASET,
      tables: [
        {
          table: 'transfers',
          blockNumberColumn: 'block_number',
          schema: [
            { name: 'block_number', type: 'INT64', mode: 'REQUIRED' },
            { name: 'log_index', type: 'INT64', mode: 'REQUIRED' },
            { name: 'block_timestamp', type: 'TIMESTAMP', mode: 'REQUIRED' },
            { name: 'token', type: 'STRING', mode: 'REQUIRED' },
            { name: 'from', type: 'STRING', mode: 'REQUIRED' },
            { name: 'to', type: 'STRING', mode: 'REQUIRED' },
            { name: 'amount', type: 'BIGNUMERIC', mode: 'NULLABLE' },
            { name: 'amount_raw', type: 'STRING', mode: 'REQUIRED' },
          ],
          clusterBy: ['token', 'from'],          // frozen at CREATE TABLE — see [Choosing cluster keys](#choosing-cluster-keys)
        },
      ],
      onStart: async (ctx) => {
        store = ctx.store                        // the only handle you get; needed to close cleanly
      },
      onData: async ({ store, data, ctx }) => {
        ctx.logger.debug(`batch: ${data.transfers.length} transfers`)   // ctx is only { logger, profiler }
        store.insert(
          'transfers',
          data.transfers.map((t) => ({
            block_number: t.block.number,
            log_index: t.rawEvent.logIndex,
            block_timestamp: t.timestamp.getTime() * 1000,              // microseconds — see the TIMESTAMP rule
            token: t.rawEvent.address,
            from: t.event.from,
            to: t.event.to,
            amount: asBignumeric(t.event.value),                          // NULL when out of BIGNUMERIC range
            amount_raw: t.event.value.toString(),
          })),
        )
      },
      onBeforeRollback: async ({ cursor }) => {
        console.log(`reorg -> rolling back to block ${cursor.number}`)
      },
    }),
  )

  store?.close()   // the target never calls this; without it the gRPC streams stay open
}

void main()
```

```bash
BIGQUERY_PROJECT=my-gcp-project BIGQUERY_DATASET=eth_transfers pnpm tsx src/index.ts
```

`bigqueryTarget` returns a core `Target<T>`, so it goes into `.pipeTo(...)` like any other target. It does **not** set `requiresFinalizedStream`, so it reads the hot stream and handles reorgs itself — unlike Parquet (see [SDK_FEATURES.md](SDK_FEATURES.md#finalized-only-target-semantics-beta2)).

## Settings Surface

### `bigqueryTarget(options)` — nine keys, four required

| Key | Type | Required | Default |
|-----|------|----------|---------|
| `client` | `BigQueryClients` = `{ bigquery: BigQuery; writer?: managedwriter.WriterClient }` | yes | — |
| `dataset` | `string` | yes | — (must already exist) |
| `tables` | `TrackedTable[]` | yes | — |
| `onData` | `(ctx: { store: BigQueryWriter; data: T; ctx: HookContext }) => Promise<unknown> \| unknown` | yes | — |
| `projectId` | `string` | no | `client.bigquery.projectId`; E2201 if neither is set |
| `settings` | `BigQuerySettings` | no | `{}` |
| `onStart` | `(ctx: { store: BigQueryWriter; logger: Logger }) => Promise<unknown> \| unknown` | no | — |
| `onBeforeRollback` | `(ctx: { cursor: BlockCursor }) => Promise<unknown> \| unknown` | no | — fires on the fork path only, never on crash recovery |
| `onAfterRollback` | `(ctx: { cursor: BlockCursor }) => Promise<unknown> \| unknown` | no | — fires on the fork path only, never on crash recovery |

`HookContext` is `{ logger: Logger; profiler: Profiler }` — **not** the full batch context. Both rollback hooks receive only `{ cursor }`; there is deliberately no `store`, because the fork path has no commit point.

### `BigQuerySettings` — exactly three optional fields

```typescript
export type BigQuerySettings = {
  state?: Omit<BigQueryStateOptions, 'projectId' | 'dataset'>
  partitioning?: PartitioningSetting
  protoWriterFactory?: ProtoWriterFactory   // type is not exported; internal/testing seam
}
```

| `settings.state` field | Type | Default |
|------------------------|------|---------|
| `table` | `string` | `'sync'` |
| `id` | `string` | the pipe's source `id`, else the legacy `'stream'` key |
| `maxRows` | `number` | `10_000` retained sync rows per id |
| `cleanupEverySaves` | `number` | `25`. The counter is a per-**process** field, never persisted, so cleanup also runs on the first commit after *every* start — a crash-looping pipe issues a sync-table `DELETE` on each restart |

`projectId` and `dataset` are `Omit`-ed — they come from the target options.

> **Neither `maxRows` nor `cleanupEverySaves` is validated**, unlike the ClickHouse target, which rejects `maxRows <= 0` with E2001. `maxRows: 0` makes the cleanup subquery `LIMIT 0`, so `MIN(timestamp)` is NULL and the `DELETE` matches nothing; `cleanupEverySaves: 0` makes `saves % 0` NaN, so cleanup runs only on the first save. Either silently disables retention, the sync table grows without bound, and the only symptom is a startup that gets slower. Use positive integers.

| `settings.partitioning` | Effect |
|-------------------------|--------|
| omitted | `bucketSize: 10_000`, `maxBlocks: 100_000_000` |
| `{ bucketSize?, maxBlocks? }` | each field defaults independently |
| `false` | drops `PARTITION BY`, **also drops `CLUSTER BY`**, and skips the range-partition assertion on existing tables. The partition column is still forced to `INT64 NOT NULL`. |

> **`partitioning: false` is a production footgun.** Every fork `DELETE` and every crash-recovery `DELETE` then scans the whole table. The target's own source calls this out as the reason partitioning exists.

### `TrackedTable`

```typescript
export type TrackedTable = {
  table: string               // unqualified name; the target builds `${projectId}.${dataset}.${table}`
  blockNumberColumn: string   // declare it in schema (only auto-create checks); forced to INT64 REQUIRED
  schema: TableField[]        // TableField from @google-cloud/bigquery
  clusterBy?: string[]        // emitted verbatim, in your order, only when partitioning is on
}
```

### `store` (`BigQueryWriter`) — what a pipeline author uses

`store.insert(table, rows)` is the write path. It is **synchronous**, buffers into an in-memory `Map` keyed by table, and throws **E2209** immediately — before any RPC — for a table not listed in `tables[]`. `Row` is `{ [key: string]: unknown }`.

`commitBatch()`, `commitSyncRow()`, `getBufferStats()` and `resetBuffer()` are driven by the target; calling them from `onData` corrupts the WAL bracket.

`query<T>(sql, params)` and `executeDml(sql, params)` are safe to call yourself. Both are plain retried BigQuery jobs that touch neither the buffer nor the WAL — use `query()` from `onStart` for one-time DDL on derived tables or views (there is no `executeFiles`-style SQL-file bootstrap as in the ClickHouse target) and for lookup reads. Any DML you issue yourself against a tracked table is invisible to the WAL and will not be replayed or undone.

`close()` is never called by the target — see [What is NOT guaranteed](#what-is-not-guaranteed) — so it is yours to call on shutdown.

## Schema and Type Mapping

### Blockchain value to BigQuery column

| Value | Column type | What to pass in `onData` |
|-------|-------------|--------------------------|
| Block / slot number | `INT64` `REQUIRED` | `t.block.number` — forced to this type and mode regardless of what you declare |
| Block timestamp | `TIMESTAMP` `REQUIRED` | see [The TIMESTAMP microseconds rule](#the-timestamp-microseconds-rule) |
| Log index, tx index, small counters | `INT64` | the number directly |
| Address, tx hash, topic | `STRING` | normalize case once, before writing (see below) |
| `uint256` / `int256` exact value | `STRING` `REQUIRED` | `value.toString()` — the only lossless option |
| `uint256` for arithmetic | `BIGNUMERIC` `NULLABLE` | clamped decimal string; keep the exact value in the STRING column |
| `uint64` above `2^63-1` | `STRING` | `INT64` is signed 64-bit and overflows |
| `uint32` and smaller | `INT64` | fits with room to spare |
| `bool` | `BOOL` | `true` / `false` |
| Arrays | `REPEATED` | **rejected by auto-creation (E2206)** — pre-create the table by hand |
| Structs | `RECORD` / `STRUCT` | **rejected by auto-creation (E2206)** — pre-create the table by hand |

The E2206 check lives inside the DDL generator, so it only fires on the auto-create branch. A manually pre-created table with `ARRAY<...>` or `STRUCT<...>` columns reaches the validation path instead and **passes validation** on every subsequent run — that is all the escape hatch buys. The write path is unchanged: the proto descriptor is still built from your declared `TableField[]`, and the source's own comment says the DDL generator and `assertSchemaMatches` handle flat scalar fields only. Prove one real batch through before relying on it.

### The TIMESTAMP microseconds rule

A `TIMESTAMP` column is an INT64 proto field on the wire, in **microseconds since epoch**. The target itself writes its sync-table `timestamp` that way — `nowMicros()` returns `Date.now() * 1000 + counter` and hands it to the same encoder every data row goes through — so the convention is the SDK's own production path, not an inference.

Two forms are known to work:

- `date.getTime() * 1000` — an explicit microsecond integer. This is what the SDK does internally; prefer it.
- A JS `Date` object. The SDK's own gated integration test round-trips `new Date(Date.UTC(2026, 4, 9, 12, 34, 56, 789))` through a `TIMESTAMP` column and reads back `2026-05-09T12:34:56.789Z`.

What is not safe is a raw **milliseconds** number: it is taken as microseconds and lands every row in 1970. No test or source path exercises an ISO 8601 string, so do not rely on one.

### The uint256 / BIGNUMERIC precision limit

[SDK_FEATURES.md](SDK_FEATURES.md#bigquery) states the rule. The arithmetic behind it: `BIGNUMERIC` defaults to precision 76.76, scale 38, so the maximum value is roughly `5.79e38`. `2^256-1` is roughly `1.16e77` and overflows — ERC-20 "infinite approval" sentinels hit this constantly. The `10^38 - 1` threshold in the example is a conservative round number (38 integer digits), not the exact ceiling.

Use two columns:

```
amount      BIGNUMERIC NULLABLE  -> asBignumeric(value)   // NULL when out of range
amount_raw  STRING     REQUIRED  -> value.toString()      // exact, lossless, the source of truth
```

**Do not clamp an out-of-range value to the maximum.** Saturating makes distinct
values compare equal and silently inflates every `SUM` over the column, and
nothing downstream can tell a real maximum from a clamped one. Writing `NULL`
instead keeps the column honest: `SUM` skips NULLs, so an overflow can be
detected rather than absorbed.

Because `SUM` skips them silently, check for overflow before trusting a total:

```sql
SELECT COUNTIF(amount IS NULL) AS unrepresentable, COUNT(*) AS rows
FROM `proj.ds.transfers`
WHERE block_number BETWEEN @from_block AND @to_block
```

If that count is non-zero, aggregate from `amount_raw` instead — it is exact —
and accept the cast cost, or exclude the sentinel rows deliberately. ERC-20
"infinite approval" values are the usual source and are rarely economically
meaningful, but that is a judgement for the query to make explicitly, not for
the write path to make silently. This mirrors the ClickHouse rule of storing
`uint256` as `String` — see [SCHEMA_GUIDE.md](SCHEMA_GUIDE.md#solidity-type--clickhouse-type-mapping).

### Choosing the partition column

There is exactly one choice: which INT64 column carries the block height. The generated DDL is always integer range partitioning on that column:

```sql
PARTITION BY RANGE_BUCKET(`block_number`, GENERATE_ARRAY(0, 100000000, 10000))
```

There is no time-partitioning code path in beta.11. The column is rewritten to `INT64 NOT NULL` in both the DDL and the proto descriptor. The `NOT NULL` is load-bearing: SQL three-valued logic means a `NULL` block number never matches the fork `DELETE` predicate, so such a row would survive every reorg cleanup forever.

> **Only the auto-create branch checks that the column is in your `schema`.** `assertSchemaIncludesPartitionColumn` runs inside `trackedTableDdl`, which is reached only on the `getMetadata` 404. Against a table that already exists — the normal case after the first deploy — a `blockNumberColumn` missing from `schema` passes every startup check: the partition and INT64/NOT-NULL assertions read the *live* table, and `assertSchemaMatches` iterates only the columns you declared. The proto descriptor is then built without that column and every batch fails at the first commit, after the WAL pre-commit row is already durable — as **E2213** when BigQuery reports the rejection per row, otherwise as a raw proto-descriptor error carrying no `E22xx` code. Declare it.

**Tune `bucketSize` per chain, because it is measured in blocks, not time.** 10_000 blocks is roughly 1.4 days at 12-second blocks, about 42 minutes on a 250 ms L2, and about 69 days on Bitcoin. Size a bucket to hold days of blocks rather than minutes: prefer hundreds of partitions to tens of thousands.

> **The default `maxBlocks` of 100_000_000 is a real ceiling.** Rows whose block number lands outside `[0, maxBlocks)` get no bucket and are routed to a single catch-all partition, so pruning stops working for them — every query and every fork `DELETE` walks that one partition. Solana slot heights are already well past 100_000_000. Raise `maxBlocks` at table-creation time for any chain that can exceed it, and raise `bucketSize` proportionally so `maxBlocks / bucketSize` stays under BigQuery's per-table integer-range partition cap. The default lands on exactly 10_000 buckets, which is at or near that cap — confirm the current figure on Google's quotas page before raising `maxBlocks`.

### Choosing cluster keys

BigQuery clusters on up to four columns, prefix-ordered. Within these tables:

- **Do not spend a slot on the block or timestamp column.** Partitioning already sorts by height at `bucketSize` granularity; clustering should sort *within* a bucket by something else.
- **Address-shaped columns are the right keys** — high cardinality, always filtered by equality.
- **Order by which column your queries always constrain**, not by cardinality. "All transfers of token X" puts `token` first; "everything this wallet did" puts the address column first.
- **Normalize address representation before writing.** Clustering sorts on the stored value, so mixed-case spellings of one address fragment the sort order and quietly defeat block pruning. The target normalizes nothing — your declared schema and your row values pass straight through.
- **Two genuinely different dominant access patterns need a second table**, not a longer cluster list. A fourth cluster column does almost nothing for a query that does not constrain the first three.

> **Cluster keys and bucket geometry are write-once, and nothing validates them.** DDL is emitted only on the `getMetadata` 404 branch, so editing `clusterBy` or `bucketSize` after the table exists changes nothing on disk. Validation checks the partition *field name*, the partition column's type and mode, and every declared field's type and mode — it never looks at clustering, and never compares bucket start/end/interval. A config claiming `clusterBy: ['token','from']` against a table clustered on nothing starts up perfectly clean and hands you the read costs of whatever is really there. **`INFORMATION_SCHEMA.TABLES.ddl` is the source of truth, not your config** — see [Verification and consistency queries](#verification-and-consistency-queries).

## Operations

### What auto-creates, what must pre-exist

| Object | Created by the target? | When |
|--------|------------------------|------|
| Dataset | **No** | Operator's one-time call. Missing dataset = raw BigQuery error, no `E22xx` |
| Tracked tables | Yes, if missing | At the very start of `write()`, before `onStart` and before `getCursor`, one at a time in declaration order |
| Sync (WAL) table | Yes, if missing | Lazily, on the first `getCursor()` whose `SELECT` returns Not Found. **Never validated when it already exists** |
| Any schema change to an existing table | **No** | There is no `ALTER TABLE` path anywhere |

Startup order is fixed: validate/create tracked tables → `onStart` → `getCursor` (which runs crash recovery) → first batch.

### Schema validation against an existing table

Checks run in this order and each throws at startup rather than migrating:

1. Range-partitioned on the declared column — **E2205** (skipped entirely when `partitioning: false`).
2. Partition column exists in the **live** table — **E2202**.
3. Partition column is `INT64` — **E2203**.
4. Partition column is `REQUIRED` — **E2204**.
5. Every declared field present — **E2207**.
6. Declared field type matches — **E2208**. Legacy-SQL aliases are canonicalized, so `INTEGER`/`INT64`, `FLOAT`/`FLOAT64` and `BOOLEAN`/`BOOL` compare equal.
7. Declared field mode matches — **E2208**. Missing mode normalizes to `NULLABLE` on both sides.

Steps 2 through 4 are one assertion, so they fire in that order. E2202 has two
throw sites: this one reads the live table, and a second checks your declared
`schema` on the auto-create path only.

Extra columns in the live table pass **validation**, but they are not in the proto descriptor, which is built from your declaration alone, and the target passes no `missingValueInterpretations`. A `NULLABLE` extra column is harmless. A `REQUIRED` extra column with no `DEFAULT` receives no value and BigQuery rejects every row, on the first commit and every commit after it — as E2213 when the rejection is reported per row, otherwise as a schema-level error with no `E22xx` code. If you `ALTER TABLE ADD COLUMN` by hand, add it as `NULLABLE` or with a `DEFAULT` unless you also add it to `tables[].schema`.

Drift in the other direction is loud: adding a column to `tables[].schema` after the table exists throws E2207, and you must run the `ALTER TABLE` by hand.

### Resume and state

The sync table is the only framework-managed table. Nine flat columns, deliberately unpartitioned and unclustered:

```sql
CREATE TABLE IF NOT EXISTS `proj.ds.sync` (
  `id`              STRING NOT NULL,
  `op`              STRING NOT NULL,
  `current`         STRING,          -- JSON-encoded cursor, not a BigQuery JSON column
  `finalized`       STRING,
  `rollback_chain`  STRING NOT NULL,
  `range_low`       INT64,
  `range_high`      INT64,
  `committed`       BOOL NOT NULL,
  `timestamp`       TIMESTAMP DEFAULT CURRENT_TIMESTAMP() NOT NULL
);
```

**Unlike tracked tables, the sync table is never schema-checked.** It is created only when the `SELECT` returns Not Found; when it exists, nothing compares it against anything. If a table with this name already exists in a different shape — an older SDK's layout, a hand-created table, an added `REQUIRED` column — the first `saveCommitPre` fails — as **E2213** naming the sync table's full path when BigQuery reports the rejection per row, or as a raw proto-descriptor error carrying no `E22xx` code when the append is rejected at the channel level. Before upgrading or renaming `settings.state.table`, compare the live table against the DDL above: `id`, `op`, `rollback_chain`, `committed` and `timestamp` REQUIRED; `current`, `finalized`, `range_low` and `range_high` NULLABLE.

Four WAL states are encoded as `(op, committed)` pairs: `(commit,false)` IN_FLIGHT_COMMIT, `(commit,true)` COMMITTED, `(rollback,false)` IN_FLIGHT_ROLLBACK, `(rollback,true)` ROLLED_BACK. `range_low`/`range_high` are set only on the in-flight rows.

**Cursor key.** `write()` calls `state.bindCursorKey(id)` before anything else: an explicit `settings.state.id` always wins, otherwise the pipe's source `id`, otherwise the legacy `'stream'` constant. **Unlike ClickHouse, the BigQuery target has no legacy-cursor migration** — see [SDK_FEATURES.md](SDK_FEATURES.md#cursor-keying--upgrading-to-alpha15) for the general rule. A deployment carrying WAL rows under the old `'stream'` key that starts under a new key does not silently replay: the orphan guard fires first and the pipe refuses to start with **E2212**, because the tracked tables still hold data. Pin `settings: { state: { id: 'stream' } }` to adopt the old rows. Silent replay from the initial cursor is only possible when the tracked tables happen to be empty too.

**One sync table can serve many pipes.** Every sync read, WAL write and cleanup filters on the cursor key, so distinct ids never see or evict each other's rows. What cannot be shared is a *tracked* table. `settings.state.table` is part of the progress identity just like the id: pointing an existing pipe at a different sync table looks like a fresh run and trips E2212 against its non-empty tracked tables.

**Resume reads exactly one row:** `SELECT * FROM sync WHERE id = @id ORDER BY timestamp DESC LIMIT 1`. That `timestamp` is a **client wall-clock** value generated per process (`nowMicros()`), monotonic only within one process, despite the DDL declaring a server-side default.

**Orphan refusal (E2212).** If the sync table has no rows for this id but any tracked table still holds data, the target refuses to start rather than replaying from the initial cursor and duplicating everything. To deliberately reset: truncate or drop the tracked tables as well as clearing the sync rows. The error message lists the exact FQNs.

### The per-batch WAL bracket

There is no cross-table atomic flush in BigQuery, so atomicity is emulated:

```text
saveCommitPre (IN_FLIGHT_COMMIT + block range)
  -> onData        (store.insert buffers in memory; nothing is sent)
  -> getBufferStats (encodes + caches rows, feeds the in-flight log line)
  -> commitBatch   (parallel AppendRows per table; the ONLY flush)
  -> saveCommitPost (COMMITTED)
  -> metrics observed
```

`commitBatch()` is called exactly once per batch, by the target, after `onData` returns. **There is no size trigger, no time trigger, and no auto-flush inside `onData`.** The in-flight range low bound is `previousCursor.number + 1`, or `ctx.stream.state.initial` on the very first batch — never a hardcoded 0.

**The whole batch is held in memory, twice.** `store.insert` retains the raw row objects, and `getBufferStats()` — which the target calls on every batch before the commit — proto-encodes the whole batch and caches the encoded bytes; both live until `commitBatch()` resolves. The 16 MiB chunking bounds the size of each `AppendRows` request, not the resident buffer, and there is no early-flush API. Peak heap scales with the largest batch the source hands you, roughly doubled, across all tracked tables — so bound batch size in the stream config and size the container for it. This is the failure mode of a wide-range backfill, and it has no target-side warning.

Rows go through the Storage Write API on **long-lived Committed streams**, one per table FQN, created lazily and cached for the process lifetime. There is no `finalize` and no `BatchCommitWriteStreams` — **rows are visible to SQL the moment `AppendRows` acks**, which is before the COMMITTED marker exists.

### Fork and rollback

```typescript
state.fork()                       // resolve the safe cursor; null -> return immediately, no hooks fire
saveRollbackPre({ range: { low: safeCursor.number + 1, high: upper } })   // durable IN_FLIGHT_ROLLBACK
onBeforeRollback({ cursor })       // safe cursor only, no store
tracker.fork(safe, upper)          // per-table parallel DELETEs
saveRollbackPost()                 // ROLLED_BACK
onAfterRollback({ cursor })
```

The entire reorg rewrite is one bounded `DELETE` per tracked table, dispatched in parallel. Nothing is upserted or rewritten:

```sql
DELETE FROM `proj.ds.transfers`
WHERE `block_number` > @safe AND `block_number` <= @upper
```

Both bounds are mandatory so BigQuery can statically prune partitions; without the upper bound the `DELETE` scans every partition above `@safe`.

Before writing a rollback hook:

- **Every row's `blockNumberColumn` value must fall inside the batch's block range.** Both cleanup paths are pure range predicates on that column, and the range comes from the cursor, never from the rows — `insert()` validates the table name only and never inspects row contents. A row written with a block number outside the batch being committed — a rolled-up aggregate pinned to a fixed height, a `0` sentinel, a per-entity "latest state" row — is invisible to every fork `DELETE` and every recovery `DELETE`, survives all of them, and is written again on the next restart. The same applies to anything `onStart` inserts: those rows flush inside the first batch's commit and inherit its range.
- **`onBeforeRollback` cannot veto the rollback.** It runs *after* the IN_FLIGHT_ROLLBACK row is durable. If it throws, the `DELETE`s do not run in this process — but the next `getCursor()` executes exactly that range anyway.
- **The sync table is not rewritten on a fork.** Two new rows are appended; prior COMMITTED rows above the safe cursor stay.
- **Both rollback WAL rows persist `finalized: undefined` and an empty `rollbackChain`.** A restart immediately after a reorg resumes with `finalized: null`; the source rebuilds its watermark from the Portal, so this is not corruption, but the persisted finalized floor is lost. **The empty chain also makes rollback and recovery rows inert for fork resolution** — `resolveForkCursor` skips any record with an empty `rollbackChain`, so a second fork resolves only against older COMMITTED rows, whose chains may describe blocks the first rollback already deleted. Effective fork depth is the retained COMMITTED history, not the retained row count.
- **`upper` is `max(canonicalBlocks[].number)`.** If it is below the persisted cursor the target throws `PortalContractViolationError` (E1004) rather than deleting a partial range.
- **Fork depth is bounded by retained sync history and by the finalized floor.** Fork resolution reads every committed row for the id, newest-first, in pages of `maxRows`; `cleanupOldRows` keeps only `maxRows` (default 10_000) per id, so a fork normally costs one query. The search never goes below the highest finalized block those rows persisted, because finalized data is not rolled back. A fork deeper than either bound resolves to `null` and the pipe dies with `ForkCursorMissingError` (E1003) — a retention problem that presents as a fork bug, and one that needs a [manual rewind](#manual-rewind) to clear.

### Crash recovery

A crash leaves the newest sync row in an IN_FLIGHT state, and the next `getCursor()` repairs it before resuming:

| Latest row | Recovery action | Cursor returned |
|------------|-----------------|-----------------|
| IN_FLIGHT_COMMIT | `DELETE` `[range_low, range_high]` from every tracked table, write a rollback marker | the **pre-batch** cursor |
| IN_FLIGHT_ROLLBACK | re-run the identical bounded `DELETE` (idempotent), write a completed rollback marker | the safe block from the row's `current` |
| COMMITTED / ROLLED_BACK | none | the stored cursor |

The recovery `DELETE` uses **inclusive bounds on both ends** (`>= @low AND <= @high`), unlike the fork `DELETE` which is exclusive at the low end. The recovery marker deliberately writes an **empty** `rollback_chain` so phantom blocks cannot be treated as valid ancestors during a later deep fork.

**Neither rollback hook fires during crash recovery.** `onBeforeRollback` and `onAfterRollback` run only on the fork path, inside `resolveFork`. The recovery `DELETE` is issued inside `getCursor()` with no hook, no metric, and no log line beyond the `Crash recovery (id=…)` warning. Anything your rollback hook does — cleaning a derived table, invalidating a cache, notifying downstream — will not happen after a crash. The only cleanup that runs on both paths is the bounded `DELETE` on the tables listed in `tables[]`, so every table whose rows are block-attributable must be listed there, including aggregate tables you write from `onData`.

**A crash mid-rollback is safe; a corrupt in-flight row is not.** If `range_low`/`range_high` are NULL the target throws **E2211** and tells you to inspect the sync table by hand.

> **This recovery DELETE — not the stream offsets — is what prevents duplicates across a restart.** Every process opens a new Committed stream at `nextOffset: 0`, so offsets carry no meaning across restarts. Within a process a failed chunk is re-sent at the same offset and the code *relies on* BigQuery deduping it: the SDK asserts that in a comment, nothing verifies it, and `isTransientError` does not include gRPC 6 `ALREADY_EXISTS`, so if the server rejects the duplicate offset instead of deduping, the retry is classified fatal and the pipe stops. Treat in-process retries as best-effort with a fatal failure mode, not as proven exactly-once. If the recovery `DELETE` itself fails (permissions, quota, a cost limit) the target throws and the tracked tables keep the partial write until a retry succeeds.

### Manual rewind

The one incident this target cannot resolve on its own is a fork that resolves to `null`: `resolveFork` returns before writing any WAL row and before any `DELETE`, the source throws `ForkCursorMissingError` (E1003), and the newest sync row is still COMMITTED at a cursor on the abandoned chain while the forked rows sit in the tracked tables. Every restart resumes from that cursor, gets the same fork response, and dies again. Raising `maxRows` prevents a recurrence; it does not clear the live incident.

With the pipe stopped:

1. Pick a safe block `N` at or below the last block both chains agree on.
2. Delete everything above it from every tracked table, with both bounds so partitions prune:
   ```sql
   DELETE FROM `proj.ds.transfers` WHERE `block_number` > 21050000 AND `block_number` <= 21050400;
   ```
3. Append one sync row that becomes the newest for this id. `current` is a JSON-encoded `BlockCursor` = `{ number, hash?, timestamp? }`; the `hash` must be the real canonical hash at `N`, because the source validates the resume cursor against the Portal.
   ```sql
   INSERT INTO `proj.ds.sync`
     (`id`, `op`, `current`, `finalized`, `rollback_chain`, `range_low`, `range_high`, `committed`, `timestamp`)
   VALUES
     ('erc20-transfers', 'rollback', '{"number":21050000,"hash":"0x…"}', NULL, '[]',
      NULL, NULL, TRUE, CURRENT_TIMESTAMP());
   ```
   `rollback_chain` must be `'[]'`, `committed` must be `TRUE`, and the row wins only if its `timestamp` is the largest for that id.
4. Restart the pipe.

### Retry policy

| Retried — 9 attempts (1 initial + `retries: 8`), 250 ms doubled per attempt with ±50 % jitter, ~64 s of backoff on average (~32 s best case, ~96 s worst) | Not retried at all |
|-----------------------------------------------------------------------------------------------------------------------------------------------------------|--------------------|
| `createWriteStream` | `createStreamConnection` |
| `appendRows` | `job.getQueryResults()` (only job *creation* is retried) |
| `createQueryJob` (all DML) | the sync-table `CREATE` |
| `query` (all SELECTs) | both `ensureTrackedTable` calls (`getMetadata` and the `CREATE`) |

Transient means gRPC 4 (DEADLINE_EXCEEDED), 8 (RESOURCE_EXHAUSTED), 10 (ABORTED), 13 (INTERNAL), 14 (UNAVAILABLE), or HTTP 429/500/502/503/504 — found **anywhere in the cause chain**.

Fatal and pipe-stopping: every `E2201`–`E2213`, plus `INVALID_ARGUMENT` / `NOT_FOUND` / schema mismatch from the API. **A fatal error on the commit path is a crash loop, not a one-off.** The batch never reaches COMMITTED, so every restart re-runs the recovery `DELETE`, re-fetches the same blocks and fails identically. Stop the supervisor and fix the schema or the row values; restarting cannot clear it. Each restart also opens a new Committed write stream per tracked table — streams are never finalized and the target never calls `close()` — so a loop left running burns write-stream quota and can escalate a schema bug into `RESOURCE_EXHAUSTED` on the same tables.

Non-fatal by design: `cleanupOldRows` failures are logged as a warning and swallowed; a transient gRPC error that the storage client delivers a second time as a connection `'error'` event is caught by a listener so it cannot kill the process. The listener logs it as the warning `write stream for <table> reported a transport error`; the client reconnects on the next `appendRows` attempt.

A retried call that then succeeds logs one warning, `<call> succeeded after N retries`, where `<call>` is `appendRows(<table>, offset=<n>)`, `createWriteStream(<table>)`, `createQueryJob` or `query`. A call that exhausts the budget logs nothing there and throws.

**Close failures are not swallowed on the path that runs.** The best-effort try/catch around `writer.close()` and `connection.close()` lives in `BigQueryWriter.close()`, which the target never calls. The target's own `finally` calls `writer.close()` on the `WriterClient` unguarded, so a throw there propagates and — being in a `finally` — replaces the error that actually ended the write loop.

### Observability

| Signal | Name | Notes |
|--------|------|-------|
| Metric | `sqd_bigquery_commit_duration_seconds` | Times only the parallel `AppendRows` phase, not the WAL bracket |
| Metric | `sqd_bigquery_block_to_commit_lag_seconds` | The block timestamp is normalized first; an unusable one is skipped, not observed as garbage |
| Metric | `sqd_bigquery_append_errors_total{kind}` | `kind` is one of `not_found`, `invalid_argument`, `resource_exhausted`, `transient`, `unknown`. Counts WAL pre-commit, data commit and WAL post-commit errors; `onData` throws are excluded as user-code errors |
| Log (info) | `committed batch: N rows / X across K tables, blocks A → B` | Proto-encoded row bytes — see [What the target's own writes cost](#what-the-targets-own-writes-cost) before treating it as a billing figure |
| Log (debug) | `in-flight batch: …` | Emitted before the commit |
| Log (warn) | `Crash recovery (id=…): previous run left an unfinished write/rollback` | The recovery path fired |
| Log (warn) | `Sync cleanup failed (non-fatal)` | Retention is not running; the sync table is growing |
| Log (warn) | `appendRows(<table>, offset=<n>) has not returned after 15s` | One append attempt has been in flight for 15 s. The gRPC stream was probably dropped without an error; `getResult()` has no deadline of its own. Followed by `appendRows(…) returned after <duration>` (info) if it completes |
| Log (warn) | `write stream for <table> reported a transport error` | The connection emitted an `'error'` event. Not fatal on its own |
| Log (warn) | `<call> succeeded after N retries` | A transient error was retried and cleared. Repeated lines point at quota or network pressure |
| Log (warn) | `stalled: processing blocks A → B for <duration>` | The pipe-level watchdog (120 s) covering `onData` and the commit; see [STREAM_RESILIENCE.md](STREAM_RESILIENCE.md#stalled-responses-and-the-stall-watchdog) |

**Reorgs are not instrumented.** There is no fork metric and no fork log line: `tracker.fork()` returns per-table deleted-row counts and the target discards them. `sqd_bigquery_append_errors_total` wraps only the WAL pre-commit, the data commit and the WAL post-commit, so a failing fork `DELETE` or recovery `DELETE` increments nothing. The only in-band evidence that a reorg occurred is your own `onBeforeRollback` hook on the fork path, or the `Crash recovery (id=…)` warning on the recovery path. Log the cursor in `onBeforeRollback` if you want a reorg record, and alert on process exits rather than on a fork counter.

### What is NOT guaranteed

- **No concurrency control.** There is no lock, lease, or fencing token anywhere. Two processes on the same cursor key interleave WAL rows, and `ORDER BY timestamp DESC` over client-generated timestamps picks an arbitrary winner. The single-writer invariant is assumed, never enforced.
- **No read consistency for downstream consumers.** Rows are visible the instant `AppendRows` acks — before the COMMITTED marker, and after a crash until the next start's recovery `DELETE`. There is no marker, view, or watermark column to filter on. Consumers must join against the sync table themselves or tolerate dirty reads.
- **Tracked tables cannot be shared between pipes.** Both the fork `DELETE` and the recovery `DELETE` are scoped by block-number range only, with no pipe-id predicate. Two pipes writing the same table delete each other's rows on any reorg or crash recovery. The allowlist enforces only the reverse direction.
- **No dataset lifecycle management.** Never created, never checked.
- **No schema evolution.** No `ALTER TABLE` path at all.
- **No cross-restart AppendRows dedupe, and no verified in-process dedupe.** The `bigquery-target.ts` docblock states exactly-once as design intent; the code re-sends the same offset and does not check for or retry an already-exists response. Covered above.
- **The DML-on-freshly-streamed-rows claim is the SDK's design intent, not a verified property.** The source asserts that a 2025 BigQuery GA closed the historic 30–90 minute DML lockout on recently streamed rows. The code neither verifies this nor degrades gracefully. If DML on recent rows is blocked in your project or region, the fork `DELETE` fails and the whole reorg path stops. The only evidence is an integration test gated behind `BIGQUERY_TEST_PROJECT`.
- **`BigQueryWriter.close()` is never called by the target.** Only an internally-constructed `WriterClient` is closed, in `write()`'s `finally`; the per-table stream connections that `close()` tears down are left open. ClickHouse and Parquet targets do call `store.close()`; BigQuery does not. After a bounded range completes, or on SIGTERM, those gRPC connections stay open and the Node process may not exit — which reads as "the pipe is stuck" to whoever is watching. There is no `onEnd` hook either. Capture the `store` handle in `onStart`, pass your own `client.writer` so the target does not also close it, and call `store.close()` from your shutdown path and after `pipeTo(...)` resolves.

### Stale comments in the source

Do not quote these as behaviour:

- `tables.ts` says the sync `timestamp` is assigned server-side, and `bigquery-state.ts`'s `#streamRollbackRecords` justifies its paging cutoff the same way. Both are wrong: the value comes from `nowMicros()` on the client.
- `bigquery-state.ts` references a 7-day partition expiration on the sync table. The DDL emits no `PARTITION BY` and no `OPTIONS`, so no such expiration exists. `cleanupOldRows` + `maxRows` is the only bound, and it swallows its own failures.
- `bigquery-store.ts` says the sync table's writer options are always `{ timestamp: 'DEFAULT_VALUE' }`. `commitSyncRow` passes none.
- `bigquery-store.ts`'s `commitBatch` comment lists `finalize` and `batchCommitWriteStream` among the per-table operations. Neither is ever called.
- `bigquery-state.ts` says `getCursor` may run before `onStart`. In this target it never does.
- `bigquery-store.ts` states three different `AppendRows` size limits (10 MB, 16 MiB, 20 MB). **16 MiB is the one actually enforced.**
- `bigquery-store.ts` puts the retry budget at "~30 s". The loop runs 9 attempts with 8 exponential sleeps — ~64 s on average, up to ~96 s. See [Retry policy](#retry-policy).
- `tables.ts` carries a hardcoded "$5+ per call" figure for an unpartitioned fork `DELETE`. The direction is right; the number is not current pricing.
- The repo example `docs/examples/evm/16.bigquery.example.ts` says batches commit "via Pending streams". The target uses **Committed** streams.

## Querying What You Wrote, Affordably

### What prunes, and what only looks like it does

**Prunes partitions:** a bound on the block-number column itself, from a literal or a scalar query parameter — `BETWEEN a AND b`, `>= a AND < b`, `= n`, `IN (n1, n2)`. The partitioning expression is over the raw column, so there is no pseudo-column to learn.

**Does not prune:**

```sql
-- 1. time predicate: block_timestamp is NOT the partition column -> zero pruning
WHERE block_timestamp >= TIMESTAMP('2026-01-01')

-- 2. subquery bound: not statically evaluable -> zero pruning
WHERE block_number > (SELECT MAX(block_number) FROM `proj.ds.checkpoints`)

-- 3. wrapped column -> zero pruning
WHERE CAST(block_number AS STRING) LIKE '21%'

-- 4. one-sided bound: prunes below, leaves EVERY bucket above in scope
WHERE block_number > 21000000

-- 5. OR across cluster columns: defeats block pruning; use UNION ALL of two clustered reads
WHERE `from` = '0xd8da...' OR `to` = '0xd8da...'
```

The time predicate is the single most expensive mistake against these tables, because time is how analysts naturally think and the correlation with block height is invisible to the planner. Cluster columns prune *blocks*, a separate best-effort mechanism that a dry run does not account for.

### The shape to copy

```sql
SELECT block_number, token, `from`, amount           -- name columns, never *
FROM `proj.ds.transfers`
WHERE block_number BETWEEN @from_block AND @to_block -- prunes PARTITIONS
  AND token = '0xa0b8...'                            -- prunes BLOCKS (cluster col 1)
  AND `from` = '0xd8da...'                           -- prunes further (cluster col 2)
```

1. **Every query carries an explicit two-sided block range**, even for "small" lookups.
2. **Never `SELECT *`.** These tables are columnar and the fat columns are the strings — `amount_raw`, tx hashes, addresses. Three INT64s cost a fraction of the whole row.
3. **Resolve a time window to a block range in a separate query**, then inline the literal. Keep a small `blocks(block_number, block_timestamp)` tracked table clustered on the timestamp, or run one bounded `MIN(block_number)` query. Inlining that lookup as a subquery destroys pruning.
4. **Cluster filters must be equality or `IN` on the leading columns, in declared order.** Filtering only on the second cluster column buys much less than filtering on the first.

### Cost mechanics

Look up every rate, free-tier size and quota on Google's current BigQuery pricing and quotas pages — they change. The mechanics do not:

- **Bytes billed is roughly (size of the columns you reference) × (the partitions and blocks not pruned).** Columns you never name cost nothing, which is why column discipline and partition pruning multiply rather than add.
- **`LIMIT` does not reduce cost.** BigQuery reads the partitions, then discards rows. The target's own startup `SELECT * FROM sync WHERE id=@id ORDER BY timestamp DESC LIMIT 1` reads all nine columns of **every row in the sync table** — it is unpartitioned and unclustered, so the `id` predicate prunes nothing. The sync table defaults to one per dataset, so pipes sharing a dataset share it and each one's startup read scans the others' rows; retention is per id, so the real size is (number of pipes) × `maxRows`.
- **A bare `WHERE` does not reduce cost either**, unless it prunes partitions or clustered blocks.
- **A dry run prices a query for free.** It returns `totalBytesProcessed` without running or billing. Make it the reflex before every exploratory query. Two caveats: it ignores clustering, so real cost can come in lower, and it ignores cache hits.
- **`maximum_bytes_billed` is the only hard stop.** A query that would exceed it fails and is not charged. Everything else is advisory. Add per-project and per-user daily custom on-demand quotas as the second layer.
- **Storage bills separately and continuously.** A partition untouched for a sustained window drops to the long-term storage rate. Append-only chain history suits this well, and this target's forks only touch head partitions, so the benefit holds.
- **On capacity/editions pricing, bytes scanned is not billed directly** — slot-time is. Pruning still matters because it is the same work, but dry runs and `maximum_bytes_billed` stop being your cost control.

```bash
# price any query for free before running it
bq query --dry_run --use_legacy_sql=false \
  'SELECT block_number, token FROM `proj.ds.transfers` WHERE block_number BETWEEN 21000000 AND 21010000'
```

```typescript
// in the Node client
await bigquery.createQueryJob({ query, dryRun: true })                    // statistics.totalBytesProcessed
await bigquery.createQueryJob({ query, maximumBytesBilled: '10000000000' }) // the hard stop
```

### Which quotas this target pressures

Four families, each with a different lever:

| Quota family | What drives it | The lever |
|--------------|----------------|-----------|
| Concurrent write streams | One Committed stream per tracked table per process, never finalized, re-created on every restart | Fewer tracked tables; stop crash loops (each restart opens a fresh set) |
| AppendRows throughput per project per region | Rows/s × tracked-table count | Lower the batch rate, or split across regions |
| DML jobs per table | One `DELETE` per tracked table per fork, one per tracked table per recovery, plus one sync-table `DELETE` every `cleanupEverySaves` commits | Fewer tracked tables; raise `cleanupEverySaves` |
| Partitions per table | `maxBlocks / bucketSize` | Raise `bucketSize` when you raise `maxBlocks` |

"Lower the batch rate" only moves the AppendRows family. Identify which call failed from the log before reaching for it.

### What the target's own writes cost

Three distinct billing surfaces:

1. **Row ingest via the Storage Write API, not load jobs.** Load jobs are free; the Storage Write API is billed by bytes ingested. This is a deliberate trade for immediate visibility; the per-stream offsets are an in-process retry mechanism, not a cross-restart guarantee. The `committed batch:` log line reports the exact proto-encoded size of the **data rows** — not the billed size. It excludes the AppendRows request envelope (writer schema, descriptors, offsets) and the two WAL rows per batch. Check Google's current Storage Write API pricing for any per-row or per-request billing minimum before extrapolating: blockchain rows are small, so a minimum would multiply the ingest bill well past that number. Use the log line for throughput and relative sizing; use the billing export for cost.
2. **Two extra single-row WAL appends per batch**, through the same billed path. Negligible in bytes but per *batch*, so a high batch rate means a high request count. Larger batches amortize it — within the memory ceiling described in [the WAL bracket](#the-per-batch-wal-bracket).
3. **Query jobs** — fork `DELETE`s, recovery `DELETE`s, the sync cleanup `DELETE` (by default every 25 commits, plus once per process start), the startup `SELECT *` on sync, and fork paging (one `SELECT *` of up to `maxRows` sync rows per fork). The orphan probes (`SELECT TRUE AS has_row FROM t LIMIT 1`) reference no columns, so BigQuery normally bills them at zero bytes — that is Google-side billing behaviour the target neither controls nor verifies, so dry-run one for your project rather than assuming.

> **No job the target submits sets `maximumBytesBilled`, and beta.11 exposes no setting for it.** A hard ceiling on the target's own jobs must come from a project- or user-level custom quota.

### Verification and consistency queries

```sql
-- metadata only (INFORMATION_SCHEMA): the REAL DDL, incl. actual PARTITION BY / CLUSTER BY
SELECT ddl FROM `proj.ds.INFORMATION_SCHEMA.TABLES` WHERE table_name = 'transfers';

-- metadata only: partition sizes, skew, and out-of-range detection
SELECT partition_id, total_rows, total_logical_bytes, last_modified_time
FROM `proj.ds.INFORMATION_SCHEMA.PARTITIONS`
WHERE table_name = 'transfers'
ORDER BY total_logical_bytes DESC;
-- a catch-all partition id holding real rows = block numbers outside [0, maxBlocks)
```

During an incident — "is my data correct right now?" — start with the WAL state instead. `current` and `timestamp` are GoogleSQL reserved keywords, so backtick-quote them or the query will not parse:

```sql
-- billed: scans the sync rows for this id. What the pipe thinks it has committed.
SELECT `op`, `committed`, `range_low`, `range_high`,
       JSON_VALUE(`current`, '$.number') AS cursor_block, `timestamp`
FROM `proj.ds.sync`
WHERE `id` = 'erc20-transfers'
ORDER BY `timestamp` DESC
LIMIT 3;
```

`committed = TRUE` on the newest row means the tracked tables are consistent as of `cursor_block`. `committed = FALSE` means a crashed batch or an interrupted rollback, and `[range_low, range_high]` is the dirty range the next clean start will delete. Then check each tracked table for rows above that cursor:

```sql
-- billed: uncommitted rows sitting above the cursor
SELECT MAX(`block_number`) FROM `proj.ds.transfers` WHERE `block_number` > 21050000;
```

Anything above `cursor_block` is uncommitted data that the next clean start removes. If the pipe is not running and you do not intend to restart it, delete that range by hand before querying the tables.

## Porting from the ClickHouse Target

| ClickHouse | BigQuery |
|------------|----------|
| `store.insert({ table, values, format })` — async, ships immediately | `store.insert(table, rows)` — synchronous, buffers until the target commits after `onData` |
| `onRollback({ reason: 'recovery' \| 'fork', store, safeCursor })` | Automatic per-table bounded `DELETE`s, plus notification-only `onBeforeRollback` / `onAfterRollback` — fork path only |
| `store.removeRowsAfter` (and the deprecated `removeAllRows`), `removeAllRowsByQuery` | Not supported. Reorg cleanup is the target's own range `DELETE` |
| `store.ensureRollbackIndex({ table })` | Not supported. Range partitioning on `blockNumberColumn` is the equivalent, and it is mandatory |
| `store.executeFiles(dir)` for `onStart` DDL | Not supported. Use `store.query(sql)` from `onStart` |
| `settings.database` (defaults from the client) | `dataset`, required, and it must already exist |
| `settings.{ table, id, maxRows }` at the top level | `settings.state.{ table, id, maxRows, cleanupEverySaves }` |
| A fork without `onRollback` is refused (E2007) | Always rolls back; no handler is required |
| CollapsingMergeTree `sign` cancel rows propagate through materialized views | No equivalent. Rebuild ClickHouse MVs as BigQuery views, materialized views, or scheduled queries over the tracked tables |

Delete your `onRollback` handler. Reorg cleanup is automatic and covers exactly the tables in `tables[]`, so move any derived table the handler used to clean into `tables[]`, give it a block-number column, and drop the handler body. Keep `onBeforeRollback` only for logging or notifying downstream: it cannot veto, cannot write, and does not fire on crash recovery.

A per-block `await store.insert(...)` loop that was safe on ClickHouse accumulates the entire batch in memory here. See [the WAL bracket](#the-per-batch-wal-bracket).

## Troubleshooting by Error Text

Every `E22xx` is a `BigQueryTargetError extends PipeError`, carries `name = 'TargetConfiguration'` and a readonly `code`, and appends `See: https://docs.sqd.dev/en/sdk/pipes-sdk/errors/<code>` to the message. `E10xx` fork-handling errors are `PipeError`s too, with `name = 'ForkHandling'`.

| Error text (literal) | Code | Cause | Fix |
|----------------------|------|-------|-----|
| `bigqueryTarget: cannot determine GCP project id` | E2201 | Neither `options.projectId` nor `client.bigquery.projectId` set | Pass `projectId` to `bigqueryTarget`, or construct `new BigQuery({ projectId })`. Thrown before any I/O |
| `schema does not include the partition column` | E2202 | `blockNumberColumn` is not in `tables[].schema` **and the table does not exist yet** | Add it. If the table already exists you get E2213 at the first commit instead — see [Choosing the partition column](#choosing-the-partition-column) |
| `is missing the partition column '…'. Add it as INT64 NOT NULL` | E2202 | The **live** table has no such column | The declared column name does not match the deployed table. Fix the name or `ALTER TABLE ADD COLUMN` |
| `typed as <TYPE>, but the BigQuery target requires INT64` | E2203 | Existing table's block column is FLOAT64/NUMERIC/STRING/… | Recreate the table with `INT64`. FLOAT/NUMERIC lose precision above 2^53; STRING compares lexicographically |
| `but the BigQuery target requires NOT NULL` | E2204 | Block column is `NULLABLE` | Recreate as `REQUIRED`. NULL rows never match the fork `DELETE` predicate |
| `is not range-partitioned on '…'` + `Suggested DDL:` | E2205 | Pre-existing table has no/other range partitioning | Recreate with the suggested DDL, or set `settings.partitioning: false` and accept full-table `DELETE` scans |
| `has mode=REPEATED. The target's auto-creation does not support array fields` | E2206 | Array field, table missing | Pre-create the table by hand with the `ARRAY<...>` column; validation then passes, but prove one batch through |
| `has type=RECORD` / `type=STRUCT` | E2206 | Nested field, table missing | Same escape hatch: pre-create with the `STRUCT<...>` column |
| `is missing declared column '…' of type …` | E2207 | Declaration drifted above the live table | Run the `ALTER TABLE ADD COLUMN` yourself — there is no migration path |
| `column '…' has type X, but declared as Y` | E2208 | Type mismatch (after legacy-alias canonicalization) | Align the declaration to the live table, or recreate the table |
| `column '…' has mode X, but declared as Y` | E2208 | Mode mismatch; missing mode normalizes to `NULLABLE` | Set the mode explicitly on both sides |
| `Table '…' is not registered for fork tracking. Registered tables: …` | E2209 | `store.insert()` on a table absent from `tables[]` | Add it to `tables[]`. Thrown synchronously, before any RPC — usually a typo |
| `Internal: no schema registered for tracked table '…'` | E2210 | Internal invariant broken | Not user-fixable; report it with the table name |
| `IN_FLIGHT state has NULL range_low/range_high; cannot recover` | E2211 | Sync row corrupted or hand-edited | Inspect the sync table for that id. Recovery cannot infer the range |
| ``has no rows for id='…', but tracked table `…` still holds data`` | E2212 | Sync rows cleared, or the cursor key or `settings.state.table` changed, while data remains | Either restore the id (`settings: { state: { id: '…' } }`), or truncate the tracked tables listed in the message for a genuine fresh run |
| `BigQuery rejected N row(s) in AppendRows for … at offset …` | E2213 | Per-row rejection: proto/schema mismatch, NOT NULL violation, value out of range | Compare the live table schema against your declaration. A live `REQUIRED` column missing from `tables[].schema`, a `blockNumberColumn` missing from it, and a `BIGNUMERIC` fed an overflowing integer all land here. The rejected chunk was not written, but earlier chunks of the same table and every table committed in parallel **were** — the next clean start's recovery `DELETE` removes them |
| `A blockchain fork was detected, but the target resolveFork() did not return a new cursor` | E1003 | Reorg deeper than the retained sync history, or reaching below the persisted finalized block (class `ForkCursorMissingError`, `name = 'ForkHandling'`) | Raising `maxRows` prevents a recurrence; it does not resolve the live incident — follow [Manual rewind](#manual-rewind) |
| `Portal invariant violated: max(canonicalBlocks).number=… is below the persisted cursor` | E1004 | Portal returned a fork range below the stored cursor | Target refuses rather than deleting a partial range. Check the Portal dataset and the pipe `id` |
| `Not found: Dataset <project>:<dataset>` | — | The dataset does not exist | Create it. The target never does |
| `Access Denied: … User does not have permission` (403) | — | Missing `dataEditor` on the dataset or `jobUser` on the project | See [Minimum IAM](#minimum-iam) |
| `PERMISSION_DENIED` on `bigquerystorage.googleapis.com` | — | Storage Write API not enabled, or writer credentials differ from the REST client's | Enable the API; if you passed `client.writer`, check its credentials separately |
| gRPC `8 RESOURCE_EXHAUSTED` / HTTP 429, repeatedly | — | Quota or rate limit; 9 attempts over ~32–96 s of backoff, then fatal | Identify the family from the failing call — write streams, AppendRows throughput, or DML — because the lever differs. See [Which quotas this target pressures](#which-quotas-this-target-pressures) |
| gRPC `3 INVALID_ARGUMENT` on append | — | Fatal, never retried; schema or descriptor mismatch | Same diagnosis path as E2213 |
| `Sync cleanup failed (non-fatal)` (warning, repeatedly) | — | Retention `DELETE` failing silently | The sync table is growing and the startup `SELECT *` is getting more expensive. Fix the DML permission or quota |
| `appendRows(…) has not returned after …` (warning) | — | A dropped Storage Write stream; the append neither succeeded nor failed | If no `returned after` line follows, restart the pipe. Recovery deletes the unfinished batch range and replays it |
| `Sync table … not found; creating it.` (debug, first run) | — | Expected on a brand-new pipe | Ignore |

## Related

- [SDK_FEATURES.md](./SDK_FEATURES.md#bigquery) — the BigQuery config shape and first example; also [cursor keying](./SDK_FEATURES.md#cursor-keying--upgrading-to-alpha15) and [Pub/Sub → BigQuery CDC](./SDK_FEATURES.md#google-pubsub-beta2)
- [SCHEMA_GUIDE.md](./SCHEMA_GUIDE.md) — the ClickHouse-side type mapping the BIGNUMERIC/STRING rule mirrors
- [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) — Portal, ABI and Node-level failures upstream of the target
- [STREAM_RESILIENCE.md](./STREAM_RESILIENCE.md) — keeping a long-running indexer alive
- [Google BigQuery pricing](https://cloud.google.com/bigquery/pricing) and [quotas and limits](https://cloud.google.com/bigquery/quotas) — the authority for every rate, free-tier size and cap referenced above
