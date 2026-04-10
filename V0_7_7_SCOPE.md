# v0.7.7 Scope Tracker

This file tracks the planned `v0.7.7` release scope, current implementation status, and how each item should be cross-checked before release.

## Status Legend

- `planned`: not started yet
- `partial`: some work landed, but the item is not release-complete
- `done`: implemented and verified enough to count toward the release

## Current Snapshot

- `done`: 20
- `partial`: 0
- `planned`: 0

Last updated: `2026-04-09`

## Scope

| # | Status | Scope item | Done when | Cross-check |
|---|---|---|---|---|
| 1 | `done` | Add cursor pagination to remaining non-paginated ranked/grouped outputs | Ranked and grouped outputs, including analytics leaderboard sections, return stable `_pagination.next_cursor` and page forward cleanly | Verified page 1 -> page 2 continuity for `portal_get_top_contracts`, `portal_aggregate_hyperliquid_fills`, `portal_solana_get_analytics` top programs, and `portal_hyperliquid_get_analytics` rankings |
| 2 | `done` | Add `from_timestamp` / `to_timestamp` support to remaining convenience and analytics tools | Heavy summary tools can accept natural time windows directly, not just raw query tools | Verified on wallet summary, contract activity, transaction density, recent transactions, top contracts, and analytics tools via `npm run test:tools` plus live cursor spot-checks |
| 3 | `done` | Add a shared `_freshness` / `_coverage` contract to every tool | All user-facing tools return machine-readable freshness/completeness metadata, or have a deliberate documented exception | `npm run test:tools` now asserts `_freshness` / `_coverage` across the main query, convenience, analytics, and charting tools; utility/discovery tools remain deliberate exceptions |
| 4 | `done` | Add `mode: "fast" | "deep"` to heavy tools | All expensive summary tools expose explicit scan modes and report which mode was used | Verified on contract activity, generic time series, wallet summary, Solana analytics, Bitcoin analytics, and Hyperliquid analytics |
| 5 | `done` | Make `portal_hyperliquid_get_ohlc` return cursorable history windows for long durations | Chart clients can continue backward through OHLC history without restarting from scratch | Verified page 1 -> page 2 continuity via live `portal_hyperliquid_get_ohlc` cursor follow-up in `npm run test:tools` |
| 6 | `done` | Add EVM OHLC support for trade/event-derived candles where it makes sense | A dedicated EVM candle tool exists with a clear event source and chart-ready output | Implemented `portal_evm_get_ohlc` for Uniswap V3 swap and Uniswap V2 sync event-derived pool candles, with live Base pool coverage in `npm run test:tools` |
| 7 | `done` | Add percentile stats to analytics tools | Analytics responses expose p50/p95-style fee, value, or density metrics where relevant | Implemented and spot-checked in Bitcoin, Solana, and Hyperliquid analytics responses |
| 8 | `done` | Add top-entities trend outputs | Users can ask for "top contracts over time" or equivalent trend-style ranked series | Implemented `portal_get_top_contract_trends` with grouped chart metadata and verified live Base `1h / 5m` output in `npm run test:tools` |
| 9 | `done` | Add compare-periods mode | Analytics/time-series tools can compare current window vs previous window in one response | Implemented `portal_compare_periods` with current/previous bucket series and delta summaries; verified live Base comparison math and window ordering in `npm run test:tools` |
| 10 | `done` | Add chain head / index lag reporting in dataset info | Dataset info exposes indexed/finalized head lag in blocks and time | Verified in `portal_get_network_info` and manifest assertions |
| 11 | `done` | Normalize time-series outputs to include a `chart` descriptor | Generic and chain-specific time-series tools expose chart metadata consistently | Verified in live tool suite for generic, Solana, Bitcoin, Hyperliquid, and OHLC outputs |
| 12 | `done` | Add explicit gap diagnostics for candle/time-series outputs | Empty buckets distinguish real no-activity gaps from likely coverage/indexing issues | Implemented `gap_diagnostics` across generic, Solana, Bitcoin, Hyperliquid, and OHLC chart outputs; asserted in `npm run test:tools` |
| 13 | `done` | Improve Solana analytics first-run latency further | Default first-run Solana analytics feels fast enough for normal use without relying on cache | Default fast snapshot now uses a 5-minute window, and live verification showed `portal_solana_get_analytics({ include_programs: false })` at ~`3.1s` in a direct cold call and ~`2.6s` in `npm run test:tools` |
| 14 | `done` | Improve Hyperliquid analytics stability under repeated calls | Repeated calls avoid large tail latency and stay under MCP timeout expectations | Hyperliquid analytics now uses multi-key short-lived caching plus in-flight dedupe, and the live suite asserts a repeated-call `_cache.hit === true` follow-up |
| 15 | `done` | Add safer chunk continuation logic to any remaining aggregate tools | No aggregate tool trusts a partial Portal subrange as complete | Solana analytics now uses `portalFetchStreamRangeVisit` in its adaptive scanner, closing the remaining partial-subrange gap found in aggregate analytics scans |
| 16 | `done` | Add better chain-mismatch guidance everywhere | Unsupported tool/chain combinations always suggest the right next step | Verified with targeted negative MCP tests for `portal_evm_query_logs` on Bitcoin, `portal_solana_query_instructions` on Base, and `portal_debug_resolve_time_to_block` on Hyperliquid |
| 17 | `done` | Add deterministic result-ordering metadata | Paginated and ranked outputs explicitly say whether they are newest-first, oldest-first, rank-descending, or bucket-ascending | Asserted `_ordering` in raw query and ranking outputs via `npm run test:tools`; spot-checked recent-transactions and top-contracts page 1 -> 2 continuity |
| 18 | `done` | Add richer compact/summary response modes for analytics tools | Analytics tools can return a lighter summary shape without losing key signal | Implemented `response_format` for Bitcoin, Solana, and Hyperliquid analytics; live-checked Bitcoin summary output |
| 19 | `done` | Add release-quality regression cases for UX features | The live suite covers natural timestamps, cursor continuation, chart metadata, and new response contracts well enough to catch regressions | `npm run test:tools` now covers natural timestamps, ordering, cursor metadata, chart descriptors, summary modes, and unsupported-chain recovery guidance across 36 live MCP cases |
| 20 | `done` | Add a real release checklist / CI gate for `build + smoke + test:tools` before tagging | Releases are blocked unless build, smoke, and live suite pass | Implemented in `.github/workflows/docker-build.yml` via a `verify` job gating the Docker build |

