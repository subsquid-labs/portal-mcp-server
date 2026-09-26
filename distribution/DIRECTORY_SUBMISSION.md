# SQD Plugin Directory Listings

Public listing copy and publication routes for the SQD plugin in the OpenAI, Claude, Grok, Gemini, and Cursor directories.

This file sits outside `plugins/portal` on purpose. People who install the plugin receive only that folder, so it holds only what the plugin runs and shows. Paths below are relative to the repository root.

## Release automation

- A `v*` tag publishes the matching version to the official MCP Registry and builds the GitHub release with the Gemini extension archive (`sqd.tar.gz`) and the Claude Desktop bundle (`sqd.mcpb`).
- `npm run test:distribution` keeps `package.json`, `server.json`, and the Claude, Codex, Cursor, and Gemini manifests on one version.
- `distribution/targets.json` lists the supported publication routes, and `distribution/submission-packets.json` holds the reusable public copy for each directory.

## Public listing

Name: `SQD`

Developer: `Subsquid Labs`

Category: `Data & Analytics`

Short description:

> Query blockchain data across 130+ networks with SQD Portal.

Long description:

> Query blockchain data across 130+ networks with SQD Portal, including Ethereum, Base, Solana, Polkadot, Bitcoin, Tron, and Hyperliquid. The SQD plugin also includes Pipes SDK and Squid SDK skills for building, migrating, troubleshooting, and improving blockchain data projects.

Starter prompts:

1. Show me the last 200 BTC perp fills on Hyperliquid.
2. How many transactions landed on Base in the past 2h?
3. Show me the latest 20 USDC transfers on Base from the past hour.

Public URLs:

- Website: `https://sqd.dev/portal/`
- Documentation: `https://docs.sqd.dev/en/ai/mcp-server`
- Claude setup guide: `https://docs.sqd.dev/en/ai/claude-connector`
- Claude listing: `https://claude.ai/directory/connectors/sqd`
- Support: `https://sqd.dev/contact/`
- Privacy: `https://sqd.dev/imprint/`
- Terms: `https://cloud.sqd.dev/terms.pdf`
- Public server: `https://portal.sqd.dev/mcp`

Logo: use `https://sqd.dev/brand/Symbol_bl-bg.svg`. It is the canonical white SQD symbol on a black square. The package keeps a local SVG at `plugins/portal/assets/sqd-logo.svg`, a 1024 x 1024 OpenAI directory PNG at `plugins/portal/assets/sqd-directory-icon.png`, and a 256 x 256 ChatGPT composer PNG at `plugins/portal/assets/sqd-chatgpt-composer-icon.png`.

## Claude directory

SQD is published in the Claude Connectors Directory at `https://claude.ai/directory/connectors/sqd`. The public SQD documentation links to that listing and describes the no-login connection flow.

The hosted connector and the plugin are complementary:

- The connector listing connects Claude on web, desktop, and mobile to `https://portal.sqd.dev/mcp`.
- The plugin in `plugins/portal` bundles the same hosted MCP server with the four official SQD skills. It is submitted to the Claude plugin directory as a Plugin bundle from the developer portal at `https://claude.ai/directory/manage`, with `plugins/portal` as the plugin path.

Listing values:

- Server URL: `https://portal.sqd.dev/mcp`
- Transport: Streamable HTTP
- Connection model: one URL for every user
- Authentication: none
- Name: `SQD`
- Tagline: `Query blockchain data across 130+ networks`
- Description: `Query blockchain data across 130+ networks with SQD Portal, including Ethereum, Base, Solana, Polkadot, Bitcoin, Tron, and Hyperliquid.`
- Documentation: `https://docs.sqd.dev/en/ai/claude-connector`
- Privacy: `https://sqd.dev/imprint/`
- Support: `https://sqd.dev/contact/`
- Icon: use the canonical black-background SQD logo
- Setup requirement: no account, login, or API key
- Data handling: SQD's own public read-only blockchain data API; no health data or sponsored content

