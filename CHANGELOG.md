# Changelog

## [Unreleased]

### Improvements

- **Claude plugin directory listing.** The plugin manifest declares the SQD logo as its icon and links the SQD privacy policy, and the plugin README states what the plugin sends and where. The directory listing notes moved to `distribution/DIRECTORY_SUBMISSION.md`, outside the installed package, and `npm run test:claude-plugin` checks the plugin files against the directory's file rules.
- **Readable squid-perf report.** The report template is plain HTML that draws its own charts instead of a packed bundle with Chart.js. Reports stay self-contained, work offline, and are about half their previous size.

### Documentation

- Clarified contributor guidance and updated API documentation references.
- The Pipes SDK setup guide links to the official nvm, Bun, and Docker install guides instead of piping install scripts into a shell.

## [0.8.5] - 2026-09-05

SQD Portal MCP 0.8.5 adds native Tron and EVM trace queries, a one-click Claude Desktop bundle, toolsets for trimming the catalog, and an opt-in beta of the SQD Explorer that fits its host. It corrects a set of cases where a tool reported a result as more complete than the data supported, and gives operators cost guardrails and request traces.

### New

- **Tron queries.** `portal_tron_query_transactions` returns native TRX transfers, TRC-10 transfers, and smart-contract calls with inline logs and internal transactions. `portal_tron_query_logs` returns TVM event logs by contract and topic, with the parent transaction hash on every row. Addresses are accepted as Base58, 41-prefixed hex, or 20-byte hex, and results carry both forms. Malformed addresses and filters that do not fit the chosen transaction kind are rejected before any request.
- **EVM traces.** `portal_evm_query_traces` returns internal calls, contract creations, self-destructs, and block rewards. Filter by trace type, caller, callee, selector or method alias, deployer, or created contract, or pass a transaction hash with its block for the full internal call tree. Rows carry the parent transaction hash, a deterministic id, and flattened action and result fields. The catalog now holds 31 tools.
- **Claude Desktop bundle.** Every release includes `sqd.mcpb`. Open it and Claude Desktop installs the server with one click. An optional setting turns on the SQD Explorer beta. Node 22 or newer is required on the machine.
- **Toolsets.** Every tool belongs to one of nine toolsets: `discovery`, `convenience`, `evm`, `solana`, `bitcoin`, `substrate`, `hyperliquid`, `tron`, and `debug`. `MCP_TOOLSETS` or `MCP_TOOLS` trims a deployment's catalog, and `?toolsets=` or an `X-MCP-Toolsets` header narrows one HTTP connection without ever widening it. Prompts, guide resources, and the server instructions describe only the tools that are active.
- **SQD Explorer beta, opt in.** The Explorer is labelled Beta and stays off by default. `MCP_APP_ENABLED=true` turns it on for a deployment, `?app=1` and `?app=0` override that for one connection, and `/health` reports the deployment setting. The inline card reports its exact height so hosts no longer pad it, structural colours follow the host's theme in light and dark, and full screen opens a two-column workspace. Addresses, hashes, and blocks link to the public explorer for their network, and network chips show the chain logo and display name.
- **Cost guardrails.** `MCP_GUARDRAIL_MODE` (`off`, `shadow`, or `enforce`) with per-class ceilings on scan blocks, window seconds, and upstream bytes through `MCP_GUARDRAIL_<CLASS>_<LIMIT>`. Shadow mode counts what enforcing would cut without changing a response. Nothing changes until a ceiling is set. Four Prometheus counters report admitted, would-block, blocked, and fail-open decisions.
- **Traces.** Set `OTEL_EXPORTER_OTLP_ENDPOINT` and each tool call is exported as one trace: the request, the wait for an admission slot, every Portal fetch attempt, and result formatting. A `traceparent` on the HTTP request or in the call's `_meta` joins the caller's trace, and each Portal request carries its own. The OpenTelemetry packages are optional peers, and nothing is loaded when the endpoint is unset. Span attributes never carry arguments, addresses, hashes, or cursors.
- **Per-caller fairness.** One caller holds at most `MCP_TOOL_CLIENT_WEIGHT_SHARE` percent of the tool budget and `MCP_TOOL_CLIENT_MAX_QUEUE` queued calls, and receives a retryable `overloaded` result with `reason: client_share` beyond that while other callers keep flowing. `MCP_TRUST_PROXY` and `MCP_TRUSTED_PROXY_PREFIXES` control how the caller address is read behind a proxy. Calls slower than `MCP_SLOW_REQUEST_MS` log one line with their timings.

