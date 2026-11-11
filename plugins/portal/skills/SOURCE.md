# Official SQD skills snapshot

These skills are bundled from `subsquid-labs/skills` so Codex, Claude, and Grok receive the same maintained guidance alongside the SQD tools.

- Repository: `https://github.com/subsquid-labs/skills`
- Release: `v1.1.0`
- Commit: `d8f9b7293a8854aaaf136ebc79bc156fd87a6ba7`
- Synced: `2026-11-11`
- Skill versions: `portal` 1.6.5, `pipes-sdk` 1.6.5, `migrate-to-portal` 1.2.3, `squid-perf` 1.1.15

Packaging changes for the Claude plugin directory, which reads every file in the plugin as source:

- `squid-perf/templates/report.html` is the plain HTML document that the upstream bundler wrapper packed, with trailing spaces removed. A built-in canvas renderer (`drawLineChart`) replaces the packed Chart.js copy, so the report still works offline. `squid-perf/scripts/report.mjs` injects the report data into the plain document and escapes every `<` in it, and the squid-perf tests read the plain document.
- `squid-perf/tests/fixtures/fake-sqd` is renamed `fake-sqd.sh`.
- `pipes-sdk/references/ENVIRONMENT_SETUP.md` links to the official nvm and Docker install guides for the user to follow, and starts local databases with explicit development settings.
- Keys and passwords are left for the user to supply. The v2 gateway key steps in `migrate-to-portal/references/{v2-auth,evm-example-diff,common-errors}.md` point to SQD's key guide instead of wiring `SQD_API_KEY` into the squid, and the dedicated Portal note in `migrate-to-portal/SKILL.md` leaves the key with the user. `pipes-sdk/references/DEPLOYMENT.md` runs `clickhouse-client` with the container's own settings instead of reading the password out of the container, and has the user run `claude mcp add` and set Railway variables. `pipes-sdk/references/HYPERLIQUID_GUIDE.md`, `pipes-sdk/references/CLICKHOUSE_ANALYTICS.md`, and `pipes-sdk/references/PATTERNS.md` use explicit local development connection settings without reading existing passwords.
- The `portal` and `pipes-sdk` skills omit `allowed-tools` so shell commands, edits, and web requests follow the user's normal tool permissions.
- `portal/references/setup.md` applies only the setup the user asked for, skips adding a second MCP server when the SQD plugin already connects one, and leaves key configuration and the key check for the user. `pipes-sdk/references/CREDENTIALS.md` does the same for indexer credentials. New integrations and deployments require authorization for that action.
- `portal/references/tron.md` describes the Tron MCP tools without pinning a server version and keeps the exact TRX and TRC-10 amount units.
- The Hyperliquid ClickHouse examples label loss-based selections as large losing closes. Portal fills do not identify liquidations, so those rows cannot establish liquidation counts or volume.
- `pipes-sdk/references/PATTERNS.md` describes the RPC latency watcher output as published in `@subsquid/pipes@1.0.0-beta.11`: `url`, `receivedAt`, and `portalDelayMs` sit on each `RpcObservation` in `sample.rpc`, and unresolved observations carry no delay.
- Wrong and right examples are labelled in words instead of check and cross symbols, and warning callouts drop the warning sign.

Upstream adopted the rest of the earlier local changes in v1.1.0: the network count, the dataset catalog and retirement list, the Pipes SDK beta.11 and CLI beta.3 notes, and the Pub/Sub, Portal 529, and EVM field compatibility notes. The separate `pipes-sdk/references/COMPATIBILITY.md` is gone because those facts now live in `SDK_FEATURES.md`, `TROUBLESHOOTING.md`, and `BIGQUERY_TARGET.md`, with the latency notes in `PATTERNS.md`.

Re-apply these changes on the next sync unless upstream has adopted them.

Bundled skills:

- `portal`
- `pipes-sdk`
- `migrate-to-portal` (upstream path: `squid-sdk/migrate-to-portal`)
- `squid-perf` (upstream path: `squid-sdk/squid-perf`)

The two Squid SDK skills are flattened in this plugin so Codex, Claude, Grok,
Gemini, and Cursor can discover all four skills from one `skills/` directory.
