#!/usr/bin/env node

import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'

const SERVER_NAME = 'io.github.subsquid-labs/portal-mcp-server'
const REPOSITORY = 'https://github.com/subsquid-labs/portal-mcp-server'
const SERVER_URL = 'https://portal.sqd.dev/mcp'
const LIVE = process.argv.includes('--live')
const outputArgument = process.argv.find((argument) => argument.startsWith('--output='))
const outputPath = outputArgument?.slice('--output='.length)

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function result(target, status, detail) {
  return { target, status, detail }
}

function fail(message) {
  throw new Error(message)
}

function validateMetadata() {
  const packageJson = readJson('package.json')
  const server = readJson('server.json')
  const glama = readJson('glama.json')
  const gemini = readJson('plugins/portal/gemini-extension.json')
  const codex = readJson('plugins/portal/.codex-plugin/plugin.json')
  const claude = readJson('plugins/portal/.claude-plugin/plugin.json')
  const cursor = readJson('plugins/portal/.cursor-plugin/plugin.json')
  const targets = readJson('distribution/targets.json')
  const submissions = readJson('distribution/submission-packets.json')
  const dockerWorkflow = readFileSync('.github/workflows/docker-build.yml', 'utf8')

  const errors = []
  const assert = (condition, message) => {
    if (!condition) errors.push(message)
  }

  assert(server.name === SERVER_NAME, `server.json name must be ${SERVER_NAME}`)
  assert(server.title === 'SQD', 'server.json title must be SQD')
  assert(server.version === packageJson.version, 'server.json version must match package.json')
  assert(server.repository?.url === REPOSITORY, 'server.json repository must use the canonical GitHub URL')
  assert(server.description.length <= 100, 'server.json description must fit the MCP Registry 100-character limit')
  assert(
    server.remotes?.some((remote) => remote.url === SERVER_URL),
    'server.json must publish the hosted MCP URL',
  )
  assert(/SQD Portal datasets/.test(server.description), 'server.json description must name the live Portal catalog')
  assert(/Tron/.test(server.description), 'server.json description must include Tron')
  assert(
    /Tron (?:transactions|records|activity)/.test(server.description),
    'server.json must describe the native Tron query capability',
  )
  assert(!/[\u2013\u2014]/.test(server.description), 'server.json description must not use en or em dashes')

  for (const [name, manifest] of [
    ['Gemini', gemini],
    ['Codex', codex],
    ['Claude', claude],
    ['Cursor', cursor],
  ]) {
    assert(manifest.version === packageJson.version, `${name} manifest version must match package.json`)
  }

  assert(gemini.name === 'sqd', 'Gemini extension identifier must remain sqd')
  assert(gemini.mcpServers?.SQD?.httpUrl === SERVER_URL, 'Gemini must use the hosted MCP URL')
  assert(glama.maintainers?.includes('karelxfi'), 'Glama ownership metadata must include karelxfi')
  assert(
    !dockerWorkflow.includes('type=raw,value=${{ steps.package.outputs.version }}'),
    'default-branch Docker builds must not overwrite an immutable semantic-version image tag',
  )
  assert(
    dockerWorkflow.includes('type=raw,value=edge,enable={{is_default_branch}}') &&
      dockerWorkflow.includes("type=raw,value=latest,enable=${{ startsWith(github.ref, 'refs/tags/v') }}") &&
      dockerWorkflow.includes('type=semver,pattern={{version}}') &&
      dockerWorkflow.includes('type=sha'),
    'Docker builds must publish edge for main, latest only for release tags, semantic versions, and immutable SHA tags',
  )

  assert(targets.repository === REPOSITORY, 'distribution repository must use the canonical GitHub URL')
  assert(targets.serverUrl === SERVER_URL, 'distribution server URL must use the hosted MCP URL')
  const targetIds = targets.targets.map((target) => target.id)
  assert(targetIds.length === new Set(targetIds).size, 'distribution target IDs must be unique')
  for (const requiredTarget of [
    'claude-connectors',
    'openai-plugins',
    'grok-build',
    'cursor-marketplace',
    'official-mcp-registry',
    'gemini-cli',
    'claude-desktop-bundle',
    'glama',
    'awesome-mcp-servers',
    'smithery',
  ]) {
    assert(targetIds.includes(requiredTarget), `distribution targets must include ${requiredTarget}`)
  }

  assert(submissions.product === 'SQD', 'submission packets must use the public product name SQD')
  assert(submissions.developer === 'Subsquid Labs GmbH', 'submission packets must use the company identity')
  assert(submissions.repository === REPOSITORY, 'submission packets must use the canonical GitHub URL')
  assert(submissions.serverUrl === SERVER_URL, 'submission packets must use the hosted MCP URL')
  assert(submissions.authentication === 'none', 'submission packets must state that authentication is not required')
  assert(/Symbol_bl-bg\.svg$/.test(submissions.logo), 'submission packets must use the black-background SQD logo')
  for (const targetId of ['smithery', 'mcp-so', 'pulse-mcp', 'api-tracker']) {
    const packet = submissions.packets?.[targetId]
    assert(packet?.name === 'SQD', `${targetId} submission must use the product name SQD`)
    assert(
      /blockchain/i.test(`${packet?.tagline} ${packet?.description}`),
      `${targetId} submission must mention blockchain`,
    )
    assert(/Hyperliquid/.test(packet?.description ?? ''), `${targetId} submission must mention Hyperliquid`)
    assert(/Tron/.test(packet?.description ?? ''), `${targetId} submission must mention Tron`)
    assert(
      /(?:and|,) Tron (?:records|activity)/.test(packet?.description ?? ''),
      `${targetId} submission must list Tron with the other queryable networks`,
    )
    assert(
      !/[\u2013\u2014]/.test(`${packet?.tagline} ${packet?.description}`),
      `${targetId} submission must not use en or em dashes`,
    )
  }

  const descriptions = [server, gemini, codex, claude, cursor, submissions]
  assert(
    !/\b\d+\+ (?:SQD )?(?:Portal )?(?:networks|datasets)\b/.test(JSON.stringify(descriptions)),
    'public descriptions must use live catalog discovery instead of a fixed network or dataset count',
  )

  if (errors.length > 0) fail(errors.join('\n'))
  return { version: packageJson.version, targets }
}

