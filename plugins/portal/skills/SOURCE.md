# Official SQD skills snapshot

These skills are bundled from `subsquid-labs/skills` so Codex, Claude, and Grok receive the same maintained guidance alongside the SQD tools.

- Repository: `https://github.com/subsquid-labs/skills`
- Commit: `c51e993d74c06d2d6eda798a7e1283ae93001320`
- Synced: `2026-11-10`
- The Portal skill keeps the upstream guidance and omits tool pre-approvals.

Packaging changes for the Claude plugin directory, which reads every file in the plugin as source:

- `squid-perf/templates/report.html` is the plain HTML document that the upstream bundler wrapper packed, with trailing spaces removed. A built-in canvas renderer (`drawLineChart`) replaces the packed Chart.js copy, so the report still works offline. `squid-perf/scripts/report.mjs` injects the report data into the plain document and escapes every `<` in it, `squid-perf/SKILL.md` describes the template, and the squid-perf tests read the plain document.
- `squid-perf/tests/fixtures/fake-sqd` is renamed `fake-sqd.sh`.
- `pipes-sdk/references/ENVIRONMENT_SETUP.md` links to the official nvm, Bun, and Docker install guides for the user to follow.
- Keys and passwords are left for the user to supply. The v2 gateway key steps in `migrate-to-portal/SKILL.md` and `migrate-to-portal/references/{v2-auth,evm-example-diff,solana-example-diff,common-errors}.md` point to SQD's key guide instead of wiring `SQD_API_KEY` into the squid. `pipes-sdk/references/DEPLOYMENT.md` runs `clickhouse-client` with the container's own settings instead of reading the password out of the container, and has the user run `claude mcp add` and set Railway variables. `pipes-sdk/references/HYPERLIQUID_GUIDE.md` and `pipes-sdk/references/CLICKHOUSE_ANALYTICS.md` use explicit local development connection settings without reading existing passwords.
- The `portal` and `pipes-sdk` skills omit `allowed-tools` so shell commands, edits, and web requests follow the user's normal tool permissions.
- `portal/references/setup.md` and `pipes-sdk/references/CREDENTIALS.md` leave credential configuration and authentication checks for the user. Local database examples use explicit development settings instead of reading saved keys or passwords. New integrations and deployments require authorization for that action.
- The dataset mapping records the 106 public datasets returned on 2026-11-10, including 34 with real-time support, and directs availability questions to live discovery. Skill descriptions avoid a fixed network count.
- Pipes release guidance records npm SDK beta.11 and CLI beta.3 as of 2026-11-10. `pipes-sdk/references/COMPATIBILITY.md` covers the Pub/Sub migration, RPC latency semantics, Portal 529 responses, and EVM field compatibility. The beta.6 BigQuery audit remains explicitly versioned.
- The Hyperliquid ClickHouse examples label loss-based selections as large losing closes. Portal fills do not identify liquidations, so those rows cannot establish liquidation counts or volume.
- Refreshed prose uses plain punctuation and omits decorative symbols. The local Tron reference retains exact amount units and MCP-specific coverage guidance.

Re-apply these changes on the next sync unless upstream has adopted them.

Bundled skills:

- `portal`
- `pipes-sdk`
- `migrate-to-portal` (upstream path: `squid-sdk/migrate-to-portal`)
- `squid-perf` (upstream path: `squid-sdk/squid-perf`)

The two Squid SDK skills are flattened in this plugin so Codex, Claude, Grok,
Gemini, and Cursor can discover all four skills from one `skills/` directory.
