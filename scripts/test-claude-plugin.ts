#!/usr/bin/env tsx

import { throws } from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, extname, join, resolve } from 'node:path'

import { parse } from 'yaml'

type JsonObject = Record<string, unknown>

const PLUGIN_ROOT = 'plugins/portal'
const MARKETPLACE_PATH = '.claude-plugin/marketplace.json'
const PLUGIN_JSON_PATH = `${PLUGIN_ROOT}/.claude-plugin/plugin.json`
const MCP_JSON_PATH = `${PLUGIN_ROOT}/.mcp.json`
const README_PATH = `${PLUGIN_ROOT}/README.md`
const DIRECTORY_SUBMISSION_PATH = 'distribution/DIRECTORY_SUBMISSION.md'
const PRIVACY_POLICY_URL = 'https://sqd.dev/imprint/'
const PLUGIN_ICON_PATH = './assets/sqd-logo.svg'
// Limits from the Claude plugin directory's pre-submission checklist.
const DIRECTORY_MAX_FILES = 512
const DIRECTORY_MAX_TEXT_FILE_BYTES = 256 * 1024
// Minified or packed code shows up as very long lines; the plugin's longest readable line is under 1,000 characters.
const MAX_READABLE_LINE_LENGTH = 2_000
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const FONT_EXTENSIONS = new Set(['.otf', '.ttf', '.woff', '.woff2'])
const SYSTEM_FILE_NAMES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini', '__MACOSX'])
const BINARY_ASSET_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', ...FONT_EXTENSIONS])
const DOWNLOAD_AND_RUN = /\b(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+)?(?:ba|z|da)?sh\b|\bbash\s+<\(\s*(?:curl|wget)\b/
// The directory holds a version that reads a key or password already on the user's machine and passes it on, even in
// documentation. A fallback value still reads the existing credential when it is set.
const CREDENTIAL_NAME = String.raw`[A-Z0-9_]*(?:API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD)[A-Z0-9_]*`
const CREDENTIAL_READS = [
  new RegExp(String.raw`\$\{?${CREDENTIAL_NAME}\b`),
  new RegExp(String.raw`process\.env\s*(?:\.\s*${CREDENTIAL_NAME}\b|\[\s*['"]${CREDENTIAL_NAME}['"]\s*\])`),
  /(?:import\s+['"]dotenv|from\s+['"]dotenv|require\(\s*['"]dotenv|"dotenv"\s*:)/,
  /docker inspect[^\n]*(?:PASSWORD|TOKEN|SECRET|KEY)/i,
]
const OFFLINE = process.argv.includes('--offline')
const REQUIRE_MCP_2026_LIVE = process.env.REQUIRE_MCP_2026_LIVE === '1'
const MODERN_PROTOCOL_VERSION = '2026-07-28'
const LEGACY_PROTOCOL_VERSION = '2025-11-25'
const RELEASE_VERSION = readJson('package.json').version

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`)
  }
}

function assertSkillPermissions(text: string, file: string) {
  const frontmatter = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)
  assert(Boolean(frontmatter), `${file} should have skill frontmatter`)
  const metadata = parse(frontmatter![1]) as unknown
  assertRecord(metadata, `${file} should have a frontmatter mapping`)
  assert(
    !Object.hasOwn(metadata, 'allowed-tools'),
    `${file} pre-approves tools; omit allowed-tools so the user's permission settings apply`,
  )
}

function assertNoCredentialReads(text: string, file: string) {
  for (const pattern of CREDENTIAL_READS) {
    const match = text.match(pattern)
    assert(!match, `${file} reads a key or password from the user's machine (${match?.[0]}); leave it to the user`)
  }
}

function assertPolicyRegressions() {
  for (const permissions of ['Bash', '[Bash, Write, Edit]', '\n  - Bash\n  - WebFetch', 'Bash(node:*)']) {
    throws(
      () => assertSkillPermissions(`---\nname: example\nallowed-tools: ${permissions}\n---\n`, 'fixture'),
      /pre-approves tools/,
    )
  }
  assertSkillPermissions('---\nname: example\n---\nUse the tools the user has approved.\n', 'fixture')
  for (const text of [
    "password: process.env.CLICKHOUSE_PASSWORD || 'default'",
    "password: process.env.CLICKHOUSE_PASSWORD ?? 'default'",
    "password: process.env['CLICKHOUSE_PASSWORD'] || 'default'",
    'password: process.env["CLICKHOUSE_PASSWORD"]',
    'apiKey: process.env.SQD_API_KEY',
    'curl -H "x-api-key: ${SQD_API_KEY}"',
    'curl -H "Authorization: Bearer $ACCESS_TOKEN"',
    "import 'dotenv/config'",
    'docker inspect --format PASSWORD example',
  ]) {
    throws(() => assertNoCredentialReads(text, 'fixture'), /reads a key or password/)
  }
  assertNoCredentialReads("password: 'default', url: 'http://localhost:8123'", 'fixture')
  assertNoCredentialReads('const start = process.env.START_DATE', 'fixture')
  console.log('PASS  permission and credential regression cases')
}