/*
 * The Docker image runs `npm run build`, and .dockerignore excludes scripts/*
 * with an allowlist of the ones the build needs. An allowlist is silent when it
 * is short by one file: the bundler gained zod-locale-plugin.mjs, the list did
 * not, and the image build broke with ERR_MODULE_NOT_FOUND while the offline
 * gate stayed green, because nothing else builds the image. This follows the
 * relative imports out of the build entry points and fails on the first one the
 * image would not receive.
 */
function checkDockerBuildInputs() {
  const dockerignore = readFileSync('.dockerignore', 'utf8')
  const allowed = new Set(
    dockerignore
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('!'))
      .map((line) => line.slice(1)),
  )
  /* `build` is mostly `npm run <other>`, so the script names have to be
     followed before any file path shows up. */
  const scripts = readJson('package.json').scripts
  const entries = []
  const visitedScripts = new Set()
  const scriptQueue = ['build']
  while (scriptQueue.length > 0) {
    const name = scriptQueue.shift()
    if (visitedScripts.has(name) || scripts[name] === undefined) continue
    visitedScripts.add(name)
    const body = scripts[name]
    entries.push(...[...body.matchAll(/scripts\/[A-Za-z0-9._-]+\.mjs/g)].map((match) => match[0]))
    scriptQueue.push(...[...body.matchAll(/npm run (?:--silent )?([A-Za-z0-9:_-]+)/g)].map((match) => match[1]))
  }

  const errors = []
  const seen = new Set()
  const queue = [...new Set(entries)]
  while (queue.length > 0) {
    const path = queue.shift()
    if (seen.has(path)) continue
    seen.add(path)
    if (!allowed.has(path)) {
      errors.push(`${path} is reachable from npm run build but .dockerignore does not let it into the image`)
      continue
    }
    let source
    try {
      source = readFileSync(path, 'utf8')
    } catch {
      errors.push(`${path} is reachable from npm run build but does not exist`)
      continue
    }
    for (const match of source.matchAll(/from '(\.\/[A-Za-z0-9._-]+\.mjs)'/g)) {
      queue.push(`scripts/${match[1].slice(2)}`)
    }
  }

  if (errors.length > 0) fail(`Docker build inputs:\n  - ${errors.join('\n  - ')}`)
  return result('docker-build-inputs', 'pass', `${seen.size} build scripts are all copied into the image`)
}

