# Portal MCP Test Scripts

These scripts all use the shared manifest in `scripts/tool-manifest.ts`, which keeps the live test surface aligned with the currently registered MCP tools.

## Two gates

- `npm run test:offline` is the required pull-request check. It builds, runs `npm run lint` (Biome) and `npm run typecheck`, the `node --test` unit tests in `src/**/*.test.ts`, and every suite that needs no Portal access (lockfiles, workflow pins, lean surface, distribution manifests, fetch reliability, stdio backpressure, performance harness, tool admission, app contract, catalog tokens, app UI, evidence receipts, investigation prompts, package contents). It passes with the network disabled.
- `npm run test:live` runs everything that talks to Portal or an installed client. CI runs it on every pull request as a reporting job that does not block, and in full on a `v*` tag.
- `npm run test:all` (also `test:ci` and `test:release`) runs both.

## Unit tests

Unit tests sit next to the code as `src/**/*.test.ts` and run with the built-in `node --test` runner through `tsx` (`npm run test:unit`, a few seconds, no network). They are excluded from `tsc` output and never ship in the package. Prefer them for pure helpers: parsing, exact arithmetic, cursors, validation, coverage rules, and characterisation of large modules on recorded responses (`src/app-ui/fixtures.recorded.ts`).

## Catalog token gate

`npm run test:catalog-tokens` (part of the offline gate) starts the server in-process for both surfaces (App disabled and App enabled), lists tools, prompts, and resources, counts tokens per tool component with the `o200k_base` tokenizer, and compares the result with `scripts/catalog-token-baseline.json`. It fails when the catalog total or any single tool grows more than 5% and prints the top ten tools to the job summary. Refresh the baseline deliberately with `npm run baseline:catalog-tokens -- --note "<why the cost changed>"` and record the new totals in `CHANGELOG.md`. With `ANTHROPIC_API_KEY` set, the Anthropic token-count API is queried for the same surfaces and printed beside the local count; the gate always uses the local count.

## Model-in-the-loop eval

`npm run eval:model-loop` lets a model answer the pinned questions in `evals/portal-mcp.json` through the real server over stdio with the full tool catalog, and grades the final `ANSWER:` line (exact number, address, or text; the negative cases expect a plain statement that the question cannot be answered). Every positive case names a fixed block, slot, or timestamp window, and its answer was checked against the Portal rows returned by the recorded `reference_calls`. The run prints one line per case, writes `artifacts/model-eval/<model>-<time>.json` plus `latest.md`, appends the table to the GitHub job summary, and fails when the pass rate is under 90% or the median tool-call count rises more than 20% over the previous runs in `EVAL_HISTORY_DIR`. `EVAL_MODEL` (default `claude-sonnet-5`), `EVAL_ENDPOINT`, `EVAL_MAX_TOOL_CALLS` (default 8), `EVAL_MIN_PASS_RATE`, and `EVAL_MAX_TOOL_CALL_GROWTH` override the defaults; `--only <id,id>` runs a subset. `--model mock` replays the reference calls without an API key and checks that every recorded answer still matches live Portal data, which is how the question set itself is verified. `.github/workflows/model-eval.yml` runs the real model nightly with the `ANTHROPIC_API_KEY` secret and keeps 90 days of artifacts; it is a reporting signal, not a merge gate.

## Generated Explorer bundle

`src/generated/activity-explorer.generated.ts` and `activity-explorer.version.ts` are build outputs and are not tracked in git. `npm run build` always regenerates them. Every entry point that imports the bundle from source runs `scripts/ensure-app-bundle.mjs` first (`predev`, `predev:http`, `pretypecheck`, `pretest:unit`, `pretest:app-contract`, `pretest:app-ui`, `pretest:catalog-tokens`, `preapp:host`), which rebuilds only when the outputs are missing or older than `src/app-ui/**`, the build scripts, or `package.json`. A fresh clone followed by `npm ci && npm run dev` therefore works with no manual step, and `git status` stays clean after a build.

## Every suite and its gate