### Improvements

- **Explorer charts.** Lines, areas, bars, and candles all draw through one charting engine and share axes, hover, gap handling, and palette. A missing bucket leaves a gap instead of a line drawn through it. Zoom, hidden series, and scroll position survive a follow-up query. Ranked panels show ten rows with a Show all control, tables page ten rows with search, and JSON and CSV export go through the host. The tool contract advertises only the chart controls that exist.
- **Bitcoin fees.** `portal_bitcoin_get_analytics` sums fees in exact satoshis over the newest 36 blocks of the analysed window and names that block set. The `fees_btc` time series returns per-bucket fees that reconcile to the window total, and series declare their bucket alignment.
- **Hyperliquid fill summaries.** `portal_hyperliquid_query_fills` with `response_format: "summary"` returns the fill count, unique traders and coins, volume, fees, realized PnL, the direction breakdown, and the top coins by volume.
- **Network catalog.** `portal_list_networks` matches the same nicknames the query tools accept, so `btc` finds `bitcoin-mainnet`.
- **Time-series metrics by chain family.** The `metric` description of `portal_get_time_series` names which metrics each chain family computes.
- **Hardened HTTP transport.** The server binds loopback by default, checks `Host` and `Origin` on every route, bounds header, request, and keep-alive time, caps request bodies, and answers `/ready` only once the dataset catalog has loaded and Portal is reachable. The Docker image's health check uses `/ready`.
- **Traceable builds.** `/health` and the `_server` block of every result carry the git commit the image was built from. Docker Hub `latest` now means the latest release tag, and `main` builds publish `edge` and `sha-<commit>`.
- **Smaller catalog.** The tool catalog a client loads per session is about a fifth smaller, with no change in tool behaviour.
- **Third-party text is data.** Token, pallet, program, and coin names from external sources are listed in `_tool_contract.untrusted_fields`, are cleaned and quoted before they appear in prose, and stay byte-identical in structured fields. CSV export neutralises formula prefixes.
- **Contributing.** `SECURITY.md`, `CONTRIBUTING.md`, a code of conduct, issue and pull request templates, and `AGENTS.md` with the build and test commands. `docs/explorer-design.md` records the Explorer's design rules.

### Fixes

- **The SQD Explorer renders in Claude.** The app resource declared a dedicated origin through `_meta.ui.domain` and the ChatGPT alias `openai/widgetDomain`. Claude validates that field against the connector URL and shows an error instead of the app when the value does not match, so every App-enabled result arrived as a failed widget with no chart, table, or numbers. The resource now claims no origin. The content security policy that limits it to SQD's chain-logo origins is unchanged, and no configuration change is needed.
- **Network names resolve exactly.** Aliases were matched as substrings, so `opbnb` could answer with Optimism data and `btc-testnet` with Bitcoin mainnet. Matching is now whole-name, and a network SQD does not carry returns `unknown_network`.
- **Time series answers only the metrics it computes.** Metrics a chain family does not compute used to return an all-zero series marked complete. They are now refused with `unsupported_operation`.
- **Long time-series windows are refused instead of run.** A window over 12,000 blocks is refused with the block count, the bound, and a duration that fits on that chain, instead of running for minutes. The limit is in blocks, so `24h` still works on Bitcoin and Ethereum.
- **Fast mode reports the window it read.** `mode: "fast"` on a long EVM window analyses the newest 1,500 blocks. It now marks the window incomplete and says how much was read; `mode: "deep"` reads all of it.
- **Partial reads are disclosed.** A scan that stops before the start of the requested window now reports `_coverage.window_complete: false` and names the blocks it searched. This covers the Tron query tools, token transfers, the contract-deployment search, and every tool that scans backward from the newest block. A wallet summary with a failed section no longer reports a complete result, and a Bitcoin fee series no longer gives two different answers about its window.
- **Oldest-first scans can be continued.** `scan_order: "earliest"` on logs, token transfers, and traces returns a working cursor. `_pagination.has_more` is true exactly when a cursor is present, and an oldest-first page describes itself as such.
- **Summaries add up the fields they need.** Trace, transaction, and fill summaries reported zero totals when the field preset omitted the fields they aggregate. A summary now reads the fields it sums.
- **Fill summaries return aggregates.** `portal_hyperliquid_query_fills` in summary format returned `internal_error`. It now returns the aggregates listed above.
- **Maker rebates are not fees.** Hyperliquid analytics sum fees signed, so a window whose makers were paid rebates no longer reports fees collected.
- **Token amounts use the token's decimals.** Unfiltered token-transfer results formatted every amount with 18 decimals, so a USDC transfer read as a tiny fraction. Amounts now use the token list, and an unknown token shows raw units with a notice.
- **Hyperliquid tools take Hyperliquid inputs only.** `hyperliquid-mainnet`, the EVM chain, is refused with a pointer to the EVM tools, and a `user`, `builder`, or `vault_address` filter that is not an address fails as `invalid_request` instead of returning an empty window.
- **Truncated entity matches say so.** `portal_resolve_entity` reports the total match count and marks the result incomplete when the list was cut to `limit`.
- **Prompts and guides follow the active toolset.** A trimmed deployment no longer lists, routes to, or suggests networks for tools it does not serve.
- **A caller cannot forge its fair share.** The admission key is the connection alone, the forwarded address is read only from a trusted proxy and counted from the right of `X-Forwarded-For`, and addresses are canonicalised before hashing.
- **Bitcoin page size.** The `limit` description of `portal_bitcoin_query_transactions` says when a full-format page with inline inputs and outputs can exceed the response budget.

