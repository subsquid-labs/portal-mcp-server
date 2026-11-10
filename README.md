# SQD Portal MCP Server

[![SQD Portal MCP server](https://glama.ai/mcp/servers/subsquid-labs/portal-mcp-server/badges/score.svg)](https://glama.ai/mcp/servers/subsquid-labs/portal-mcp-server)

An MCP server that answers blockchain questions from [SQD Portal](https://portal.sqd.dev) data: transactions, logs, traces, token transfers, wallets, analytics, time series, and candles across EVM, Solana, Bitcoin, Substrate, Hyperliquid, and Tron networks, with an optional in-host Explorer.

The server does not index chains itself. It validates input, plans bounded Portal queries, and returns results with coverage, freshness, pagination, and evidence metadata so an assistant can say exactly what it saw. No SQD account, API key, or client credential is required.

It speaks the stateless MCP `2026-07-28` protocol over HTTP and stdio and keeps the SDK-managed legacy negotiation path for clients still rolling out that revision. Release notes are in [CHANGELOG.md](CHANGELOG.md). See `CONTRIBUTING.md` to work on the code and `SECURITY.md` to report a vulnerability.

## Current public surface

- `28` public tools
- `3` advanced/debug tools
- public params use `network`
- discovery filters use `vm`
- no legacy tool aliases in `v0.8.x`

Raw query tools default to compact responses. Ask for `response_format: "full"` only when you need the larger payload.

Entity questions can use `portal_resolve_entity` first. It resolves EVM token symbols/addresses, EVM contract aliases, pool identifiers, protocol names, and Hyperliquid coin names into query-ready filters while keeping ambiguous matches explicit.

Token symbol resolution and token metadata come from open token-list data, not baked-in token address constants. Responses include explicit notices when token-list data is unavailable, stale, or unsupported for a network.

Wallet questions should start with `portal_get_wallet_summary`. It returns `fund_flow` by default, including inbound/outbound movement, asset flows, counterparties, largest observed movements, and next evidence pivots before raw-tool drill-down.

## Tool groups

Discovery:
- `portal_list_networks`
- `portal_get_network_info`
- `portal_get_head`
- `portal_resolve_entity`

Cross-chain convenience:
- `portal_get_recent_activity`
- `portal_get_wallet_summary`
- `portal_get_time_series`

EVM:
- `portal_evm_query_transactions`
- `portal_evm_query_logs`
- `portal_evm_query_traces`
- `portal_evm_query_token_transfers`
- `portal_evm_get_contract_deployment`
- `portal_evm_get_contract_activity`
- `portal_evm_get_analytics`
- `portal_evm_get_ohlc`

Solana:
- `portal_solana_query_transactions`
- `portal_solana_query_instructions`
- `portal_solana_get_analytics`

Bitcoin:
- `portal_bitcoin_query_transactions`
- `portal_bitcoin_get_analytics`

Substrate:
- `portal_substrate_query_events`
- `portal_substrate_query_calls`
- `portal_substrate_get_analytics`

Hyperliquid:
- `portal_hyperliquid_query_fills`
- `portal_hyperliquid_get_analytics`
- `portal_hyperliquid_get_ohlc`

Tron:
- `portal_tron_query_transactions`
- `portal_tron_query_logs`

Advanced/debug:
- `portal_debug_query_blocks`
- `portal_debug_resolve_time_to_block`
- `portal_debug_hyperliquid_query_replica_commands`

These groups are also the toolsets (`discovery`, `convenience`, `evm`, `solana`, `bitcoin`, `substrate`, `hyperliquid`, `tron`, `debug`). A deployment can trim the catalog with `MCP_TOOLSETS` or `MCP_TOOLS`, and an HTTP connection can narrow it further with `?toolsets=` or an `X-MCP-Toolsets` header; see the HTTP deployment notes. With nothing configured the full 31-tool surface is served, and the hosted endpoint keeps that default.

## Supported data

- EVM networks indexed by Portal, including Base, Ethereum, Optimism, Arbitrum, Monad, Hyperliquid EVM, and many others
- Tron native transactions (TRX transfers, TRC-10 transfers, contract calls with inline logs and internal transactions) and TVM event logs such as TRC-20 transfers, with Base58 or hex addresses, exact TRX amounts, and the parent transaction hash on every log; the bundled SQD plugin skill documents the raw Stream API for anything beyond that
- Solana mainnet
- Bitcoin mainnet
- Hyperliquid fills and replica commands
- Substrate networks indexed by Portal

Substrate support is currently historical only. It does not have a real-time tail.

## Response shape

Most tools return the same envelope in MCP `structuredContent` and in a compact JSON text fallback for older clients. The envelope contains a normal result body plus shared metadata such as:

- `answer`
- `display`
- `next_steps`
- `investigation`
- `_freshness`
- `_coverage`
- `_pagination`
- `_ordering`

`investigation` is a compact evidence guide for agents: it identifies the primary result path, bounded window, useful pivot fields such as addresses or transaction hashes, follow-up filters, and limitations before a result is treated as complete. Successful material results also carry an `_evidence` receipt with canonical arguments, a deterministic digest, row reconciliation, source windows, and either exact or semantic replay semantics. Exact receipts pin their evidence window. Semantic receipts disclose that rerunning a moving relative window can return a newer snapshot.

When a response uses estimated, partial, sampled, capped, or paginated data, the top-level answer and metadata disclose it. `_pagination.has_more` is true exactly when `next_cursor` is present, and `_coverage` states whether the requested window was read through (`window_complete`) and whether the response holds every matching row (`result_complete`). Safe pagination follow-ups include executable tool-call metadata with explicit cursor arguments; suggestions that cannot be reconstructed safely are marked non-executable.

Chart-oriented tools also return chart and table descriptors so MCP clients or LLMs can render them without reverse-engineering the payload.

## SQD Explorer (beta)

SQD Explorer is an MCP App that renders tool results inside hosts that support MCP Apps. It is in beta and off by default. A default deployment answers with `structuredContent` and compact JSON text only, and no tool result asks a host to open a UI. There are two ways to opt in:

- One connection: add `?app=1` to the endpoint, for example `https://portal.sqd.dev/mcp?app=1`. Use this to try the beta without changing anything for other users.
- Whole deployment: set `MCP_APP_ENABLED=true`. A connection can still override it in either direction, so `?app=0` opts a single client back out.

The app resource stays registered either way, so a host can read it directly without anyone opting in.

When it is enabled, compatible hosts receive an inline card sized to its content and a full-screen workspace for 21 data tools: metrics led by the primary number, multi-series and signed-value charts, price candles with linked volume and a fixed readout, ranked and timeline panels that show ten rows with a Show all control, evidence tables that page ten rows with search across every row, explorer links for addresses, hashes, and blocks, chain logos and names from SQD network metadata, continuation controls, current-session history, and JSON or CSV export through the host. Pointer and keyboard inspection expose exact plotted values. Missing buckets remain visible as gaps, identifiers stay unshortened, and any local row cap is separate from server completeness. Failed follow-ups keep the last good result under the error. The app is self-contained and does not use persistent browser storage; its only browser-side requests are chain logo images from `cdn.subsquid.io` and `sqd.dev`, the two origins declared in the resource CSP. Hosts without MCP App support receive the same `structuredContent` and compact JSON text fallback, so the underlying answer never depends on the UI. `docs/explorer-design.md` records the design rules the app follows.

Three MCP prompts provide reproducible starting points without adding tools:

- `investigate-wallet`
- `investigate-contract`
- `investigate-market`

For a chart-first demo, ask: `Show BTC price action and trading volume on Hyperliquid for the past hour, using five-minute candles. Explain whether the final candle is closed.` The result opens the SQD Explorer with a candle chart, volume, an evidence table, requested and indexed time bounds, and a receipt. Replay the returned `requested_window_start_timestamp` and `requested_window_end_exclusive` as fixed `from_timestamp` and `to_timestamp` inputs when you need a stable verification run.

### Try it in Claude

The hosted endpoint has the Explorer off, so a new user opts their own connection in:

1. In claude.ai or Claude Desktop, open **Settings → Connectors → Add custom connector**, enter `https://portal.sqd.dev/mcp?app=1`, and choose no authentication. The `?app=1` turns the beta on for this connection only. On Claude Desktop you can instead install `sqd.mcpb` from the latest release and switch on its "SQD Explorer (beta)" setting.
2. Start a new chat and enable the SQD connector for it.
3. Ask a data question. Any of these lands on a tool that carries the Explorer:
   - `What has this wallet been doing on Base lately?` with an address (wallet summary)
   - `Show me recent activity on Ethereum` (recent activity)
   - `Chart transaction counts on Base for the last 15 minutes in five-minute buckets` (time series)

The result renders as an inline card instead of a block of text; open the card for the full-screen workspace. Only the 21 data tools carry the Explorer. A catalogue question such as `Which networks do you support?` calls `portal_list_networks` and answers in plain text, which is expected rather than a failure.

## Install

```bash
npm install
npm run build
```

## Run

stdio:

```bash
npm start
```

HTTP:

```bash
npm run start:http
```

## Developer discovery

The server exposes a structured tool-selection guide for client builders:

- MCP resource `sqd://tools` returns grouped tool metadata, examples, starting points, and integration notes.
- MCP resource `sqd://tools/{name}` returns the guide entry for one tool, for example `sqd://tools/portal_get_time_series`.

Tool and resource discovery stays on the MCP protocol itself. The server does not maintain a duplicate HTTP catalog.

## Codex plugin

The Codex plugin wrapper lives in `plugins/portal` and defaults to the hosted MCP endpoint at `https://portal.sqd.dev/mcp`.

Install it from this repo-local marketplace:

```bash
codex plugin marketplace add .
codex plugin add portal@sqd
```

Open a new Codex thread after installing. First-use prompts include Hyperliquid BTC perp fills, recent Base transaction volume, and the latest USDC transfers on Base.

## Claude Code plugin

The Claude Code plugin uses the same hosted MCP endpoint and the same public selector:

```bash
claude plugin marketplace add subsquid-labs/portal-mcp-server
claude plugin install portal@sqd
```

Open a new Claude Code session after installing so the SQD MCP tools are loaded.

## Grok

Grok chat can use SQD as a custom connector:

1. Open `grok.com/connectors`.
2. Choose **New Connector**, then **Custom**.
3. Enter `https://portal.sqd.dev/mcp` as the MCP server URL.
4. Leave authentication unset.

Grok Build reads Claude Code plugins directly, so it uses the same package:

```bash
grok plugin install --trust subsquid-labs/portal-mcp-server#plugins/portal
```

## ChatGPT

In a workspace with custom MCP apps enabled, open **Settings → Apps → Create**, enter `https://portal.sqd.dev/mcp`, choose no authentication, scan the tools, and create the draft app. The server is read-only and does not require user credentials.

## Claude Desktop

Download `sqd.mcpb` from the [latest release](https://github.com/subsquid-labs/portal-mcp-server/releases/latest) and open it: Claude Desktop installs the bundle with one click and lists the 31 tools. The bundle carries the server, its production dependencies, and one optional setting, "SQD Explorer (beta)", which is off by default. It needs Node 22 or newer on the machine.

Manual fallback, from a local clone after `npm run build`, add an entry like this to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "SQD": {
      "command": "node",
      "args": ["/absolute/path/to/sqd-portal-mcp-server/dist/index.js"]
    }
  }
}
```

## Usage notes

- If you do not know the exact network name, start with `portal_list_networks`.
- If you need recent indexed state, use `portal_get_network_info` or `portal_get_head` first.
- If the question is broad, start with `portal_get_recent_activity`, `portal_get_wallet_summary`, or `portal_get_time_series` before dropping to raw queries.
- Time windows accept compact and natural wording such as `30m`, `past 30 minutes`, `in the past 1h`, `in last 38 mins`, `last hour`, or `30 minutes ago`.
- Use `portal_evm_get_ohlc` and `portal_hyperliquid_get_ohlc` only when you actually need candle-shaped output.
- For large or exploratory queries, prefer `response_format: "compact"` unless you need the full record shape.

## HTTP Deployment Notes

HTTP mode exposes MCP at `/` and `/mcp`, liveness at `/health`, and readiness at `/ready`. The hosted service exposes the same versioned health response at `https://portal.sqd.dev/mcp/health`.

- MCP and health endpoints do not require authentication.
- Tool and resource discovery use the MCP protocol; retired `/tools` and `/tools.json` routes return `404`.
- Set `MCP_CURSOR_SECRET` on any deployment running more than one process, so a cursor one instance issues is accepted by the next. Unset, each process signs with its own random key, and a cursor stops working across a restart or a load-balanced hop.
- `/health` reports `version` and `commit`, the git commit the image was built from, and every tool result repeats both in `_server`. Docker Hub tags: `latest`, `X.Y.Z`, and `X.Y` come only from a `v*` release tag; `edge` and `sha-<commit>` come from every `main` push. Pin a version tag in production.
- `/ready` is `200` only after the dataset catalog has loaded once and the latest Portal probe succeeded within `MCP_READY_MAX_AGE_MS`; otherwise it is `503` with a `reason` and `Retry-After`. Point orchestrator readiness checks at `/ready` and liveness checks at `/health`. The Docker image's `HEALTHCHECK` uses `/ready`.
- The server binds `127.0.0.1` unless `MCP_BIND` says otherwise, and every route checks the `Host` header (and `Origin`, when a browser sends one) against an allowlist, so a DNS-rebound page cannot reach a local instance. Loopback hosts and origins always pass; requests without `Origin` always pass the origin check. A non-loopback bind must set `MCP_ALLOWED_HOSTS` and `MCP_ALLOWED_ORIGINS`; if either is missing the server logs a startup error and serves without that check. The Docker image sets `MCP_BIND=0.0.0.0`, so set both variables in the deployment, or `*` behind a proxy that already validates them.
- Every request is bounded: headers within `MCP_HEADERS_TIMEOUT_MS`, the whole request within `MCP_REQUEST_TIMEOUT_MS`, idle keep-alive within `MCP_KEEP_ALIVE_TIMEOUT_MS`, and MCP bodies above `MCP_MAX_BODY_BYTES` are refused with `413` before parsing (`411` for a chunked body with no length).

Useful environment variables:

- `MCP_CURSOR_SECRET` the key pagination cursors are signed with. **Set it on any deployment running more than one process.** Unset, each process signs with its own random key, so a cursor issued by one instance is rejected by the next and clients lose their place across a restart or a load-balanced hop. It is also what stops a caller minting a cursor for a window the tool would never have offered.
- `MCP_TOOLSETS` comma-separated toolsets to serve (`discovery`, `convenience`, `evm`, `solana`, `bitcoin`, `substrate`, `hyperliquid`, `tron`, `debug`; `all` or `default` for everything). Unknown names are ignored with a startup error. Wins over `MCP_TOOLS`. Default: all nine, the full 31-tool catalog.
- `MCP_TOOLS` comma-separated exact tool names to serve when `MCP_TOOLSETS` is unset.
- Per connection, `?toolsets=evm` on the endpoint URL or an `X-MCP-Toolsets: evm` header narrows the deployment's set for that connection only; it can never add a toolset. Prompts that reference a tool outside the active set are not offered. The active set is a bounded label (`all`, one toolset name, or `custom`) on `mcp_tool_client_calls_total`.
- `MCP_BIND` interface to listen on, default `127.0.0.1` (`0.0.0.0` in the Docker image)
- `MCP_ALLOWED_HOSTS` comma-separated hostnames accepted in `Host` (port ignored) on top of loopback; `*` disables the check. Required for a non-loopback bind.
- `MCP_ALLOWED_ORIGINS` comma-separated hostnames accepted in `Origin` on top of loopback; `*` disables the check. Required for a non-loopback bind.
- `MCP_REQUEST_TIMEOUT_MS`, `MCP_HEADERS_TIMEOUT_MS`, `MCP_KEEP_ALIVE_TIMEOUT_MS` request timing bounds, defaults `120000`, `30000`, `65000`
- `MCP_MAX_BODY_BYTES` MCP request body cap, default `1048576`
- `MCP_READY_PROBE_INTERVAL_MS` and `MCP_READY_MAX_AGE_MS` readiness probe cadence and freshness, defaults `30000` and `90000`
- `MCP_APP_ENABLED` to offer the beta SQD Explorer to compatible hosts, default off. Accepts `true` or `1`. Per-connection `?app=1` and `?app=0` override it.
- `MCP_TOOL_WEIGHT_BUDGET` to bound the combined cost of active tool calls, default `32`. Measured profiles allow up to 32 lookups, 4 raw or summary calls, or 2 analytics calls at once while queued work remains cancellation-aware.
- `MCP_TOOL_MAX_QUEUE` to bound queued tool calls, default `64`
- `MCP_TOOL_QUEUE_TIMEOUT_MS` to bound tool admission wait time, default `5000`
- `MCP_TOOL_CLIENT_WEIGHT_SHARE` percent of the weight budget one caller (one connection, identified by a hashed address) may hold at once, default `50`; never below the heaviest single tool so every tool stays schedulable. `MCP_TOOL_CLIENT_MAX_QUEUE` bounds one caller's queued calls, default `16`. A caller over its share gets the retryable `overloaded` result with `reason: client_share` while others keep flowing.
- `MCP_TRUST_PROXY` set to `1` (or to the number of proxies in front of the server) to key fairness on the address those proxies observed instead of the socket address. The header is read only when the immediate peer is itself a trusted proxy, and the hop is counted from the right of `X-Forwarded-For`, because a caller can write anything to the left of it. The address is hashed and never stored or labelled.
- `MCP_TRUSTED_PROXY_PREFIXES` a comma-separated list of address prefixes that count as your proxies, matched against the start of the peer address (for example `203.0.113.` or `2606:4700:`). Setting it **replaces** the default rather than adding to it, so include loopback or your private range if a co-located proxy also reaches the server. With it unset, loopback and private ranges are trusted, which is where a co-located proxy sits; on a shared private network that means any host on that network can present a forwarded address, so name your proxies explicitly there.
- `MCP_SLOW_REQUEST_MS` threshold for one JSON line on stderr per slow tool call with admission wait and execution timings and the bounded client family, default `5000`.

### Cost guardrails

Every scan bound in the server is compiled in and set per tool: a filtered trace
scan stops at 5,000 blocks, a contract-deployment search at 1,000,000. Guardrails
add a second ceiling above those that a deployment sets from the environment, so
an endpoint under load can be turned down without a new image.

- `MCP_GUARDRAIL_MODE` one of `off` (default), `shadow`, or `enforce`.
- `MCP_GUARDRAIL_<CLASS>_<LIMIT>` sets one ceiling, where `<CLASS>` is
  `LOOKUP`, `RAW_QUERY`, `SUMMARY`, or `ANALYTICS`, and `<LIMIT>` is
  `MAX_SCAN_BLOCKS`, `MAX_WINDOW_SECONDS`, or `MAX_UPSTREAM_BYTES`. For example
  `MCP_GUARDRAIL_RAW_QUERY_MAX_SCAN_BLOCKS=50000`.

**There are no numeric defaults.** A class with nothing set has no extra ceiling,
so `off` and `enforce` with nothing configured are the same server. The only way a
guardrail changes behaviour is if you set a number.

`shadow` evaluates every ceiling and records what enforcing would have done,
without changing a single response. `enforce` acts:

- A scan over its ceiling stops at the ceiling and reports what it covered
  through the same partial-coverage path a scan that hits its compiled bound
  already uses, so `_coverage.result_complete` becomes `false` and the response
  names the blocks it searched. It never claims a complete answer it did not get.
- A query window over its ceiling is refused before anything is fetched, with the
  cap named in the error and the next steps, because there is no partial result
  to return for a request that was never allowed to start.

Four counters, all with bounded labels: `mcp_guardrail_admitted_total{class}`,
`mcp_guardrail_would_block_total{class,limit}`,
`mcp_guardrail_blocked_total{class,limit}`, and
`mcp_guardrail_fail_open_total{reason}`.

**Recommended rollout.** Set the ceilings you are considering and run `shadow` for
a week. Read `mcp_guardrail_would_block_total`: it is exactly the set of real
requests the ceiling would have cut. If that set is larger than you expected, the
ceiling is wrong, not the traffic. Move to `enforce` once it is the size you
intended.

### Traces

Metrics say how often and how long; a trace says where the time went inside one
call. Traces are off unless you set `OTEL_EXPORTER_OTLP_ENDPOINT`. With it unset
nothing here is imported, allocated, or sent, and the OpenTelemetry packages need
not be installed at all.

The SDK is not a dependency of this package. It and its exporter pull about 74
packages against a published tarball of roughly 3.4MB, and almost nobody running
this over stdio wants any of it, so they are declared as optional peers. To turn
traces on, install them alongside the server and point it at your collector:

```bash
npm i @opentelemetry/sdk-node @opentelemetry/exporter-trace-otlp-http
```

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://collector:4318
```

One tool call is one tree:

```
mcp.request                       (HTTP only: method, transport)
└─ tools/call portal_evm_query_logs
   ├─ mcp.admission               (the wait for a slot)
   ├─ portal.fetch                (one per attempt: dataset, status, bytes, resend count)
   ├─ portal.fetch
   └─ mcp.format_result           (hashing the answer for the evidence receipt)
```

`OTEL_*` variables are read by the OpenTelemetry SDK itself, so sampling,
headers, batching, and protocol are configured the standard way. The rest:

- A `traceparent` on the HTTP request, or in the tool call's `_meta`, makes the
  call part of the caller's trace rather than starting a new one. The `_meta`
  value wins, because it is the more specific claim about which turn this call
  belongs to.
- Each Portal request carries a `traceparent` naming its own fetch span, so a
  Portal-side trace can join this one. Nothing is added when tracing is off.
- The JSON log lines carry `trace_id` and `span_id` while tracing is on, so a log
  event and its span can be looked up from each other.
- `/health` reports whether tracing is configured, whether it started, and whether
  argument capture is on.

**Span attributes carry no arguments, addresses, hashes, cursors, or free text.**
They are the tool name, its work class, the dataset, bounded counts, and a bounded
outcome. A span leaves the process for a collector the query itself never reaches,
so the rule is the one the metric labels follow, and stricter than the logs, which
at least stay on your own stderr. `MCP_OTEL_INCLUDE_ARGS=1` adds the raw tool
arguments to the tool span. It is off by default and **unsafe for production**: a
tool argument is routinely a wallet address, and often a user's own words.

## Tests

`npm run test:offline` builds, lints, typechecks, runs the unit tests, and runs every suite that needs no Portal access. `npm run test:live` runs the Portal-backed suites. [RELEASE_ASSURANCE.md](RELEASE_ASSURANCE.md) summarises what a release verifies, and [scripts/README.md](scripts/README.md) lists every suite.

## License

[MIT](LICENSE)