The hosted endpoint serves the full default catalog. Toolsets (`MCP_TOOLSETS`, `MCP_TOOLS`, `?toolsets=`, `X-MCP-Toolsets`) exist for self-hosted deployments and single connections that want a smaller catalog, and they do not change what the directory listing scans. The Claude Code tool namespace for an install from this package is `mcp__plugin_portal_SQD__<tool-name>`, for example `mcp__plugin_portal_SQD__portal_get_head`. Treat this as client-generated configuration, not part of the public MCP tool name.

### Claude plugin directory

The plugin directory reads its listing from `plugins/portal/.claude-plugin/plugin.json` and `plugins/portal/README.md`:

- Name and description: `displayName` and `description`
- Icon: `icon`, which points at `./assets/sqd-logo.svg`
- Privacy policy: `privacyPolicyUrl`, set to `https://sqd.dev/imprint/`, and the README's Data and privacy section
- License: `license` (`MIT`)

Claude Code's manifest schema does not include `icon` or `privacyPolicyUrl`, so `claude plugin validate --strict` reports both as unknown fields. `npm run test:claude-plugin` strictly validates a copy of the plugin without those two fields and checks their values separately.

The portal validates and scans every file in `plugins/portal`. `npm run test:claude-plugin` keeps the package within these rules:

- Every file is readable text, an SVG, or a PNG image. The squid-perf report template is plain HTML with its own chart code, not a packed or minified bundle.
- No text file names a bundled PNG or font by its path. This file lives outside the plugin folder for that reason.
- Skill references link to official installers instead of piping a downloaded script into a shell.
- No skill command expands a key or password variable, reads one out of a container, or loads `.env` through `dotenv`. Example indexer code reads a password from the environment only with a local default. The v2 gateway key and ClickHouse passwords are left for the user to supply, as the directory's credential rule requires, and the README says so.
- Every text file stays under 256 KiB.

## OpenAI directory

OpenAI uses one Plugins Directory for both ChatGPT and Codex. SQD is submitted as a plugin with MCP through the OpenAI Platform plugin submission portal.

Import the repository-root `chatgpt-app-submission.json` file into the submission form. It covers the public tools, their safety labels and justifications, five positive review tests, and three negative review tests. Every tool declares one shared MCP `outputSchema` (the result envelope: `answer`, `items` or `value`, `error`, `_coverage`, `_pagination`, `_execution`, `_server`, and the other metadata blocks) and returns matching `structuredContent`. The server publishes the schema in `tools/list`.

Submission values:

1. Name: `SQD`.
2. Version: the current release.
3. Directory icon: `plugins/portal/assets/sqd-directory-icon.png`.
4. ChatGPT composer icon: `plugins/portal/assets/sqd-chatgpt-composer-icon.png`.
5. Universal MCP server URL: `https://portal.sqd.dev/mcp`.
6. Authentication: none.
7. Domain challenge URL: `https://portal.sqd.dev/.well-known/openai-apps-challenge`.
8. Website: `https://sqd.dev/portal/`.
9. Support: `https://sqd.dev/contact/`.
10. Privacy: `https://sqd.dev/imprint/`.
11. Terms: `https://cloud.sqd.dev/terms.pdf`.
12. Availability: all supported countries.

After scanning, every tool shows `readOnlyHint: true`, `destructiveHint: false`, and `openWorldHint: true`. The four skill folders from `plugins/portal/skills` are uploaded alongside the prompts and tests below.

Release note for the listing:

> Query blockchain data across 130+ networks with SQD Portal, including Ethereum, Base, Solana, Polkadot, Bitcoin, Tron, and Hyperliquid. The plugin also includes Pipes SDK and Squid SDK skills for building, migrating, troubleshooting, and improving blockchain data projects.

### Positive review tests

| Prompt | Expected tool | Expected result |
|---|---|---|
| Show me the last 200 BTC perp fills on Hyperliquid. | `portal_hyperliquid_query_fills` | The latest 200 BTC fills with time, direction, price, size, and trader fields. |
| How many transactions landed on Base in the past 2h? | `portal_get_time_series` | Time buckets and a total transaction count for Base over the requested period. |
| Show me the latest 20 USDC transfers on Base from the past hour. | `portal_evm_query_token_transfers` | The latest 20 Base USDC transfers with sender, recipient, amount, time, and transaction hash. |
| Which blockchain networks can SQD query? | `portal_list_networks` | A searchable list of supported networks and their availability. |
| Summarize this wallet's activity on Base over the past day. | `portal_get_wallet_summary` | A wallet summary with incoming and outgoing activity, counterparties, and clear coverage. |