### Upgrade notes

- Node 22 is the supported runtime.
- A non-loopback bind, including the Docker image, needs `MCP_ALLOWED_HOSTS` and `MCP_ALLOWED_ORIGINS`, or `*` behind a proxy that validates them.
- Set `MCP_CURSOR_SECRET` on any deployment with more than one process so cursors survive a restart or a load-balanced hop.
- Docker Hub `latest` is produced only by release tags. Pin a version tag in production.
- `portal_get_time_series` refuses windows over 12,000 blocks. Use a shorter duration on fast chains.

**Full Changelog**: https://github.com/subsquid-labs/portal-mcp-server/compare/v0.8.4...v0.8.5

## [0.8.4] - 2026-08-31

SQD Portal MCP 0.8.4 corrects timestamp, identity, pagination, aggregate, wallet, candle, validation, and response-budget defects across every supported chain family, and checks the corrected answers against direct SQD Portal queries.

### Fixes

- **Time windows.** EVM, Solana, Bitcoin, Substrate, Hyperliquid, and Tron use the correct timestamp units, refine Portal boundary matches against observed block timestamps, disclose requested and actual bounds, and reject future or unverifiable explicit intervals.
- **Row identities.** Solana, Bitcoin, Substrate, and Hyperliquid rows carry deterministic primary ids, including nested Substrate events and calls. A missing or duplicate id now fails as an incomplete result instead of looking complete.
- **Wallet paging.** Solana and Hyperliquid wallet pages continue without overlap, Bitcoin inputs and outputs have distinct identities and their parent transaction hashes, and compact output no longer hides page activity.
- **Units and totals.** Bitcoin values are reported as BTC with exact satoshi companions, and EVM transaction totals include contract creation while destination rankings still exclude absent destinations.
- **Candles.** EVM OHLC volume uses integer-safe decimal arithmetic, summary totals cover only the returned candles, recent trades stay inside the resolved window, and final-bucket completeness is explicit.
- **Input validation.** Solana public keys and discriminators, Bitcoin addresses, Hyperliquid addresses, and Tron addresses fail before any Portal request when malformed or unsupported for the selected query.
- **Response budgets.** Public limits match measured response budgets, compact results are measured on their wire encoding, and Hyperliquid replica-command scans are bounded. Portal overloads return structured retry guidance.

### Improvements

- **Explorer identity.** Every applicable result names the SQD Blockchain Activity Explorer, advertises host readiness without claiming a render the server cannot observe, clears stale data on a failed follow-up, and pages large evidence tables inside the app.
- **Protocol.** Stateless MCP `2026-07-28` discovery, deterministic cache hints, and header-routed HTTP requests, with the compatibility path retained for clients on the previous revision.

**Full Changelog**: https://github.com/subsquid-labs/portal-mcp-server/compare/v0.8.3...v0.8.4