function readJson(path: string): JsonObject {
  return JSON.parse(readFileSync(path, 'utf8')) as JsonObject
}

function assertRecord(value: unknown, message: string): asserts value is JsonObject {
  assert(Boolean(value) && typeof value === 'object' && !Array.isArray(value), message)
}

function assertString(value: unknown, message: string): asserts value is string {
  assert(typeof value === 'string' && value.trim().length > 0, message)
}

function assertNoCommittedSecretOrLocalPath(value: unknown, path = '$') {
  if (typeof value === 'string') {
    const forbidden = [/\/Users\//, /localhost/, /file:\/\//, /MCP_HTTP_BEARER_TOKEN/, /PORTAL_URL/, /Bearer\s+/i]
    for (const pattern of forbidden) {
      assert(!pattern.test(value), `${path} contains forbidden local or secret-like marker ${pattern}`)
    }
    return
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoCommittedSecretOrLocalPath(item, `${path}[${index}]`))
    return
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      assertNoCommittedSecretOrLocalPath(item, `${path}.${key}`)
    }
  }
}

function parseRpcJson(text: string) {
  const trimmed = text.trim()
  if (trimmed.startsWith('{')) return JSON.parse(trimmed) as JsonObject
  const dataLine = text
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.startsWith('data: '))
  assert(Boolean(dataLine), `Expected SSE data line, got: ${text.slice(0, 240)}`)
  return JSON.parse(dataLine!.slice('data: '.length)) as JsonObject
}

async function postRpc(endpoint: string, method: string, params: JsonObject, modern = false) {
  const requestParams = modern
    ? {
        ...params,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': MODERN_PROTOCOL_VERSION,
          'io.modelcontextprotocol/clientInfo': {
            name: 'portal-mcp-claude-plugin-release-gate',
            version: '1.0.0',
          },
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      }
    : params
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'x-mcp-client-name': 'portal-mcp-claude-plugin-release-gate',
      'x-mcp-client-version': '1.0.0',
      ...(modern
        ? {
            'MCP-Protocol-Version': MODERN_PROTOCOL_VERSION,
            'Mcp-Method': method,
          }
        : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: method, method, params: requestParams }),
  })
  const text = await response.text()
  assert(response.ok, `RPC ${method} should return HTTP 2xx, got ${response.status}: ${text.slice(0, 240)}`)
  const parsed = parseRpcJson(text)
  assert(!parsed.error, `RPC ${method} returned JSON-RPC error: ${JSON.stringify(parsed.error)}`)
  return parsed.result as JsonObject
}

function assertMarketplace() {
  const marketplace = readJson(MARKETPLACE_PATH)
  assert(marketplace.name === 'sqd', 'Claude marketplace name should be sqd')
  assertRecord(marketplace.owner, 'Claude marketplace owner must be an object')
  assert(marketplace.owner.name === 'Subsquid Labs', 'Claude marketplace owner should be Subsquid Labs')
  assert(marketplace.version === RELEASE_VERSION, 'Claude marketplace version should match the package release')
  assert(Array.isArray(marketplace.plugins), 'Claude marketplace plugins must be an array')
  const entry = marketplace.plugins.find((plugin) => plugin?.name === 'portal') as JsonObject | undefined
  assertRecord(entry, 'Claude marketplace should include portal')
  assert(entry.source === './plugins/portal', 'Claude marketplace portal source should point at ./plugins/portal')
  assert(entry.displayName === 'SQD', 'Claude marketplace display name should be SQD')
  assert(entry.version === RELEASE_VERSION, 'Claude marketplace plugin entry version should match the package release')
  assertNoCommittedSecretOrLocalPath(marketplace)
}