| Script | Gate | What it checks |
|---|---|---|
| `test:unit` | offline | `node --test` unit tests in `src/**/*.test.ts` |
| `test:lockfiles` | offline | `package-lock.json` is the only lockfile, matches `package.json`, and is what the image installs |
| `test:workflow-pins` | offline | every GitHub Action pinned by SHA, no checkout credentials, empty default permissions |
| `test:release-reporting` | offline | publication evidence, exact-version reporting, dry-run safety, and private-output handling |
| `test:lean` | offline | one registry, instrumented registrations, no legacy surfaces, bounded source |
| `test:distribution` | offline | distribution and submission manifests share the release version |
| `test:fetch-reliability` | offline | Portal fetch timeouts, malformed bodies, cancellation, retry budget |
| `test:stdio-backpressure` | offline | large results over stdio without stalls |
| `test:performance-harness` | offline | repeated EVM candle requests reuse one snapshot |
| `test:tool-admission` | offline | weighted work classes, fair promotion, overload, capacity release |
| `test:catalog-tokens` | offline | `tools/list` token cost against the committed baseline |
| `test:app-contract` | offline | MCP App resource, CSP, metadata, opt-in gate, formatter contracts |
| `test:app-ui` | offline | Explorer rendering, interactions, accessibility, hostile text, screenshots |
| `test:mcpb` | offline | Claude Desktop bundle packages, unpacks, and starts with 31 tools |
| `test:evidence-receipts` | offline | canonical arguments, digest, replay mode |
| `test:investigation-prompts` | offline | prompts and guide resources are discoverable |
| `test:package` | offline | published tarball contains only allowlisted files; no audit findings |
| `npm test` | live | stdio smoke test over the discovery tools |
| `test:protocol` | live | MCP `2026-07-28` negotiation, cache hints, catalog, toolsets |
| `test:tools` | live | one representative successful call per tool |
| `test:routing` | live | prompt-to-tool routing cases |
| `test:substrate`, `test:timestamps` | live | Substrate paths; timestamp units and window boundaries |
| `test:http-runtime` | live | HTTP surface, allowlist, limits, readiness, metrics, toolsets (Portal is a local fixture; the token-list check reaches the network) |
| `test:pagination` | live | exact continuation inside dense blocks |
| `test:reliability-live`, `test:evm-investigator` | live | live regression paths per family |
| `test:v084-factuality`, `test:v084-acceptance-regressions`, `test:data-integrity` | live | factual completeness against direct Portal evidence |
| `test:bitcoin-fees` | live | exact satoshi fee accounting parity |
| `test:app-host` | live | every Explorer action through the official AppBridge |
| `test:investigation-journeys`, `test:client-journeys`, `test:conversations`, `test:realistic-prompts` | live | guided investigations and declared-client journeys |
| `test:plugin`, `test:claude-plugin`, `test:grok-plugin`, `test:gemini-extension`, `test:cursor-plugin` | live | distribution packages |
| `test:negative` | live | invalid and unsupported requests, injection prompts |
| `test:quality` | live | per-tool response contract, size, and latency budgets against `scripts/quality-baseline.json`; refresh with `npm run baseline:quality -- --note "<why>"` |
| `test:live-cooldown` | live | a pause between heavy live suites |
| `eval:model-loop` | nightly | a model answers pinned questions through the server; pass rate and tool-call drift (`--model mock` verifies the question set offline from an API key) |

## Available scripts

### `npm run package:mcpb` and `npm run test:mcpb`
`package:mcpb` stages the production build, the exact production dependency closure from the local `node_modules` (no network, source maps and type declarations left out), a manifest built from the registered tools and prompts, and the icon; validates the manifest with the official `mcpb` CLI; and zips `dist/mcpb/sqd.mcpb`, failing above 15 MB. `test:mcpb` (offline gate) packages, unpacks into a temporary directory, starts `dist/index.js` from there over stdio, and checks version, 31 tools, 3 prompts, and that the beta app stays off. The release workflow uploads the bundle on every `v*` tag.

### `npm test`
Builds the server, starts it over stdio, verifies developer guide resources, and runs a fast smoke test over the core discovery tools.

### `npm run test:tools`
Runs the full live tool suite against the current MCP server. It:

- compares `tools/list` against the manifest so drift is caught immediately
- exercises all currently registered tools with representative arguments
- validates that each response is non-error and structurally useful

### `npm run test:routing`
Ranks naive user prompts against the live `listTools()` catalog to catch naming and description ambiguity before a model routes to the wrong tool. It:

- uses the real tool descriptions exposed by the server
- checks every current tool has at least one routing prompt
- adds extra "dumb user" prompts for common confusion cases
- fails when the expected tool does not rank highly enough

### `npm run test:conversations`
Runs multi-step user journeys that behave more like an AI chat session than isolated tool calls. It:

- simulates confused-user flows such as discovery -> summary -> chart
- checks that `answer`, `display`, and `next_steps` stay useful across the conversation
- catches places where a tool works technically but still feels awkward in chat

### `npm run test:realistic-prompts`
Runs skeptical, user-style prompts for the investigation features. It:

- maps messy incident-response prompts to the intended existing tool
- calls the live MCP server and validates the returned artifact, not only routing rank
- checks `investigation` evidence paths, pivots, limitations, and deterministic resolver suggestions

### `npm run test:negative`
Runs focused negative-path checks for invalid inputs and unsupported flows. It:

