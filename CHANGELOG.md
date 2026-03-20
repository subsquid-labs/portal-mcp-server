# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.7.1] - 2026-03-20

### Fixed
- Hyperliquid fills: removed `nonce` field that Portal API rejects (all other v0.6.4 fields work correctly)
- `portal_count_events`: added 500-block cap to prevent >100MB crashes on dense chains (Base), returns partial results with notice
- `portal_aggregate_transfers`: reduced block cap from 500 to 200 and capped token grouping to top 20 — unfiltered queries on dense chains exceeded response size limits

### Removed
- `portal_query_hyperliquid_replica_cmds`: dataset not available on Portal API (will re-add when backend is fixed)

## [0.7.0] - 2026-03-20

### Added
- Prometheus metrics endpoint (`GET /metrics`):
  - `mcp_tool_calls_total{tool,status}` — counter of tool invocations (success/error)
  - `mcp_tool_call_duration_seconds{tool}` — histogram of tool call latency
  - `mcp_tool_calls_active{tool}` — gauge of in-flight tool calls
  - `mcp_portal_api_requests_total{method,status_code}` — counter of Portal API requests
  - `mcp_dataset_queries_total{dataset}` — counter of queries per dataset
  - Default Node.js process metrics (CPU, memory, GC, event loop)

## [0.6.0] - 2026-03-16

### Added
- Hyperliquid support: `portal_query_fills`, `portal_query_replica_cmds`
- Dynamic dataset discovery (replaced hardcoded network lists)
- Convenience tools: `portal_get_contract_activity`, `portal_get_gas_analytics`, `portal_get_recent_transactions`, `portal_get_time_series`, `portal_get_top_contracts`, `portal_get_transaction_density`, `portal_get_wallet_summary`
- Aggregation tools: `portal_aggregate_transfers`, `portal_count_events`
- Enrichment: `portal_get_token_info`
- Smoke test (`npm test`) — builds, boots server, calls 3 tools, asserts results
- Release scripts (`npm run release:patch|minor|major`) — bump version, update CHANGELOG, create git tag

### Fixed
- NFT transfers: extract token_id and quantity from ERC1155 TransferSingle data
- Transaction queries: convert hex values to human-readable (wei→ETH, gas→Gwei, hex→decimal)
- Recent transactions and wallet summary: same hex-to-readable conversion
- Decode logs: convert decoded numeric values to decimal strings
- Query logs standard preset: include `data` and `transactionHash` fields
- Transaction density: correctly extract block numbers from `header` subobject
- Time series: chunk large queries to avoid Portal API size limits
- Aggregate transfers: include volume data in results
- Dataset info: correct network_type heuristic (arbitrum-one, arbitrum-nova classified as mainnet)
- List datasets: fix mainnet detection for chains without "mainnet" suffix
- Query blocks: remove `logsBloom` from response (context waste)
- Transaction fields: strip cryptographic noise (`v`, `r`, `s`, `yParity`)

### Changed
- Field presets updated to exclude context-wasting fields by default

## [0.5.4] - 2026-02-XX

### Changed
- Removed `portal_url` from health response
- Version bump

## [0.5.3] - 2026-02-XX

### Changed
- Moved MCP endpoint to root path
- Added `dev:http` script

## [0.5.2] - 2026-02-XX

### Fixed
- Copy node_modules to Docker runtime image

## [0.5.0] - 2025-01-XX

### Added
- `portal_search_datasets` - Search datasets by name or alias
- `portal_get_dataset_info` - Get detailed metadata for a dataset
- `portal_get_block_number` - Get current or finalized block number
- `portal_query_blocks` - Query blocks with field selection
- `portal_query_transactions` - Query transactions with filters
- `portal_query_traces` - Query internal call traces
- `portal_query_state_diffs` - Query storage state changes
- `portal_get_erc20_transfers` - Dedicated ERC20 transfer queries
- `portal_get_nft_transfers` - ERC721/ERC1155 transfer queries
- `portal_query_solana_instructions` - Solana program instruction queries
- `portal_query_solana_balances` - SOL balance change queries
- `portal_query_solana_token_balances` - SPL token balance queries
- `portal_query_solana_logs` - Solana program log queries
- `portal_query_solana_rewards` - Staking/voting reward queries
- `portal_query_paginated` - Pagination support for large queries
- `portal_batch_query` - Parallel query execution
- `portal_decode_logs` - ABI-based event log decoding
- `portal_get_address_activity` - Comprehensive address activity
- `portal_get_token_transfers_for_address` - Address token transfer history
- Automatic retry with exponential backoff
- Rate limit handling (429 responses)
- Chain reorganization detection (409 responses)

### Changed
- Improved error messages with actionable guidance
- Enhanced input validation with Zod schemas

## [0.3.0] - 2025-01-XX

### Added
- Initial public release
- `portal_list_datasets` - List available blockchain datasets
- `portal_get_metadata` - Get dataset metadata
- `portal_get_head` - Get current head block
- `portal_get_finalized_head` - Get finalized head block
- `portal_block_at_timestamp` - Find block at timestamp
- `portal_stream` - Stream blockchain data
- `portal_finalized_stream` - Stream finalized data
- `portal_query_logs` - Query event logs