function getEndpoint() {
  const manifest = readJson(PLUGIN_JSON_PATH)
  assert(manifest.name === 'portal', 'Claude plugin name should be portal')
  assert(manifest.displayName === 'SQD', 'Claude plugin display name should be SQD')
  assert(
    manifest.description ===
      'Query blockchain data across 130+ networks with SQD Portal, including Ethereum, Base, Solana, Polkadot, Bitcoin, Tron, and Hyperliquid. The SQD plugin also includes Pipes SDK and Squid SDK skills for building, migrating, troubleshooting, and improving blockchain data projects.',
    'Claude plugin description should lead with broad network coverage',
  )
  assert(!/[\u2014\u2013]/.test(JSON.stringify(manifest)), 'Claude plugin copy should not use em or en dashes')
  assert(manifest.version === RELEASE_VERSION, 'Claude plugin version should match the package release')
  assert(manifest.mcpServers === './.mcp.json', 'Claude plugin should reference ./.mcp.json')
  assert(existsSync(resolve(PLUGIN_ROOT, '.mcp.json')), 'Claude plugin MCP config should exist')
  for (const skill of ['portal', 'pipes-sdk', 'migrate-to-portal', 'squid-perf']) {
    assert(
      existsSync(resolve(PLUGIN_ROOT, 'skills', skill, 'SKILL.md')),
      `Claude plugin should auto-discover the ${skill} skill`,
    )
  }
  assertNoCommittedSecretOrLocalPath(manifest)
  assert(manifest.privacyPolicyUrl === PRIVACY_POLICY_URL, 'Claude plugin should link the SQD privacy policy')
  assert(manifest.icon === PLUGIN_ICON_PATH, 'Claude plugin icon should be the black SQD square logo')

  const mcp = readJson(MCP_JSON_PATH)
  assertRecord(mcp.mcpServers, '.mcp.json mcpServers must be an object')
  const serverNames = Object.keys(mcp.mcpServers)
  assert(JSON.stringify(serverNames) === JSON.stringify(['SQD']), '.mcp.json should expose the MCP server as SQD')
  const server = mcp.mcpServers.SQD
  assertRecord(server, '.mcp.json should include the SQD server')
  assert(server.type === 'http', 'SQD MCP server should use HTTP transport')
  assertString(server.url, 'SQD MCP server must define a URL')
  assert(server.url === 'https://portal.sqd.dev/mcp', 'SQD MCP URL should be the hosted endpoint')
  assertNoCommittedSecretOrLocalPath(mcp)
  return server.url
}

function assertDirectoryListing() {
  const submission = readFileSync(DIRECTORY_SUBMISSION_PATH, 'utf8')
  assert(
    submission.includes('https://claude.ai/directory/connectors/sqd'),
    'Claude submission packet should record the public SQD connector listing',
  )
  assert(
    submission.includes('Tagline: `Query blockchain data across 130+ networks`'),
    'Claude submission packet should keep the broad coverage tagline',
  )
  assert(submission.includes('Authentication: none'), 'Claude submission packet should declare no authentication')
  assert(
    submission.includes('canonical black-background SQD logo'),
    'Claude submission packet should use the canonical black-background logo',
  )
  assert(!/[\u2014\u2013]/.test(submission), 'Claude submission packet should not use em or en dashes')
}

function listEntries(dir: string): { path: string; isDirectory: boolean }[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const item = { path: join(dir, entry.name), isDirectory: entry.isDirectory() }
    return item.isDirectory ? [item, ...listEntries(item.path)] : [item]
  })
}