- verifies errors stay actionable and free of stack traces
- checks that common mistakes fail with clear recovery guidance
- verifies redaction of synthetic secret-like strings and rejection of tampered signed cursors
- protects the “stupid-proof” experience for LLMs and end users

### `npm run test:quality`
Runs an automated response-quality audit over the full manifest. It:

- checks the full response envelope, including `answer`, `display`, `next_steps`, `investigation`, `_llm`, `_freshness`, `_pagination`, `_coverage`, `_ordering`, `_execution`, and `_tool_contract`
- verifies every successful tool result emits `structuredContent` matching the compact JSON text fallback
- checks executable versus descriptive follow-up actions and safe pagination continuation metadata
- runs cold and warm passes, then enforces hard latency budgets and per-tool median/p95 response-size baselines so regressions fail CI
- reads `scripts/quality-baseline.json`, which records the package version, the capture time, and why it was taken; refresh it deliberately with `npm run baseline:quality -- --note "<why the measured sizes changed>"` and a CHANGELOG entry, never by hand
- flags truncation, legacy wording, default raw-query bloat, and non-humanized labels
- warns when a tool is drifting toward the hard budgets before it actually fails

### `npm run test:fetch-reliability`
Exercises the shared upstream boundary without depending on live Portal state. It covers queued cancellation, bounded overload, retry jitter, `Retry-After`, malformed JSON, truncated NDJSON, premature body termination, and structured oversized-result recovery.

### `npm run test:stdio-backpressure`
Forces 32 large concurrent MCP responses through a slow stdout fixture and verifies response writes stay serialized, listener-bounded, and fully drained.

### `npm run test:performance-harness`
Validates the open-loop measurement code itself. It checks intended-start queue delay, a no-change A/A comparison, detection of an injected 20 percent regression, and the five-millisecond practical-effect floor for very fast calls.

### `npm run test:pagination`
Validates exact cursor continuation when more than one page of matching rows shares the same block. It fails on repeated or skipped rows.

### `npm run test:client-journeys`
Runs the same protocol-level journey matrix for declared Claude, Codex, Grok, Gemini, and Cursor client identities. It covers discovery, structured and text parity, exact continuation, multi-step evidence, concurrency, invalid input, and post-error recovery.

This is protocol compatibility evidence, not proof that the five installed host applications rendered and completed the journeys. Installed-host proof remains a separate release artifact.

### `npm run test:evidence-receipts`
Checks canonical receipt arguments, deterministic digests, row reconciliation, source windows, and exact versus semantic replay semantics.

### `npm run test:investigation-journeys`
Runs three live golden investigations. It verifies wallet evidence against the requested wallet, contract summary arithmetic against returned events, and Hyperliquid candle counts and volume against raw fills.

### `npm run prepare:client-candidate -- /path/to/empty/temp-directory`
Builds a temporary client package for exact installed-host testing. It copies the public plugin packages, changes only the hosted connection to the current built stdio runtime, and writes `candidate.json` with the package digest and proof boundary. The output is temporary and must not be committed.

### `npm run benchmark:v082`
Runs open-loop cold c1, warm c1/c4/c8, and c8 burst profiles. The artifact records intended-start queue delay, service and end-to-end latency, bytes, outcomes, version, commit, and dirty state.

For a release artifact, use a clean commit, all tools, and at least 50 samples per warm profile. The default warm-profile arrival rate is 5 requests per second; the immediate c8 profile remains the saturation burst:

```bash
BENCHMARK_RELEASE=1 BENCHMARK_SAMPLES=50 npm run benchmark:v082
```

Compare exact baseline and candidate artifacts with:

```bash
npm run benchmark:compare -- artifacts/baseline.json artifacts/candidate.json
```

The comparison uses seeded bootstrap intervals over population medians and fails only when the supported latency increase is above both 10 percent and 5 milliseconds.

For the release regression gate, use the interleaved paired runner so baseline and candidate see the same live upstream conditions:

```bash
BENCHMARK_RELEASE=1 \
BENCHMARK_BASELINE_CWD=/path/to/clean-v0.8.1-worktree \
BENCHMARK_SAMPLES=50 \
npm run benchmark:paired
```

The runner starts both exact commits, schedules each sample pair at the same intended time, runs the two calls sequentially, alternates which side starts first, and cools down between tools. Its default target is two pairs per second. The paired gate uses c1 only. Running both calls concurrently would make one version consume shared Portal capacity and change the other's result. Candidate-only c4, c8, and burst behavior belongs to `benchmark:v082` and the release soak instead.

