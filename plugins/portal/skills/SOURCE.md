# Official SQD skills snapshot

These skills are bundled from `subsquid-labs/skills` so Codex, Claude, and Grok receive the same maintained guidance alongside the SQD tools.

- Repository: `https://github.com/subsquid-labs/skills`
- Commit: `66aebe851af0258bf9d38c0bc43fcbb33ae7e47d`
- Synced: `2026-09-01`
- The Portal skill is bundled without content changes.

Packaging changes for the Claude plugin directory, which reads every file in the plugin as source:

- `squid-perf/templates/report.html` is the plain HTML document that the upstream bundler wrapper packed, with trailing spaces removed. A built-in canvas renderer (`drawLineChart`) replaces the packed Chart.js copy, so the report still works offline. `squid-perf/scripts/report.mjs` injects the report data into the plain document and escapes every `<` in it, `squid-perf/SKILL.md` describes the template, and the squid-perf tests read the plain document.
- `squid-perf/tests/fixtures/fake-sqd` is renamed `fake-sqd.sh`.
- `pipes-sdk/references/ENVIRONMENT_SETUP.md` links to the official nvm, Bun, and Docker install guides for the user to follow.
- Keys and passwords are left for the user to supply. The v2 gateway key steps in `migrate-to-portal/SKILL.md` and `migrate-to-portal/references/{v2-auth,evm-example-diff,solana-example-diff,common-errors}.md` point to SQD's key guide instead of wiring `SQD_API_KEY` into the squid. `pipes-sdk/references/DEPLOYMENT.md` runs `clickhouse-client` with the container's own settings instead of reading the password out of the container, and has the user run `claude mcp add` and set Railway variables. `pipes-sdk/references/HYPERLIQUID_GUIDE.md` reads its connection settings with local defaults instead of loading `.env` through `dotenv`.

Re-apply these changes on the next sync unless upstream has adopted them.

Bundled skills:

- `portal`
- `pipes-sdk`
- `migrate-to-portal` (upstream path: `squid-sdk/migrate-to-portal`)
- `squid-perf` (upstream path: `squid-sdk/squid-perf`)

The two Squid SDK skills are flattened in this plugin so Codex, Claude, Grok,
Gemini, and Cursor can discover all four skills from one `skills/` directory.