/*
 * The offline gate is the required check and runs inside the pinned Playwright
 * image, which is not a full developer machine: it carries no `zip` and no
 * `unzip`. Two scripts shelled out to them, so packaging and unpacking the
 * MCPB bundle failed there while every local run passed, and each one only
 * surfaced on its own CI round trip. Anything the gate reaches may use node
 * and npm and nothing else; where a task looks like it needs a system tool,
 * there is usually a library or CLI already in devDependencies that does it
 * (the MCPB CLI packs and unpacks its own format).
 */
const OFFLINE_GATE_BINARIES = new Set(['node', 'npm', 'npx'])

function checkOfflineGateBinaries() {
  const scripts = readJson('package.json').scripts
  const bodies = []
  const visited = new Set()
  const queue = ['test:offline']
  while (queue.length > 0) {
    const name = queue.shift()
    if (visited.has(name) || scripts[name] === undefined) continue
    visited.add(name)
    const body = scripts[name]
    bodies.push(body)
    queue.push(...[...body.matchAll(/npm run (?:--silent )?([A-Za-z0-9:_-]+)/g)].map((match) => match[1]))
    /* A `pre<name>` script runs on its own and is easy to forget. */
    queue.push(`pre${name.replace(/:/g, ':')}`)
  }

  const files = new Set()
  for (const body of bodies) {
    for (const match of body.matchAll(/scripts\/[A-Za-z0-9._-]+\.(?:mjs|ts)/g)) files.add(match[0])
  }

  const errors = []
  for (const file of [...files].sort()) {
    let source
    try {
      source = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    for (const match of source.matchAll(/(?:spawnSync|execFileSync|execSync|spawn)\(\s*'([a-z][a-z0-9._-]*)'/g)) {
      if (!OFFLINE_GATE_BINARIES.has(match[1])) {
        errors.push(`${file} runs the system binary '${match[1]}'; the offline gate's container has node and npm only`)
      }
    }
  }

  if (errors.length > 0) fail(`Offline gate binaries:\n  - ${errors.join('\n  - ')}`)
  return result('offline-gate-binaries', 'pass', `${files.size} gate scripts shell out to node and npm only`)
}

async function fetchText(url) {
  let lastError
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { 'user-agent': 'SQD-Directory-Health/1.0' },
        signal: AbortSignal.timeout(15_000),
      })
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
      return await response.text()
    } catch (error) {
      lastError = error
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 500))
    }
  }
  throw lastError
}

async function checkRegistry(version) {
  const encodedName = encodeURIComponent(SERVER_NAME)
  const body = await fetchText(
    `https://registry.modelcontextprotocol.io/v0.1/servers/${encodedName}/versions/${encodeURIComponent(version)}`,
  )
  const match = JSON.parse(body)
  if (match.server?.name !== SERVER_NAME || match.server?.version !== version) {
    return result('Official MCP Registry', 'fail', `version ${version} is not published`)
  }
  if (!match._meta?.['io.modelcontextprotocol.registry/official']?.isLatest) {
    return result('Official MCP Registry', 'fail', `version ${version} is present but not marked latest`)
  }
  return result('Official MCP Registry', 'pass', `version ${version} is latest`)
}