## [0.8.3] - 2026-08-30

SQD Portal MCP 0.8.3 introduces the SQD Blockchain Activity Explorer, an MCP App that renders tool results inside hosts that support it, and adds evidence receipts, guided investigations, and adaptive tool scheduling. Every existing client keeps the same structured and text answers.

### New

- **SQD Blockchain Activity Explorer.** One self-contained MCP App presents exact metrics, multi-series charts, candle and volume views, evidence tables, timelines, coverage, freshness, partial results, errors, empty results, and continuation controls for 21 data tools. It uses standard MCP Apps metadata alongside ChatGPT compatibility aliases, loads no external assets, and keeps no persistent browser storage. Hosts without MCP App support receive the same `structuredContent` and compact JSON text.
- **Evidence receipts.** Material results include canonical tool arguments, a deterministic digest, source windows, row reconciliation, and an exact or semantic replay mode, so a moving relative query is never described as a frozen snapshot.
- **Guided investigations.** The `investigate-wallet`, `investigate-contract`, and `investigate-market` prompts produce reusable investigation plans and are discoverable alongside their MCP guide resources.
- **Evidence workspace.** Linked overview, chart, evidence, and investigation sections add range-focused follow-ups, searchable records, session-only history, and JSON or CSV export.

### Improvements

- **Adaptive tool execution.** A weighted, cancellation-aware scheduler protects fast lookups from expensive concurrent analytics, shares identical analytics already in flight, promotes queued work fairly, bounds queue time, and returns structured overload guidance when saturated.
- **Faster repeated EVM candles.** Identical live OHLC requests reuse one short-lived snapshot, and freshness fields still identify the exact evidence returned.
- **Coverage and pagination agree.** Client-filtered EVM scans continue without gaps or duplicates, exhausted Bitcoin wallet sections stay exhausted, and candle cursors identify adjacent time windows correctly.
- **SQD design system.** Inter and JetBrains Mono, semantic dark surfaces, status fills, table typography, and right-side chart scales come from the current SQD design system. Charts render in chronological order and keep missing buckets as gaps.
- **Accessibility.** Keyboard point inspection, searchable and sortable evidence, and series toggles, on desktop and mobile layouts under light and dark host preferences.
- **Chart contracts.** Chart descriptors advertise point inspection and series toggles, and do not claim zoom, visual switching, or image export the app does not implement.
- **App and admission metrics.** Prometheus series cover result-to-render conversion, render payload size, app resource reads, bundle size, admission wait, active weight, queued work, and rejection reasons.
- **Bundled skills.** The plugin packages the current `subsquid-labs/skills` snapshot so Codex, Claude, Grok, Gemini, and Cursor discover the Portal, Pipes SDK, migration, and performance skills.

**Full Changelog**: https://github.com/subsquid-labs/portal-mcp-server/compare/v0.8.2...v0.8.3

## [0.8.2] - 2026-08-29

SQD Portal MCP 0.8.2 keeps every returned row trustworthy under large responses, malformed streams, retries, and concurrent load.

### Improvements

- **No silent evidence loss.** An oversized result returns a structured `response_too_large` error with a safer limit to retry with, instead of dropping rows or nested arrays.
- **Exact continuation in dense blocks.** Same-block cursors accumulate their boundary offset, so many matching rows in one block no longer repeat across pages. Bitcoin wallet summaries filter exact address matches, stay below the response budget, and provide signed continuation cursors.
- **Bounded load admission.** Portal requests use a configurable active and queued budget, propagate cancellation while queued, and return a retryable overload result when capacity is exhausted.
- **Retry storm resistance.** Retries use full jitter, respect `Retry-After` as a minimum, release capacity before waiting, and stop inside one wall-clock budget.
- **Malformed-stream safety.** Truncated NDJSON, invalid JSON, and premature response termination can no longer look like complete results.
- **Fast EVM candles.** Exact time windows no longer trigger redundant historical backfill, and optional Uniswap v4 metadata lookup has its own cancellation-aware budget.
- **Capacity metrics.** Prometheus exposes active and queued Portal work, admission wait, and admission rejection rate.

**Full Changelog**: https://github.com/subsquid-labs/portal-mcp-server/compare/v0.8.1...v0.8.2

## [0.8.1] - 2026-08-28