### Negative review tests

| Prompt | Expected behavior | Reason |
|---|---|---|
| Send 1 ETH from this wallet. | Explain that SQD is read-only and cannot sign or send transactions. | The plugin never changes blockchain state. |
| Place a Hyperliquid BTC trade for me. | Explain that SQD can retrieve market data but cannot place or sign trades. | The plugin does not execute market actions. |
| Predict the BTC price tomorrow. | Explain that SQD provides historical and live data, not financial predictions. | A prediction would go beyond the plugin's data tools. |

## Grok Build marketplace

xAI accepts third-party plugins through a pull request to `xai-org/plugin-marketplace`. The entry uses a remote source that points to this public repository and pins the exact merged commit:

```json
{
  "name": "sqd",
  "description": "Query blockchain data across 130+ networks with SQD Portal, including Ethereum, Base, Solana, Polkadot, Bitcoin, Tron, and Hyperliquid. The SQD plugin also includes Pipes SDK and Squid SDK skills for building, migrating, troubleshooting, and improving blockchain data projects.",
  "category": "development",
  "source": {
    "source": "url",
    "url": "https://github.com/subsquid-labs/portal-mcp-server.git",
    "sha": "FULL_MERGED_COMMIT_SHA",
    "path": "plugins/portal"
  },
  "homepage": "https://sqd.dev/portal/",
  "keywords": [
    "sqd",
    "subsquid",
    "sqd blockchain",
    "sqd blockchain data",
    "sqd hyperliquid",
    "sqd tron",
    "sqd portal"
  ],
  "domains": [
    "sqd.dev",
    "portal.sqd.dev",
    "docs.sqd.dev"
  ]
}
```

The marketplace's own scripts regenerate and validate the catalog index before the pull request is opened:

```bash
python3 scripts/generate-plugin-index.py
python3 scripts/validate-catalog.py
python3 scripts/generate-plugin-index.py --check
```

## Grok chat

Grok chat accepts SQD as a Custom connector using `https://portal.sqd.dev/mcp` with no authentication. xAI does not currently document a public submission route for its consumer connector catalog.

## Gemini CLI extension gallery

Gemini CLI installs the `sqd.tar.gz` release asset. The archive keeps `gemini-extension.json` at its root and includes the same four official SQD skills from `plugins/portal/skills`.

1. `npm run test:gemini-extension` validates the manifest.
2. `npm run package:gemini` builds `dist/gemini/sqd.tar.gz`.
3. The archive is uploaded to the matching GitHub release; the release workflow does this on every `v*` tag.
4. The repository carries the `gemini-cli-extension` GitHub topic, which the gallery indexes daily. No separate submission is required.

The extension identifier is `sqd` because Gemini requires lowercase names. The public product name remains `SQD` in the repository, description, documentation, and MCP server name.

## Cursor Marketplace

The repository-root `.cursor-plugin/marketplace.json` points at `plugins/portal`. The Cursor manifest in that folder reuses the existing `skills/`, `.mcp.json`, and black SQD logo without copying them.

Listing values:

- Display name: `SQD`
- Plugin identifier: `sqd`
- Repository: `https://github.com/subsquid-labs/portal-mcp-server`
- Website: `https://sqd.dev/portal/`
- Documentation: `https://docs.sqd.dev/en/ai/mcp-server`
- Support: `https://sqd.dev/contact/`
- Logo: `plugins/portal/assets/sqd-logo.svg`
- Authentication: none
- Components: one read-only MCP server and four skills
- Short description: `Query blockchain data across 130+ networks with SQD Portal.`
- Long description: `Query blockchain data across 130+ networks with SQD Portal, including Ethereum, Base, Solana, Polkadot, Bitcoin, Tron, and Hyperliquid. The SQD plugin also includes Pipes SDK and Squid SDK skills for building, migrating, troubleshooting, and improving blockchain data projects.`

`npm run test:cursor-plugin` validates the package before it is submitted at `https://cursor.com/marketplace/publish`.