Release mode requires at least 80 percent successful pairs per warm profile and fails statistically supported service-latency regressions above both 10 percent and 5 milliseconds, candidate tool errors above 1 percent, or any profile with insufficient evidence. An insufficient profile or initial regression gets one cooldown-separated confirmation attempt, and both attempts remain in the artifact. A regression must repeat after cooldown to fail the live gate. `BENCHMARK_TARGET_RPS`, `BENCHMARK_COOLDOWN_MS`, and `BENCHMARK_PROFILE_ATTEMPTS` can override the default pair rate, 5-second cooldown, and release confirmation count. Sequential artifacts remain useful for standalone capacity evidence, but are not used as the release regression gate.

### `npm run soak:v082`
Runs mixed tools with periodic eight-call bursts while recording tool errors, latency recovery, and MCP child-process RSS. Development runs may override the duration. Release mode requires a clean commit, at least 60 minutes, and no more than 1 percent tool errors:

```bash
SOAK_RELEASE=1 npm run soak:v082
```

### `npm run test:package`
Runs `npm pack --dry-run` and verifies the published tarball contains only runtime essentials. It fails if source, test, plan, workflow, dashboard, lockfile, or local tooling artifacts are included.

### `npm run test:plugin`
Validates the Codex plugin wrapper and repo-local marketplace. It:

- checks `plugins/portal/.codex-plugin/plugin.json`
- checks `.agents/plugins/marketplace.json`
- verifies icon, logo, and screenshot paths if assets are added later
- confirms the hosted MCP endpoint initializes, lists tools, and answers a small `portal_list_networks` smoke call
- rejects committed local paths or secret-like markers in plugin manifests

### `npm run test:claude-plugin`
Validates the Claude Code plugin wrapper and repo-local marketplace. It:

- checks `plugins/portal/.claude-plugin/plugin.json`
- checks `.claude-plugin/marketplace.json`
- confirms the hosted MCP endpoint initializes and lists the expected SQD Portal tools
- rejects committed local paths or secret-like markers in plugin manifests

### `npm run test:timestamps`
Runs focused timestamp resolver QA. It:

- verifies Solana head timestamp lookup uses Portal's real `block.timestamp` field
- checks recent `1h` Solana windows are anchored to the latest indexed slot timestamp and resolved through Portal's timestamp lookup
- confirms `"now"` timestamp requests gracefully estimate from the indexed head when hotblocks reject wall-clock now
- checks every `real_time: true` dataset from Portal's live dataset catalog can read the latest block timestamp and produce a `1h` window

### `npm run test:all`
Runs the full live matrix:

- build
- smoke
- tools
- EVM investigator
- routing
- substrate
- timestamps
- HTTP mode
- Codex plugin manifest, marketplace, asset, and hosted MCP smoke checks
- Claude Code plugin manifest, marketplace, and hosted MCP smoke checks
- conversations
- realistic prompts
- negative paths
- quality audit
- package contents

### `npm run test:ci`
Alias for the full CI verification entrypoint. Today it runs the same matrix as `test:all`, including the deterministic performance-harness checks, declared-client protocol journeys, quality-and-budget gate, and package-content check.

### `npm run test:release`
Runs the deterministic and live functional release matrix. Clean-commit benchmark comparison, the 60-minute soak, and installed-host journeys remain separate evidence because they are long-running or host-specific.

### `npm run test:substrate`
Runs a focused live QA pass for Substrate readiness. It:

- verifies Substrate discovery, network info, head lookup, timestamp resolution, and block queries through the MCP
- checks that unsupported Substrate convenience flows fail clearly instead of leaking raw Portal parse errors
- validates the underlying Portal Substrate backend directly with event and call queries so wrapper gaps are easy to distinguish from backend gaps

### `npx tsx scripts/deep-test.ts`
Runs the same manifest with user-style prompts in the output so it is easier to scan as a realistic end-to-end QA pass.

### `npx tsx scripts/data-quality-test.ts`
Prints truncated real responses for every manifest entry so you can review readability, verbosity, and UX manually.

## Updating the suite

When tool names or recommended arguments change:

1. Update `scripts/tool-manifest.ts`
2. Re-run `npm run test:tools`
3. Re-run `npm run test:routing`
4. Re-run `npm run test:conversations`
5. Re-run `npm run test:realistic-prompts`
6. Re-run `npm run test:negative`
7. Re-run `npm run test:quality`, and refresh its baseline with `npm run baseline:quality -- --note "<why>"` when a new tool or a real data change moves the measured sizes
8. Re-run `npm run test:plugin`
9. Re-run `npm run test:package`
10. Re-run `npx tsx scripts/data-quality-test.ts` for a quick qualitative review

## Why the manifest exists

Older test scripts hardcoded tools that no longer existed, which turned product churn into false failures. The shared manifest keeps the automated and qualitative suites in sync with the actual server surface.