// The Claude plugin directory validates and scans every file in the plugin folder. These checks mirror the
// findings that block a submission or hold a version for a reviewer, so a release keeps passing them.
function assertDirectoryReadiness() {
  const entries = listEntries(PLUGIN_ROOT)
  for (const entry of entries) {
    assert(!SYSTEM_FILE_NAMES.has(basename(entry.path)), `${entry.path} is an OS system file the directory rejects`)
  }
  const files = entries.filter((entry) => !entry.isDirectory).map((entry) => entry.path)
  assert(files.length <= DIRECTORY_MAX_FILES, `the plugin has ${files.length} files; keep it to ${DIRECTORY_MAX_FILES}`)

  const binaryAssets: string[] = []
  const textFiles = new Map<string, string>()
  for (const file of files) {
    const bytes = readFileSync(file)
    const extension = extname(file).toLowerCase()
    if (BINARY_ASSET_EXTENSIONS.has(extension) || extension === '.svg') {
      assert((statSync(file).mode & 0o111) === 0, `${file} should not be executable`)
    }
    if (BINARY_ASSET_EXTENSIONS.has(extension)) {
      if (extension === '.png') {
        assert(bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE), `${file} is not a complete PNG image`)
      }
      binaryAssets.push(file)
      continue
    }
    const text = bytes.toString('utf8')
    assert(!text.includes('\u0000') && !text.includes('\ufffd'), `${file} should be UTF-8 text, not a binary file`)
    assert(
      bytes.length < DIRECTORY_MAX_TEXT_FILE_BYTES,
      `${file} is ${bytes.length} bytes; keep text files under 256 KiB`,
    )
    const longestLine = text.split('\n').reduce((longest, line) => Math.max(longest, line.length), 0)
    assert(
      longestLine <= MAX_READABLE_LINE_LENGTH,
      `${file} looks packed or minified (longest line ${longestLine} characters); ship readable source`,
    )
    assert(
      !DOWNLOAD_AND_RUN.test(text),
      `${file} pipes a downloaded script into a shell; link to the installer instead`,
    )
    assertNoCredentialReads(text, file)
    if (basename(file) === 'SKILL.md') assertSkillPermissions(text, file)
    if (extension === '.svg') {
      assert(/^<svg[\s>]/.test(text.trim()), `${file} should be an SVG`)
      assert(
        !/<script|<foreignObject|\son[a-z]+\s*=|\b(?:href|src)\s*=\s*["'](?!#)/i.test(text),
        `${file} should be a static SVG without scripts or external references`,
      )
    }
    textFiles.set(file, text)
  }

  // Image and font files are not read as code, so the directory holds any text that names one for review.
  for (const asset of binaryAssets) {
    const name = basename(asset)
    for (const [file, text] of textFiles) {
      assert(!text.includes(name), `${file} names the bundled binary asset ${name}; keep asset paths out of the plugin`)
    }
  }

  const icon = textFiles.get(join(PLUGIN_ROOT, PLUGIN_ICON_PATH))
  assert(icon !== undefined && /^<svg[\s>]/.test(icon.trim()), `${PLUGIN_ICON_PATH} should be an SVG in the plugin`)
  assert(
    !/<script|<foreignObject|\son[a-z]+\s*=|\b(?:href|src)\s*=\s*["'](?!#)/i.test(icon ?? ''),
    `${PLUGIN_ICON_PATH} should be a static SVG without scripts or external references`,
  )
  const readmeLines = (textFiles.get(README_PATH) ?? '').split('\n')
  assert(
    readmeLines.some((line) => /privacy/i.test(line) && line.includes(PRIVACY_POLICY_URL)),
    'README should link the privacy policy on a line that mentions privacy',
  )
  console.log(`PASS  ${files.length} plugin files meet the Claude plugin directory file rules`)
}

async function assertHostedMcp(endpoint: string) {
  const init = await postRpc(endpoint, 'initialize', {
    protocolVersion: LEGACY_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'portal-mcp-claude-plugin-release-gate', version: '1.0.0' },
  })
  assertRecord(init.serverInfo, 'initialize should return serverInfo')
  assert(init.serverInfo.name === 'sqd-portal-mcp-server', 'unexpected MCP server name')
  assert(init.protocolVersion === LEGACY_PROTOCOL_VERSION, 'legacy compatibility should negotiate MCP 2025-11-25')

  let list: JsonObject
  if (REQUIRE_MCP_2026_LIVE) {
    const discovery = await postRpc(endpoint, 'server/discover', {}, true)
    assert(Array.isArray(discovery.supportedVersions), 'server/discover should return supportedVersions')
    assert(
      discovery.supportedVersions.includes(MODERN_PROTOCOL_VERSION),
      'Claude plugin should advertise MCP 2026-07-28',
    )
    assert(discovery.resultType === 'complete', 'server/discover should return a complete modern result')
    assertRecord(discovery._meta, 'server/discover should return modern result metadata')
    assertRecord(discovery._meta['io.modelcontextprotocol/serverInfo'], 'server/discover should return server identity')
    assert(
      (discovery._meta['io.modelcontextprotocol/serverInfo'] as JsonObject).name === 'sqd-portal-mcp-server',
      'server/discover should identify the SQD Portal MCP server',
    )
    list = await postRpc(endpoint, 'tools/list', {}, true)
    assert(list.resultType === 'complete', 'modern tools/list should return a complete result')
    assert(typeof list.ttlMs === 'number', 'modern tools/list should expose ttlMs')
    assert(list.cacheScope === 'public' || list.cacheScope === 'private', 'modern tools/list should expose cacheScope')
  } else {
    list = await postRpc(endpoint, 'tools/list', {})
  }

  assert(Array.isArray(list.tools), 'tools/list should return tools array')
  const toolNames = new Set(list.tools.map((tool) => (tool as JsonObject).name))
  assert(toolNames.has('portal_list_networks'), 'tools/list should include portal_list_networks')
  assert(toolNames.has('portal_resolve_entity'), 'tools/list should include portal_resolve_entity')
}

async function main() {
  assertPolicyRegressions()
  assertMarketplace()
  assertDirectoryListing()
  assertDirectoryReadiness()
  const endpoint = getEndpoint()
  if (OFFLINE) {
    console.log('Claude plugin offline gate passed: package, permissions, credentials, and manifests are valid')
    return
  }
  const { assertWithInstalledClaudeCli } = await import('./claude-plugin-cli.ts')
  assertWithInstalledClaudeCli(PLUGIN_ROOT, MARKETPLACE_PATH)
  await assertHostedMcp(endpoint)
  console.log(
    `Claude plugin release gate passed: marketplace, manifest, MCP config, and hosted MCP smoke are valid${REQUIRE_MCP_2026_LIVE ? ' with live MCP 2026-07-28' : ''}`,
  )
}

await main()