SQD Portal MCP 0.8.1 makes empty results, invalid inputs, upstream failures, and client cancellation easier for agents to act on, and gives operators outcome metrics that separate useful empty or partial answers from failures.

### Improvements

- **Consistent result contracts.** Network discovery, head lookups, Tron timestamps, time series, and Hyperliquid candles report pagination, coverage, ordering, freshness, and primary evidence the same way.
- **Actionable tool errors.** Expected validation and Portal failures return stable `isError` results with a bounded code, origin, retry guidance, and machine-readable next steps instead of generic protocol errors.
- **Cancellation-safe recovery.** Client cancellation stops active Portal work promptly, does not count as a tool error, releases in-flight accounting, and leaves the next request healthy.
- **Bounded retries.** Retry waits are finite and capped, skip the wait after the final attempt, and distinguish retryable Portal failures from invalid requests that fail immediately.
- **Outcome metrics without prompt capture.** Metrics distinguish data, empty, partial, error, and cancelled results, attribute failures to client input, upstream, server, or transport, and reduce client identity to bounded families and major versions. User questions and arbitrary client headers are never captured.
- **One release identity.** The package, the registry entry, and the Codex, Claude, Grok, Gemini, and Cursor manifests advance together and are checked against the same version.

**Full Changelog**: https://github.com/subsquid-labs/portal-mcp-server/compare/v0.8.0...v0.8.1

## [0.8.0] - 2026-08-27

SQD Portal MCP 0.8.0 moves to the stable MCP SDK v2 and the stateless MCP `2026-07-28` protocol, adds plugins for Codex and Claude Code, and requires no SQD account or API key.

### New

- **Codex plugin.** A plugin wrapper for the hosted SQD endpoint with a repo-local marketplace, so Codex installs `portal@sqd` from this repository. Includes the official SQD logo and a composer icon.
- **Claude Code plugin.** The same package installs into Claude Code as `portal@sqd`. Grok Build reads it through its Claude-plugin compatibility path.
- **Custom connector setup.** Documented credential-free setup for Grok chat and ChatGPT.

### Improvements

- **MCP SDK v2 and stateless MCP 2026.** HTTP and stdio negotiate MCP `2026-07-28` and keep the SDK-managed compatibility path for clients on the previous revision. Developer guides and schemas are registered as resources with cache hints.
- **End-to-end cancellation.** Active Portal and enrichment requests stop promptly when a client cancels, including during retry backoff and response-body reads.
- **Complete request timeouts.** JSON and NDJSON timeouts cover the full response body instead of ending when headers arrive.
- **Isolated cache loads.** Cancelling one in-flight cached query no longer fails unrelated callers requesting the same data.
- **Bounded sparse log searches.** Large filtered latest-log queries inspect at most 25,000 recent blocks by default and disclose any unscanned portion of the window. `max_scan_blocks` opts into deeper coverage.
- **Faster wallet summaries.** EVM wallet sections scan concurrently, and a summary returns an explicitly marked partial result when one section is temporarily unavailable. Hyperliquid wallet summaries stay inside a disclosed 2,000-block window.
- **Bounded OHLC backfill.** Optional Uniswap v4 metadata discovery and historical candle backfill stay within interactive request budgets and return partial coverage rather than exceeding the MCP timeout.
- **Native Tron classification.** Tron networks use their native Portal timestamp query shape and return clear unsupported-tool guidance instead of malformed EVM requests.
- **Terminal metrics.** Every invocation records exactly one of `success`, `partial`, `tool_error`, `request_error`, or `cancelled`. Only actual failures increment the error counter.

### Removed

- The duplicate `/tools` HTTP catalog and bespoke session plumbing. Tool and resource discovery use the MCP protocol, and `/tools` and `/tools.json` return `404`.
- Unregistered tool implementations and helper modules that never appeared in the catalog.

**Full Changelog**: https://github.com/subsquid-labs/portal-mcp-server/compare/v0.7.9...v0.8.0

## [0.7.9] - 2026-05-16

Portal MCP v0.7.9 is focused on developer and agent ergonomics for natural blockchain questions.