## Notes On Current Progress

### Already landed in working tree

- `#10` is done in `portal_get_network_info`.
- `#11` is done across the main time-series outputs.
- `#1` is now done:
  - `portal_get_top_contracts`
  - `portal_aggregate_hyperliquid_fills`
  - `portal_solana_get_analytics` top programs
  - `portal_hyperliquid_get_analytics` ranked sections
- `#2` is now done:
  - completed for wallet summary, contract activity, transaction density, recent transactions, top contracts, and the Solana/Bitcoin/Hyperliquid analytics tools
- `#3` is now done across the main user-facing query, convenience, analytics, and time-series paths, with utility/discovery tools treated as deliberate exceptions.
- `#4` is now done across the heavy convenience and analytics tools.
- `#7` is now done across the analytics tools.
- `#13` is now done:
  - default Solana analytics fast snapshots now default to `5m`
  - the adaptive Solana analytics scanner now continues through partial Portal subranges
- `#14` is now done:
  - Hyperliquid analytics uses multi-key caching plus in-flight dedupe
  - repeated-call cache hits are asserted in the live manifest
- `#15` is now done through the Solana analytics continuation fix.
- `#6` is now done:
  - `portal_evm_get_ohlc` adds chart-ready EVM pool candles with gap diagnostics and cursor history windows
  - the live suite discovers an active Base Uniswap V3 pool dynamically and validates page 1 -> page 2 continuity
- `#8` is now done:
  - `portal_get_top_contract_trends` returns ranked top contracts plus grouped trend buckets for charting
  - the live suite validates Base `1h / 5m` trend output, grouped chart metadata, and gap diagnostics
- `#9` is now done:
  - `portal_compare_periods` returns current and previous bucket series plus delta summaries in one response
  - the live suite validates Base comparison bucket counts, compare chart metadata, and window ordering
- `#18` is now done across the analytics tools.
- `#16` is now done through shared unsupported-chain guidance plus negative live regression cases.
- `#17` is now done across paginated/ranked outputs via `_ordering`.
- `#19` is now done through expanded live assertions in `scripts/tool-manifest.ts`.
- `#5` is now done via cursorable `portal_hyperliquid_get_ohlc` history windows.
- `#12` is now done via shared `gap_diagnostics` on chart outputs.
- `#20` is now done via the workflow gate in `.github/workflows/docker-build.yml`.

### Update rule

When an item is finished:

1. Change its `Status` to `done`.
2. Add or refine the `Cross-check` note with the exact verification path.
3. If useful, add a short note below this section describing what landed.
