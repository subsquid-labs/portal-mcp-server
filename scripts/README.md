# Portal MCP Test Scripts

These scripts all use the shared manifest in `scripts/tool-manifest.ts`, which keeps the live test surface aligned with the currently registered MCP tools.

## Available scripts

### `npm test`
Builds the server, starts it over stdio, and runs a fast smoke test over the core discovery tools.

### `npm run test:tools`
Runs the full live tool suite against the current MCP server. It:

- compares `tools/list` against the manifest so drift is caught immediately
- exercises all currently registered tools with representative arguments
- validates that each response is non-error and structurally useful

### `npx tsx scripts/deep-test.ts`
Runs the same manifest with user-style prompts in the output so it is easier to scan as a realistic end-to-end QA pass.

### `npx tsx scripts/data-quality-test.ts`
Prints truncated real responses for every manifest entry so you can review readability, verbosity, and UX.

## Updating the suite

When tool names or recommended arguments change:

1. Update `scripts/tool-manifest.ts`
2. Re-run `npm run test:tools`
3. Re-run `npx tsx scripts/data-quality-test.ts` for a quick qualitative review

## Why the manifest exists

Older test scripts hardcoded tools that no longer existed, which turned product churn into false failures. The shared manifest keeps the automated and qualitative suites in sync with the actual server surface.