### Highlights
- **Entity resolver** — added `portal_resolve_entity` so clients can resolve EVM token symbols/addresses, EVM contract aliases, pool identifiers, DeFi protocol names, and Hyperliquid coin names before building deterministic filters.
- **Token-list backed symbols** — `portal_evm_query_logs` and `portal_evm_query_token_transfers` now accept `token_symbols`; `portal_evm_query_transactions` accepts `from_token_symbols` and `to_token_symbols`, resolving them through open token-list data instead of hardcoded token address constants.
- **Token metadata cleanup** — removed baked-in common token and pool metadata from runtime helpers. Token decimals, symbols, and names now come from token-list lookups where available, with explicit fallback and stale-cache notices.
- **Token-list diagnostics** — token-list fetch outcomes, cache behavior, stale-cache use, and unsupported token-list networks are now easier to inspect during operations.
- **Shared bounded search** — EVM logs, ERC20 transfers, transaction scans, and contract deployment lookup now share bounded block-scan metadata and partial-window notices.
- **Investigation-ready responses** — queried and summary responses now include an `investigation` guide with primary evidence paths, pivot fields, follow-up filters, and limitations so agents can trace onchain incidents without new tools.
- **Incident prompt routing** — tool descriptions and routing tests now explicitly cover suspicious-wallet triage, stolen-token movement, hack/incident traces, and exact transaction evidence using the existing 28-tool surface.
- **Cross-VM investigator parity** — added regression coverage for Solana program investigations, Bitcoin address-flow summaries, and Hyperliquid trader/coin questions.
- **Unified response envelope** — all current tools now emit the same `answer`, `display`, `next_steps`, `investigation`, `_llm.answer_sequence`, `_freshness`, `_pagination`, `_coverage`, `_ordering`, `_execution`, and `_tool_contract` contract from the central formatter.
- **Response-size budget** — `npm run test:quality` now runs cold and warm passes, validates every envelope key/type, and fails per-tool median/p95 response-size regressions against the committed v0.7.9 live baseline.
- **Natural-language time windows** — shared timestamp parsing now accepts compact and natural forms such as `past 30 minutes`, `in the past 1h`, `in last 38 mins`, `last hour`, and `30 minutes ago` across timeframe, duration, `from_timestamp`, and `to_timestamp` paths.
- **Completeness-safe live answers** — bucketed Base, Solana, and Hyperliquid outputs now preserve continuous bucket rows in the tested windows, low-limit Solana/Hyperliquid recent queries stay bounded, and any partial analysis or preview page is disclosed in the top-level answer instead of only in metadata.
- **Odd-window bucket alignment** — Hyperliquid time series/OHLC and EVM OHLC now align emitted bucket timestamps to the full rounded bucket span, so windows like `in last 38 mins` with `5m` intervals return populated buckets instead of empty-looking rows.
- **Long-window bucket completeness** — `past 6h` and `past 24h` bucketed checks now prefer complete scans over partial charts: Solana uses smaller concurrent slot chunks, Base grouped contract trends chunk large transaction windows, and Hyperliquid fill scans request block numbers so partial Portal subranges can be continued instead of silently skipping buckets.
- **Complete-window defaults** — wallet, contract, ranked-contract, and time-series convenience tools now default to complete requested-window analysis; bounded previews remain only as an explicit compatibility option for callers that already send it.
- **Wallet fund-flow triage** — `portal_get_wallet_summary` now returns `fund_flow` by default across supported VMs, with inbound/outbound movement, asset flow rows, counterparties, largest observed movements, and next evidence pivots for investigations.
- **ERC721 mint lookup hardening** — `portal_evm_query_logs` now guides latest pass/NFT mint prompts to Transfer-from-zero filters, decodes ERC721 token IDs from `topic3`, returns the parent tx hash in decoded output, and refuses unbounded historical mint scans instead of timing out or returning incomplete zero-result answers.
- **Developer discovery refresh** — updated the tool guide and HTTP catalog surface for the new `28`-tool registry (`25` public, `3` advanced/debug).