async function checkGemini(version) {
  const body = await fetchText('https://geminicli.com/extensions.json')
  const extensions = JSON.parse(body)
  const match = extensions.find((extension) => extension.fullName === 'subsquid-labs/portal-mcp-server')
  if (!match) return result('Gemini CLI Extension Gallery', 'fail', 'repository is not indexed')
  if (match.extensionVersion !== version) {
    return result(
      'Gemini CLI Extension Gallery',
      'fail',
      `gallery has ${match.extensionVersion ?? 'no version'}, expected ${version}`,
    )
  }
  return result('Gemini CLI Extension Gallery', 'pass', `version ${version} is indexed`)
}

async function checkGeminiPrerequisites(version) {
  const [repositoryBody, releaseBody] = await Promise.all([
    fetchText('https://api.github.com/repos/subsquid-labs/portal-mcp-server'),
    fetchText(`https://api.github.com/repos/subsquid-labs/portal-mcp-server/releases/tags/v${version}`),
  ])
  const repository = JSON.parse(repositoryBody)
  const release = JSON.parse(releaseBody)
  if (!repository.topics?.includes('gemini-cli-extension')) {
    return result('Gemini discovery prerequisites', 'fail', 'repository topic gemini-cli-extension is missing')
  }
  if (!release.assets?.some((asset) => asset.name === 'sqd.tar.gz')) {
    return result('Gemini discovery prerequisites', 'fail', `release v${version} is missing sqd.tar.gz`)
  }
  return result('Gemini discovery prerequisites', 'pass', `topic and v${version} release archive are present`)
}

async function checkMcpbAsset(version) {
  const release = JSON.parse(
    await fetchText(`https://api.github.com/repos/subsquid-labs/portal-mcp-server/releases/tags/v${version}`),
  )
  const asset = release.assets?.find((entry) => entry.name === 'sqd.mcpb')
  if (!asset) return result('Claude Desktop MCP Bundle', 'fail', `release v${version} is missing sqd.mcpb`)
  if (asset.size > 15 * 1024 * 1024) {
    return result('Claude Desktop MCP Bundle', 'fail', `sqd.mcpb is ${asset.size} bytes, above the 15 MB budget`)
  }
  return result('Claude Desktop MCP Bundle', 'pass', `v${version} release carries sqd.mcpb (${asset.size} bytes)`)
}

async function checkGlama(version) {
  const body = await fetchText('https://glama.ai/mcp/servers/subsquid-labs/portal-mcp-server')
  if (body.includes('Unclaimed servers have limited discoverability.')) {
    return result('Glama', 'fail', 'listing is live but unclaimed')
  }

  const decoded = body.replaceAll('\\"', '"')
  const releaseIndex = decoded.lastIndexOf('"latestRelease"')
  const releaseWindow = releaseIndex >= 0 ? decoded.slice(releaseIndex, releaseIndex + 800) : ''
  const listedVersion = releaseWindow.match(/"version","([^"]+)"/)?.[1]
  if (!listedVersion) return result('Glama', 'fail', 'latest release version could not be read')
  if (listedVersion !== version) {
    return result('Glama', 'fail', `listing has ${listedVersion}, expected ${version}`)
  }
  return result('Glama', 'pass', `version ${version} is indexed and the listing is claimed`)
}

async function checkAwesomeList() {
  const body = await fetchText('https://raw.githubusercontent.com/punkpeye/awesome-mcp-servers/main/README.md')
  if (!body.includes(REPOSITORY)) {
    return result('Awesome MCP Servers', 'fail', 'canonical repository is missing')
  }
  return result('Awesome MCP Servers', 'pass', 'canonical repository is listed')
}

