# SQD Plugin

This directory contains the Codex and Claude Code plugin package for SQD. Query live blockchain
and onchain data across Hyperliquid, Bitcoin, Solana, EVM, Substrate, Tron, and hundreds of Portal
datasets through the hosted SQD Portal MCP endpoint and bundled Portal and Pipes SDK agent skills.

The plugin release version is independent from the hosted MCP server version. Plugin `0.8.0` uses
the current unauthenticated hosted MCP server and does not require the unreleased server `0.8.0`
authentication work.

The first distribution target is the repo-local marketplace in `.agents/plugins/marketplace.json`.
The marketplace entry points at this plugin with the stable source path `./plugins/portal`,
so the repository root is the marketplace root.

## Presentation

The plugin uses official SQD brand assets from `https://sqd.dev/brand/`:

- `assets/sqd-logo.svg` is the black-background SQD symbol used for light-mode plugin surfaces.
- `assets/sqd-logo-dark.svg` is the white-background SQD symbol used for dark-mode plugin surfaces.
- `assets/sqd-composer-icon.svg` keeps the black SQD symbol but rounds the square for small prompt
  and composer previews.

The default logo matches the GitHub-style SQD profile picture. Keep the original colors and
proportions intact for plugin detail surfaces, and use the trimmed composer icon for compact
preview rows where the app does not apply the same outer corner treatment.

## Codex Install From This Repo

Register the repo-local marketplace once:

```bash
codex plugin marketplace add .
```

Then install the plugin from the marketplace name in `.agents/plugins/marketplace.json`:

```bash
codex plugin add portal@sqd
```

Open a new Codex task after installing so Codex picks up the plugin skills and MCP server. Codex
may ask you to approve an `SQD` MCP tool call. The hosted endpoint does not require an API key or
sign-in.

## Claude Code Install From This Repo

Register the Claude Code marketplace once:

```bash
claude plugin marketplace add ./
```

Then install the plugin from the marketplace name in `.claude-plugin/marketplace.json`:

```bash
claude plugin install portal@sqd
```

Open a new Claude Code session after installing so the plugin MCP server is loaded.

## First-use Prompts

The Codex plugin exposes these starter prompts. The same prompts are documented for Claude Code:

- Show me up to 200 BTC perp fills on Hyperliquid from the past hour.
- How many transactions landed on Base in the past 2h?
- Show me the 20 most recent USDC transfers on Base from the past hour.

These prompts are release-gated against their intended hosted MCP tools. Keep the manifest prompts
and `scripts/plugin-prompt-cases.ts` in sync.

## Bundled Skills

The plugin bundles exact copies of these directories from
[`subsquid-labs/skills`](https://github.com/subsquid-labs/skills):

- `portal`
- `pipes-sdk`

The upstream Git tree hashes and skill versions are recorded in `skills-upstream.json`. To refresh
or check the bundle against a sibling checkout of the skills repository:

```bash
npm run sync:plugin-skills -- --source ../skills
npm run check:plugin-skills -- --source ../skills
```

After every push to the upstream skills repository's `main` branch, its notifier sends a
`skills-updated` repository dispatch containing the new commit SHA. The `sync-plugin-skills`
workflow checks out that exact revision and opens or updates a draft PR when either bundled skill
changes. The workflow can also be started manually.

The upstream notifier requires a `PORTAL_MCP_SERVER_DISPATCH_TOKEN` Actions secret in
`subsquid-labs/skills`. Use a fine-grained token scoped to `subsquid-labs/portal-mcp-server` with
**Contents: write** permission, which GitHub requires for creating a repository dispatch event.

## Release Gate

Run the plugin release gate before publishing plugin changes:

```bash
npm run test:plugin
npm run test:claude-plugin
npm run test:realistic-prompts
```

These validate the Codex and Claude Code plugin manifests, bundled skills, marketplace entries,
optional asset paths, hosted MCP compatibility, and the published starter prompts.

## Local Iteration

The public plugin manifest should keep the release version, for example `0.8.0`, without a Codex
cachebuster suffix.

From the repository root:

```bash
codex plugin marketplace add .
codex plugin add portal@sqd
```

Start a new Codex task after reinstalling. During local-only iteration, a temporary cachebuster
suffix can be useful to force reinstall behavior, but remove it before publishing.

## Current MCP Endpoint

The default plugin MCP server is the hosted HTTP endpoint:

```json
{
  "type": "http",
  "url": "https://portal.sqd.dev/mcp"
}
```

The checked-in MCP server key is `SQD` so Codex shows the server as `SQD` in plugin details.

Do not add tenant credentials, bearer tokens, local checkout paths, or personal marketplace paths to
the plugin manifest.

## Local And Offline Fallback

The default plugin should stay hosted. For local Codex development, use a checkout-local stdio
launcher instead of npm, Docker, or vendored build output.

Recommended local fallback:

```bash
npm install
npm run build
node dist/index.js
```

Use that build through a local-only MCP config override such as:

```json
{
  "mcpServers": {
    "sqd-portal-local": {
      "cwd": "/absolute/path/to/portal-mcp-server",
      "command": "node",
      "args": ["dist/index.js"]
    }
  }
}
```

Do not commit that local override to this plugin. The checked-in plugin remains hosted and portable.

Do not document a package-runner fallback until the package is actually published to npm. The
package was not available in the public npm registry during the v0.8.0 plugin work.

Docker is useful for self-hosted HTTP mode, not as the first Codex stdio fallback. The public
`subsquid/portal-mcp-server:0.7.9` image was linux/amd64-only during the v0.8.0 plugin work, and
`subsquid/portal-mcp-server:0.8.0` was not published yet. Add a multi-arch image before promoting
Docker as the local plugin path for Apple Silicon users.

Stdio safety rule: stdout is the MCP transport. Keep runtime logs on stderr, and do not add
`console.log` or other stdout writes to the stdio entrypoint or helpers used by `dist/index.js`.