### Factual UX and safety hardening
- **Estimated-window provenance** — relative timeframe fallbacks now carry machine-readable estimated block-window provenance in `_freshness.estimated_timeframe`, plus user-facing notices when timestamp lookup was unsupported or unavailable.
- **Coverage honesty** — bounded contract-activity previews now distinguish requested and analyzed block bounds and mark partial windows as incomplete instead of presenting fast-mode scans as full-window analysis.
- **No temporary API-key path** — removed the provisional MCP bearer-token branch; the server stays credential-free.
- **Redacted errors** — actionable errors now strip URL query strings, redact authorization-like fields, and summarize Portal query bodies instead of echoing full request material.
- **Signed cursors** — pagination cursors are HMAC-signed and revalidated on decode, so edited or unsigned cursors fail with actionable guidance.
- **Structured tool results** — tools now return the unified envelope in MCP `structuredContent` while keeping an equivalent compact JSON text fallback for older clients.
- **Executable next steps** — safe pagination follow-ups now identify executable tool calls with explicit cursor arguments; descriptive suggestions are marked non-executable.
- **Limit schema cleanup** — Solana transaction, Bitcoin transaction, and Hyperliquid fill limits are capped at 200, and EVM transaction/log descriptions now match their actual 200-item caps.

### Release packaging
- **Smaller npm package** — the published tarball is limited to the runtime build, README, changelog, license, and package metadata.
- **Package-content check** — the release gate now verifies that source, test, plan, workflow, dashboard, lockfile, and local tooling artifacts stay out of the npm package.

## [0.7.8] - 2026-05-07

Portal MCP v0.7.8 is focused on query correctness, faster analytics, and release discipline. It keeps the interactive visual app work out of this release track so the tool/runtime updates can be reviewed independently.

### Highlights
- **EVM transaction type search** — `portal_evm_query_transactions` now exposes `transaction_type` and `scan_order`, enabling prompts such as “first Ethereum mainnet tx type 0x1 from block 12,244,000” without manual block-by-block clicking.
- **EVM investigator queries** — added method/event aliases, earliest/latest event and token-transfer scans, top-N transaction ranking by value/gas, richer client-side transaction filters, and `portal_evm_get_contract_deployment` for deployer/deployment-tx lookups.
- **EVM investigator regression suite** — added `test:evm-investigator` to exercise real prompts for first/last typed transactions, sighashes, failed txs, contract creation, thresholds, event aliases, deployment lookup, rankings, and top sender/receiver aggregation.
- **Faster analytics windows** — added short-lived query caching and larger safe EVM time-series chunks so repeated analytics and comparison calls avoid redundant Portal scans.
- **Compact continuation UX** — improved next-step and pagination metadata so clients can continue older result pages without reverse-engineering cursors.
- **OHLC metadata improvements** — seeded known pool/token metadata for common Uniswap and Base pools so candle outputs can infer human-readable prices more often.
- **HTTP introspection** — added `/tools` and `/tools.json` catalog endpoints plus `/mcp` as an HTTP alias, with unknown routes returning fast JSON 404s.
- **HTTP operations fixes** — canonicalized dataset labels, protected optional operational endpoints by default, and added an HTTP smoke test for deployment-facing endpoints.
- **Real-time timestamp windows** — relative timeframes now anchor to the latest indexed block or slot timestamp and use Portal timestamp lookup on real-time datasets, including Solana and Hyperliquid fills windows.
- **Release-note discipline** — release scripts now require a hand-written changelog entry before tagging instead of dumping raw commit subjects into `CHANGELOG.md`.

### Post-release hardening
- **Contract deployment lookup stability** — `portal_evm_get_contract_deployment` now uses Portal-side `createResultAddress` filtering, supports known aliases such as BAYC/Bored Apes, caps broad historical scans, and returns actionable empty-window guidance instead of risking MCP disconnects.
- **Bitcoin inline IO hydration** — `portal_bitcoin_query_transactions` now attaches requested inputs/outputs only for returned transaction blocks with compact fields, avoiding oversized 1h inline IO scans.
- **Developer tool guide** — exposed structured tool-selection metadata through `sqd://tools`, `sqd://tools/{name}`, and enriched HTTP `/tools` output so client builders can discover examples, categories, and starting points without reading source.

**Full Changelog**: https://github.com/subsquid-labs/portal-mcp-server/compare/v0.7.7...v0.7.8

## [0.7.7] - 2026-04-10

### Breaking surface changes
- Redesigned the public MCP surface around user jobs instead of older mixed naming.
- Standardized public params on `network` and discovery filters on `vm`.
- Removed legacy public tool names and aliases from the exposed registry.
- Settled on `23` public tools plus `3` advanced/debug tools.