/* The listing page is rendered in the browser, so the check reads the
   registry API. Smithery fronts the server with its own remote URL. */
async function checkSmithery() {
  const body = await fetchText('https://registry.smithery.ai/servers/sqd/sqd')
  const listing = JSON.parse(body)
  if (listing.qualifiedName !== 'sqd/sqd' || listing.displayName !== 'SQD') {
    return result('Smithery', 'fail', 'official sqd/sqd listing metadata is missing')
  }
  if (!/SQD Portal/.test(listing.description ?? '') || !/blockchain/i.test(listing.description ?? '')) {
    return result('Smithery', 'fail', 'listing description no longer names SQD Portal blockchain data')
  }
  const remote = listing.remote === true && (listing.connections ?? []).some((connection) => connection.type === 'http')
  if (!remote) return result('Smithery', 'fail', 'hosted MCP connection is missing')
  if (!Array.isArray(listing.tools) || listing.tools.length < 20) {
    return result(
      'Smithery',
      'fail',
      `listing exposes ${listing.tools?.length ?? 0} tools, expected the public catalog`,
    )
  }
  return result('Smithery', 'pass', `official sqd/sqd listing is live with ${listing.tools.length} tools`)
}

async function checkGrokPullRequest() {
  const body = await fetchText('https://api.github.com/repos/xai-org/plugin-marketplace/pulls/384')
  const pullRequest = JSON.parse(body)
  if (pullRequest.merged_at)
    return result('Grok Build Marketplace', 'pass', `pull request #384 merged at ${pullRequest.merged_at}`)
  if (pullRequest.state === 'open')
    return result('Grok Build Marketplace', 'pending', 'pull request #384 is open for review')
  return result('Grok Build Marketplace', 'fail', 'pull request #384 closed without merging')
}

async function runLiveChecks(version) {
  const checks = [
    ['Official MCP Registry', () => checkRegistry(version)],
    ['Gemini discovery prerequisites', () => checkGeminiPrerequisites(version)],
    ['Gemini CLI Extension Gallery', () => checkGemini(version)],
    ['Claude Desktop MCP Bundle', () => checkMcpbAsset(version)],
    ['Glama', () => checkGlama(version)],
    ['Awesome MCP Servers', checkAwesomeList],
    ['Smithery', checkSmithery],
    ['Grok Build Marketplace', checkGrokPullRequest],
  ]

  return Promise.all(
    checks.map(async ([name, check]) => {
      try {
        return await check()
      } catch (error) {
        return result(name, 'fail', error instanceof Error ? error.message : String(error))
      }
    }),
  )
}

function renderMarkdown(version, results) {
  const rows = results.map(({ target, status, detail }) => `| ${target} | ${status} | ${detail} |`).join('\n')
  return `## SQD directory health\n\nExpected version: \`${version}\`\n\n| Directory | Status | Detail |\n| --- | --- | --- |\n${rows}\n`
}

const { version } = validateMetadata()
const dockerInputs = checkDockerBuildInputs()
const gateBinaries = checkOfflineGateBinaries()
const results = LIVE
  ? [dockerInputs, gateBinaries, ...(await runLiveChecks(version))]
  : [result('Distribution metadata', 'pass', `all manifests match version ${version}`), dockerInputs, gateBinaries]
const report = {
  checkedAt: new Date().toISOString(),
  expectedVersion: version,
  live: LIVE,
  results,
}

if (outputPath) writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`)
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, renderMarkdown(version, results))

/* pending means a review queue or an open marketplace pull request; it is
   reported but only a failed required target turns the run red. */
const required = new Set(
  readJson('distribution/targets.json')
    .targets.filter((target) => target.required !== false)
    .map((target) => target.name),
)
for (const entry of results) console.log(`${entry.status.toUpperCase()} ${entry.target}: ${entry.detail}`)
if (results.some((entry) => entry.status === 'fail' && required.has(entry.target))) process.exitCode = 1
