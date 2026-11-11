# Working in this repository

Instructions for agent-driven and human contributors alike. `CONTRIBUTING.md` explains the same conventions in prose; this file is the short form.

## What this is

An MCP server that answers blockchain questions from SQD Portal data across EVM, Solana, Bitcoin, Substrate, and Hyperliquid networks. It validates input, plans bounded Portal queries, and returns results with coverage, freshness, pagination, and evidence metadata. It does not index chains itself. The optional SQD Explorer (`src/app-ui/`) is an MCP App that renders those results in hosts that support it.

## Commands

| Task | Command |
|---|---|
| Install | `npm ci` (Node 22) |
| Build | `npm run build` |
| Run over stdio | `npm run dev` |
| Run over HTTP on loopback | `npm run dev:http` |
| Format and lint | `npm run lint` (`npm run lint:fix` applies safe fixes) |
| Types | `npm run typecheck` |
| Unit tests | `npm run test:unit` |
| Required gate, no network | `npm run test:offline` |
| Portal-backed suites | `npm run test:live` |
| Catalog token gate | `npm run test:catalog-tokens`; refresh with `npm run baseline:catalog-tokens -- --note "<why>"` |
| Response size and latency gate | `npm run test:quality`; refresh with `npm run baseline:quality -- --note "<why>"` |
| Explorer in a local host | `npm run app:host` |
| Release (maintainers, on `main`) | `npm run release:patch`, then push the branch and the tag |

## Conventions

- Use the latest stable MCP SDK and MCP Apps releases when updating dependencies or preparing a server release. Verify published versions against upstream release notes, update the lockfile, and run compatibility checks. Report Explorer bundle bytes without imposing a fixed size budget.
- Format only the files you changed (`npx biome format --write <files>`); the repository is Biome-formatted and a whole-file reformat hides the real diff.
- Pure logic gets a unit test next to the code (`src/**/*.test.ts`). Black-box checks live in `scripts/` and are listed in `scripts/README.md` with their gate.
- The Explorer shows recorded Portal data in previews and screenshots; only sparse, mixed, and error cells are synthetic.
- Third-party text (token names and symbols, pallet and program labels) is data: never interpolate it into prose without `src/helpers/untrusted-text.ts`.
- Every user-visible change gets a line in the unreleased section of `CHANGELOG.md`.
- This repository is public. Apply the same disclosure review to source, comments, fixtures, pull requests, issue comments, release notes, and packaged files. Include only information needed by users and contributors; omit credentials, internal hostnames, personal filesystem paths, private conversation content, internal tracker references, and deployment-specific operational details. Link public issues and use portable commands and synthetic examples.
- Ask before anything outward-facing beyond a feature branch and its pull request: publishing, closing other people's pull requests, changing deployment settings.