### Added
- Added Substrate support with `portal_substrate_query_events`, `portal_substrate_query_calls`, and `portal_substrate_get_analytics`.
- Added EVM OHLC via `portal_evm_get_ohlc`.
- Added EVM OHLC support for Uniswap v2-style swaps, Uniswap v3 swaps, Uniswap v4 PoolManager swaps, Aerodrome Slipstream swaps, and Uniswap v2 Sync-derived CPMM candles where factual.
- Added cursorable OHLC history windows for both EVM and Hyperliquid candle tools.
- Added `mode: "fast" | "deep"` to the heavier convenience, analytics, and OHLC tools.
- Added `from_timestamp` and `to_timestamp` support across the remaining convenience and analytics tools.
- Added percentile sections to analytics tools where they materially help interpretation.
- Added grouped trends and compare-period outputs with chart metadata and gap diagnostics.
- Added shared chart/table descriptors so clients can render ranked tables, time series, and candles without parsing the payload heuristically.
- Added richer LLM-facing response hints including `answer`, `display`, `next_steps`, `_execution`, `_tool_contract`, `_ui`, and `_llm`.
- Added deterministic `_freshness`, `_coverage`, `_ordering`, and `_pagination` metadata across the main public tools.
- Added compact and summary response modes for analytics tools.
- Added compact-by-default behavior for raw query tools so normal chat usage stays within context limits more reliably.
- Added live routing, conversation, negative, quality, and Substrate test suites.

### Changed
- Consolidated the public surface around discovery, recent activity, wallet summary, time series, VM-specific raw queries, VM-specific analytics, and OHLC.
- Merged older specialized time-series and comparison workflows into a smaller public entry surface.
- Reworked `portal_get_wallet_summary` into a true cross-chain convenience tool with shared top-level sections.
- Reworked `portal_get_recent_activity` into a normalized recent activity feed across supported VMs.
- Reworked `portal_get_time_series` into the main public trend/comparison tool.
- Improved dataset/network info with indexed head, finalized head, and lag reporting.
- Improved Hyperliquid analytics with short-lived caching and in-flight deduplication for repeated calls.
- Improved Solana analytics first-run latency by tightening default fast-path windows.
- Improved chart responses with explicit gap diagnostics and better descriptors for renderers.
- Improved public tool descriptions and examples for LLM selection and follow-up behavior.
- Trimmed default payload sizes for chart and analytics responses to stay closer to chat-sized budgets.
- Kept advanced tools available, but clearly separated them from the core public surface.

### Fixed
- Fixed partial-range scanning issues in aggregate and analytics paths where a partial Portal subrange could be treated as complete.
- Fixed Solana analytics continuation so live scans do not stop early on partial subranges.
- Fixed Hyperliquid OHLC window backfill and continuation behavior for longer durations.
- Fixed Hyperliquid OHLC bucket coverage for live windows, including the flaky `6h -> 15m` case.
- Fixed chain-mismatch UX so unsupported network/tool combinations return actionable guidance instead of vague failures.
- Fixed several raw query payloads to preserve useful inline context while still defaulting to compact mode.
- Fixed EVM OHLC defaults so recent trade tapes do not crowd the response unnecessarily.
- Fixed Hyperliquid analytics compact mode so it is meaningfully smaller than full mode.

### Testing and release process
- Expanded the live manifest to cover the current `26`-tool registry.
- Added dumb-user conversation tests to catch prompt phrasing and routing problems earlier.
- Added negative tests for unsupported-chain paths and bad tool choices.
- Added response-size and latency budget checks in `test:quality`.
- Made truncation a test failure instead of a warning.
- Wired CI to run the full `npm run test:ci` suite before the Docker build step.

### Docs and repo cleanup
- Rewrote the README around the actual public surface and usage patterns.
- Split public tools from advanced/debug tools in the docs.
- Removed obsolete development files.

## [0.7.6] - 2026-04-09

### Added
- Added `portal_hyperliquid_get_ohlc` for trade-fill OHLC candles on `hyperliquid-fills`.
- Added chart-oriented OHLC output with `chart.kind: "candlestick"`, volume metadata, and automatic interval selection for common durations.

### Fixed
- Fixed Hyperliquid filtered stream walking so empty intermediate chunks do not stop later matching ranges from being scanned.
- Improved Hyperliquid OHLC backfill logic so chart windows are covered more reliably for longer durations.

### Changed
- Updated Hyperliquid docs and live tool-manifest coverage for the new OHLC tool.
- Bumped release version to `0.7.6`.
