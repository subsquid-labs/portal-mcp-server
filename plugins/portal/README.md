# SQD Plugin

Query blockchain data across 130+ networks with SQD Portal, including Ethereum, Base, Solana, Polkadot, Bitcoin, Tron, and Hyperliquid. The SQD plugin also includes Pipes SDK and Squid SDK skills for building, migrating, troubleshooting, and improving blockchain data projects.

The plugin uses the public SQD endpoint at `https://portal.sqd.dev/mcp`. No account or login is required.

The packaged server runtime uses stateless HTTP and negotiates MCP 2026-07-28, matching the current Claude rollout. Set `REQUIRE_MCP_2026_LIVE=1` when running the plugin checks after deployment to verify the public endpoint.

It also includes the four official SQD agent skills for Portal, Pipes SDK, Portal migration, and indexer performance. The bundled snapshot comes from `subsquid-labs/skills`; `skills/SOURCE.md` records the upstream commit and the packaging changes made here. The upstream Squid SDK subtree is flattened into two top-level skills so Claude, Codex, Grok, Gemini, and Cursor discover all four skills consistently.

## Data and privacy

- The plugin connects to one MCP server, `https://portal.sqd.dev/mcp`, run by SQD. Each tool call sends that server its arguments, such as network names, addresses, block ranges, and time windows, and the server returns public blockchain data. The plugin sends no credentials, and the server needs no account or API key.
- The skills run on your machine. `squid-perf` runs your installed `sqd` CLI to read logs from your own SQD Cloud deployments and writes its report to your project folder. The report is one HTML file that loads nothing from the network.
- Skills that set up your own indexer or database don't read keys or passwords from your machine. When a step needs one, such as an SQD API key for the v2 gateway or a ClickHouse password, you provide it, and it is used only with that service.
- Skills use your existing tool permissions. They do not pre-approve shell commands, file changes, or web requests.
- Privacy policy: [sqd.dev/imprint](https://sqd.dev/imprint/)

## Name and logo

- The visible name is `SQD` in every client and marketplace.
- The internal package ID remains `portal` so existing installs keep working.
- `assets/sqd-logo.svg` is the white SQD symbol on a black square. Use it in both light and dark themes.
- `assets/sqd-composer-icon.svg` is the same black square with rounded corners for compact views.

## Codex

Register this repository as a local marketplace, then install the plugin:

```bash
codex plugin marketplace add .
codex plugin add portal@sqd
```

Start a new Codex task after installing it.

## Claude Code

```bash
claude plugin marketplace add ./
claude plugin install portal@sqd
```

Start a new Claude Code session after installing it.

## Grok Build

Grok Build accepts the included Claude-compatible package:

```bash
grok plugin install --trust ./plugins/portal
```

For Grok chat, add a Custom connector at `grok.com/connectors` and enter `https://portal.sqd.dev/mcp` with no authentication.

## Gemini CLI

Install SQD from its public GitHub release:

```bash
gemini extensions install https://github.com/subsquid-labs/portal-mcp-server
```

The release archive contains this manifest, the public SQD MCP connection, and the same four skills. No API key or extension setting is required.

## Cursor

Open **Customize** in Cursor, search for `SQD`, and install the plugin for your user or project. Until the public listing is approved, add this repository as a marketplace or link `plugins/portal` as a local plugin.

Cursor loads the public SQD MCP connection and the same four skills. No API key or plugin variable is required.

## Starter prompts

- Show me the last 200 BTC perp fills on Hyperliquid.
- How many transactions landed on Base in the past 2h?
- Show me the latest 20 USDC transfers on Base from the past hour.

## Checks

```bash
npm run test:plugin
npm run test:claude-plugin
npm run test:grok-plugin
npm run test:gemini-extension
npm run test:cursor-plugin
```

The checks validate the name, black logo, listing copy, marketplace files, hosted endpoint, Gemini archive, Cursor package, and Grok compatibility.

For an exact local release candidate, generate a temporary package that keeps every skill and manifest unchanged but points the MCP connection at the current built stdio server:

```bash
npm run build
npm run prepare:client-candidate -- /path/to/empty/temp-directory
```

The generated `candidate.json` records the package digest and the limits of the proof. Do not commit the temporary candidate.

## Public directory submission

See [DIRECTORY_SUBMISSION.md](https://github.com/subsquid-labs/portal-mcp-server/blob/main/distribution/DIRECTORY_SUBMISSION.md) for the exact OpenAI, Claude, xAI, Gemini, and Cursor publication routes, listing copy, review tests, and remaining owner actions. It lives in the repository's `distribution` folder, outside this package.

Do not commit credentials, personal paths, or private endpoints to this package.
