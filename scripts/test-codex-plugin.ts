#!/usr/bin/env tsx

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

type JsonObject = Record<string, unknown>

const PLUGIN_ROOT = 'plugins/portal'
const MARKETPLACE_PATH = '.agents/plugins/marketplace.json'
const PLUGIN_JSON_PATH = `${PLUGIN_ROOT}/.codex-plugin/plugin.json`
const MCP_JSON_PATH = `${PLUGIN_ROOT}/.mcp.json`
const README_PATH = `${PLUGIN_ROOT}/README.md`
const DIRECTORY_SUBMISSION_PATH = 'distribution/DIRECTORY_SUBMISSION.md'
const SKILLS_SOURCE_PATH = `${PLUGIN_ROOT}/skills/SOURCE.md`
const CHATGPT_SUBMISSION_PATH = 'chatgpt-app-submission.json'
const OPENAI_DIRECTORY_ICON_PATH = `${PLUGIN_ROOT}/assets/sqd-directory-icon.png`
const OPENAI_COMPOSER_ICON_PATH = `${PLUGIN_ROOT}/assets/sqd-chatgpt-composer-icon.png`
const REQUIRE_OPENAI_LIVE_METADATA = process.env.REQUIRE_OPENAI_LIVE_METADATA === '1'
const REQUIRE_MCP_2026_LIVE = process.env.REQUIRE_MCP_2026_LIVE === '1'
const MODERN_PROTOCOL_VERSION = '2026-07-28'
const LEGACY_PROTOCOL_VERSION = '2025-11-25'
const RELEASE_VERSION = readJson('package.json').version

const EXPECTED_PUBLIC_TOOL_NAMES = [
  'portal_list_networks',
  'portal_get_network_info',
  'portal_get_head',
  'portal_resolve_entity',
  'portal_get_recent_activity',
  'portal_get_wallet_summary',
  'portal_get_time_series',
  'portal_evm_query_logs',
  'portal_evm_query_transactions',
  'portal_evm_query_traces',
  'portal_evm_query_token_transfers',
  'portal_evm_get_contract_deployment',
  'portal_evm_get_contract_activity',
  'portal_evm_get_analytics',
  'portal_evm_get_ohlc',
  'portal_solana_query_instructions',
  'portal_solana_query_transactions',
  'portal_solana_get_analytics',
  'portal_bitcoin_query_transactions',
  'portal_bitcoin_get_analytics',
  'portal_substrate_query_events',
  'portal_substrate_query_calls',
  'portal_substrate_get_analytics',
  'portal_hyperliquid_query_fills',
  'portal_hyperliquid_get_analytics',
  'portal_hyperliquid_get_ohlc',
  'portal_tron_query_transactions',
  'portal_tron_query_logs',
  'portal_debug_query_blocks',
  'portal_debug_resolve_time_to_block',
  'portal_debug_hyperliquid_query_replica_commands',
] as const

const EXPECTED_STARTER_PROMPTS = [
  'Show me the last 200 BTC perp fills on Hyperliquid.',
  'How many transactions landed on Base in the past 2h?',
  'Show me the latest 20 USDC transfers on Base from the past hour.',
] as const

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`)
  }
}

function readJson(path: string): JsonObject {
  return JSON.parse(readFileSync(path, 'utf8')) as JsonObject
}

function assertString(value: unknown, message: string): asserts value is string {
  assert(typeof value === 'string' && value.trim().length > 0, message)
}

function assertRecord(value: unknown, message: string): asserts value is JsonObject {
  assert(Boolean(value) && typeof value === 'object' && !Array.isArray(value), message)
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

function assertOptionalAsset(pluginRoot: string, value: unknown, field: string) {
  if (value === undefined) return
  assertString(value, `${field} must be a string when present`)
  assert(value.startsWith('./assets/'), `${field} must live under ./assets/`)
  assert(existsSync(resolve(pluginRoot, value)), `${field} points to a missing asset: ${value}`)
}

function assertSquarePng(path: string, minimumSize: number) {
  const image = readFileSync(path)
  assert(image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), `${path} must be a PNG file`)
  const width = image.readUInt32BE(16)
  const height = image.readUInt32BE(20)
  assert(width === height, `${path} must be square`)
  assert(width >= minimumSize, `${path} must be at least ${minimumSize} x ${minimumSize}`)
}

function assertSquareLogoVariants(pluginRoot: string, interfaceConfig: JsonObject) {
  assertString(interfaceConfig.logo, 'interface.logo must be a string')
  assertString(interfaceConfig.logoDark, 'interface.logoDark must be a string')
  const lightSurfaceLogo = readFileSync(resolve(pluginRoot, interfaceConfig.logo), 'utf8')
  const darkSurfaceLogo = readFileSync(resolve(pluginRoot, interfaceConfig.logoDark), 'utf8')
  assert(
    lightSurfaceLogo.includes('<rect width="305" height="305" transform="translate(0.117798 0.453125)" fill="black"/>'),
    'interface.logo must use the black-background SQD square symbol',
  )
  assert(lightSurfaceLogo.includes('fill="white"'), 'interface.logo must contain the white SQD mark')
  assert(
    darkSurfaceLogo.includes('<rect width="305" height="305" transform="translate(0.117798 0.453125)" fill="black"/>'),
    'interface.logoDark must use the black-background SQD square symbol',
  )
  assert(darkSurfaceLogo.includes('fill="white"'), 'interface.logoDark must contain the white SQD mark')
}

function assertComposerIcon(pluginRoot: string, value: unknown) {
  assertString(value, 'interface.composerIcon must be a string')
  assert(
    value === './assets/sqd-composer-icon.svg',
    'plugin should use the trimmed SQD composer icon in prompt previews',
  )
  const composerIcon = readFileSync(resolve(pluginRoot, value), 'utf8')
  assert(
    composerIcon.includes(
      '<rect width="305" height="305" rx="42" transform="translate(0.117798 0.453125)" fill="black"/>',
    ),
    'interface.composerIcon must use a softened black SQD square for prompt previews',
  )
  assert(composerIcon.includes('fill="white"'), 'interface.composerIcon must contain the white SQD mark')
}

function assertPromptList(value: unknown) {
  assert(Array.isArray(value), 'interface.defaultPrompt must be an array')
  assert(value.length > 0 && value.length <= 3, 'interface.defaultPrompt must contain 1-3 prompts')
  assert(
    JSON.stringify(value) === JSON.stringify(EXPECTED_STARTER_PROMPTS),
    'interface.defaultPrompt should stay concrete and analysis-oriented',
  )
  for (const [index, prompt] of value.entries()) {
    assertString(prompt, `interface.defaultPrompt[${index}] must be a non-empty string`)
    assert(prompt.length <= 128, `interface.defaultPrompt[${index}] must be at most 128 characters`)
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
            name: 'portal-mcp-plugin-release-gate',
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
      'x-mcp-client-name': 'portal-mcp-plugin-release-gate',
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

function assertManifest() {
  const manifest = readJson(PLUGIN_JSON_PATH)
  assert(manifest.name === 'portal', 'plugin name should be portal')
  assert(manifest.version === RELEASE_VERSION, 'plugin version should match the package release version')
  assert(manifest.skills === './skills/', 'plugin should load the bundled official SQD skills')
  assert(manifest.mcpServers === './.mcp.json', 'plugin should reference ./.mcp.json')
  assertRecord(manifest.interface, 'plugin interface must be an object')
  assert(manifest.interface.displayName === 'SQD', 'plugin display name should be SQD')
  assert(
    manifest.interface.shortDescription === 'Query blockchain data across 130+ networks.',
    'plugin short description should lead with broad network coverage',
  )
  const publicCopy = [
    manifest.description,
    manifest.interface.shortDescription,
    manifest.interface.longDescription,
    ...(manifest.interface.defaultPrompt as unknown[]),
  ].join(' ')
  for (const phrase of [
    'blockchain',
    '130+ networks',
    'Ethereum',
    'Base',
    'Solana',
    'Bitcoin',
    'Tron',
    'Polkadot',
    'Hyperliquid',
    'Pipes SDK',
    'Squid SDK',
  ]) {
    assert(publicCopy.toLowerCase().includes(phrase.toLowerCase()), `plugin copy should include ${phrase}`)
  }
  assert(!/[\u2014\u2013]/.test(publicCopy), 'plugin copy should not use em or en dashes')
  assert(!/\b(onchain|EVM|Substrate|MCP)\b/.test(publicCopy), 'plugin copy should avoid unexplained jargon')
  assert(
    manifest.interface.websiteURL === 'https://sqd.dev/portal/',
    'plugin website should point at the SQD Portal product page',
  )
  assert(
    manifest.interface.privacyPolicyURL === 'https://sqd.dev/imprint/',
    'plugin privacy policy should point at SQD imprint/privacy page',
  )
  assert(manifest.interface.brandColor === '#08090A', 'plugin brand color should match SQD surface black')
  assert(
    manifest.interface.logo === './assets/sqd-logo.svg',
    'plugin should use the black SQD square logo in light mode',
  )
  assert(
    manifest.interface.logoDark === './assets/sqd-logo.svg',
    'plugin should keep the black SQD square logo in dark mode',
  )
  assertPromptList(manifest.interface.defaultPrompt)
  for (const skill of ['portal', 'pipes-sdk', 'migrate-to-portal', 'squid-perf']) {
    assert(existsSync(resolve(PLUGIN_ROOT, 'skills', skill, 'SKILL.md')), `plugin should bundle the ${skill} skill`)
  }
  const skillsSource = readFileSync(SKILLS_SOURCE_PATH, 'utf8')
  assert(
    skillsSource.includes('66aebe851af0258bf9d38c0bc43fcbb33ae7e47d'),
    'bundled skills should record the verified upstream commit',
  )
  const portalSkill = readFileSync(resolve(PLUGIN_ROOT, 'skills/portal/SKILL.md'), 'utf8')
  const portalResultContract = readFileSync(resolve(PLUGIN_ROOT, 'skills/portal/references/mcp-results.md'), 'utf8')
  for (const required of [
    'tools/list',
    'sqd://tools',
    '_server',
    '_evidence',
    '_coverage',
    '_pagination',
    '_app',
    '_ui',
    'https://portal.sqd.dev/mcp/health',
  ]) {
    assert(
      `${portalSkill}\n${portalResultContract}`.includes(required),
      `bundled Portal skill should document ${required}`,
    )
  }
  assert(
    portalSkill.includes('The duplicate HTTP `/tools` endpoint is retired.'),
    'bundled Portal skill should not route agents to the retired HTTP /tools endpoint',
  )
  assert(
    !/[\u2014\u2013]/.test(`${portalSkill}\n${portalResultContract}`),
    'bundled Portal MCP guidance should not use em or en dashes',
  )
  assertOptionalAsset(PLUGIN_ROOT, manifest.interface.composerIcon, 'interface.composerIcon')
  assertOptionalAsset(PLUGIN_ROOT, manifest.interface.logo, 'interface.logo')
  assertOptionalAsset(PLUGIN_ROOT, manifest.interface.logoDark, 'interface.logoDark')
  assertComposerIcon(PLUGIN_ROOT, manifest.interface.composerIcon)
  assertSquareLogoVariants(PLUGIN_ROOT, manifest.interface)
  assertSquarePng(OPENAI_DIRECTORY_ICON_PATH, 256)
  assertSquarePng(OPENAI_COMPOSER_ICON_PATH, 48)
  const screenshots = manifest.interface.screenshots
  if (screenshots !== undefined) {
    assert(Array.isArray(screenshots), 'interface.screenshots must be an array when present')
    screenshots.forEach((screenshot, index) =>
      assertOptionalAsset(PLUGIN_ROOT, screenshot, `interface.screenshots[${index}]`),
    )
  }
  assertNoCommittedSecretOrLocalPath(manifest)

  for (const path of [README_PATH, DIRECTORY_SUBMISSION_PATH]) {
    const copy = readFileSync(path, 'utf8')
    assert(!/[\u2014\u2013]/.test(copy), `${path} should not use em or en dashes`)
  }
  const directorySubmission = readFileSync(DIRECTORY_SUBMISSION_PATH, 'utf8')
  assert(
    directorySubmission.includes('https://sqd.dev/brand/Symbol_bl-bg.svg'),
    'directory submission should use the canonical public black-background SQD logo',
  )
}

function assertMarketplace() {
  const marketplace = readJson(MARKETPLACE_PATH)
  assert(marketplace.name === 'sqd', 'marketplace name should be sqd')
  assertRecord(marketplace.interface, 'marketplace interface must be an object')
  assert(marketplace.interface.displayName === 'SQD', 'marketplace display name should be SQD')
  assert(Array.isArray(marketplace.plugins), 'marketplace.plugins must be an array')
  const entry = marketplace.plugins.find((plugin) => plugin?.name === 'portal') as JsonObject | undefined
  assertRecord(entry, 'marketplace should include portal')
  assertRecord(entry.source, 'marketplace source must be an object')
  assert(entry.source.source === 'local', 'marketplace source.source should be local')
  assert(entry.source.path === './plugins/portal', 'marketplace source.path should stay stable')
  assertRecord(entry.policy, 'marketplace policy must be an object')
  assert(entry.policy.installation === 'AVAILABLE', 'marketplace installation policy should be AVAILABLE')
  assert(entry.policy.authentication === 'ON_INSTALL', 'marketplace authentication policy should be ON_INSTALL')
  assert(entry.category === 'Data & Analytics', 'marketplace category should be Data & Analytics')
}

function assertChatgptSubmission() {
  const submission = readJson(CHATGPT_SUBMISSION_PATH)
  assert(
    submission.$schema === 'https://developers.openai.com/apps-sdk/schemas/chatgpt-app-submission.v1.json',
    'ChatGPT submission should use the official v1 schema',
  )
  assert(submission.schema_version === 1, 'ChatGPT submission schema_version should be 1')
  assertRecord(submission.app_info, 'ChatGPT submission app_info must be an object')
  assert(submission.app_info.display_name === 'SQD', 'ChatGPT submission display name should be SQD')
  assertString(submission.app_info.subtitle, 'ChatGPT submission subtitle must be a string')
  assert(submission.app_info.subtitle.length <= 30, 'ChatGPT submission subtitle must be at most 30 characters')
  assertString(submission.app_info.description, 'ChatGPT submission description must be a string')
  assert(submission.app_info.category === 'DEVELOPER_TOOLS', 'ChatGPT submission category should be DEVELOPER_TOOLS')

  const publicCopy = `${submission.app_info.subtitle} ${submission.app_info.description}`
  for (const phrase of [
    'blockchain',
    '130+',
    'Ethereum',
    'Base',
    'Solana',
    'Polkadot',
    'Bitcoin',
    'Tron',
    'Hyperliquid',
    'Pipes SDK',
    'Squid SDK',
  ]) {
    assert(publicCopy.toLowerCase().includes(phrase.toLowerCase()), `ChatGPT submission copy should include ${phrase}`)
  }
  assert(!/[\u2014\u2013]/.test(publicCopy), 'ChatGPT submission copy should not use em or en dashes')
  assert(!/\b(onchain|EVM|Substrate|MCP)\b/.test(publicCopy), 'ChatGPT submission copy should avoid unexplained jargon')

  assertRecord(submission.tools, 'ChatGPT submission tools must be an object')
  assert(
    JSON.stringify(Object.keys(submission.tools).sort()) === JSON.stringify([...EXPECTED_PUBLIC_TOOL_NAMES].sort()),
    'ChatGPT submission should cover exactly the 31 public tools',
  )
  for (const toolName of EXPECTED_PUBLIC_TOOL_NAMES) {
    const tool = submission.tools[toolName]
    assertRecord(tool, `ChatGPT submission should include ${toolName}`)
    assertRecord(tool.annotations, `${toolName}.annotations must be an object`)
    assert(tool.annotations.readOnlyHint === true, `${toolName} should declare readOnlyHint: true`)
    assert(tool.annotations.openWorldHint === true, `${toolName} should declare openWorldHint: true`)
    assert(tool.annotations.destructiveHint === false, `${toolName} should declare destructiveHint: false`)
    assertRecord(tool.justifications, `${toolName}.justifications must be an object`)
    for (const field of ['read_only_justification', 'open_world_justification', 'destructive_justification']) {
      assertString(tool.justifications[field], `${toolName}.${field} must be a non-empty string`)
      assert(
        (tool.justifications[field] as string).trim().endsWith('.'),
        `${toolName}.${field} should be one complete sentence`,
      )
    }
  }

  assert(Array.isArray(submission.test_cases), 'ChatGPT submission test_cases must be an array')
  assert(submission.test_cases.length === 5, 'ChatGPT submission should include exactly 5 positive test cases')
  assert(
    JSON.stringify(submission.test_cases.slice(0, 3).map((value) => value.user_prompt)) ===
      JSON.stringify(EXPECTED_STARTER_PROMPTS),
    'ChatGPT submission should use the Codex starter prompts as its first three positive tests',
  )
  for (const [index, value] of submission.test_cases.entries()) {
    assertRecord(value, `test_cases[${index}] must be an object`)
    assertString(value.description, `test_cases[${index}].description must be a string`)
    assertString(value.user_prompt, `test_cases[${index}].user_prompt must be a string`)
    assert(
      EXPECTED_PUBLIC_TOOL_NAMES.includes(value.tools_triggered as (typeof EXPECTED_PUBLIC_TOOL_NAMES)[number]),
      `test_cases[${index}].tools_triggered must be an exact public tool name`,
    )
    assertString(value.expected_output, `test_cases[${index}].expected_output must be a string`)
    assert(value.file_attachment_urls === null, `test_cases[${index}] should not include file attachments`)
    assert(value.expected_output_url === null, `test_cases[${index}] should not include an output URL`)
  }

  assert(Array.isArray(submission.negative_test_cases), 'ChatGPT submission negative_test_cases must be an array')
  assert(submission.negative_test_cases.length === 3, 'ChatGPT submission should include exactly 3 negative test cases')
  for (const [index, value] of submission.negative_test_cases.entries()) {
    assertRecord(value, `negative_test_cases[${index}] must be an object`)
    assertString(value.description, `negative_test_cases[${index}].description must be a string`)
    assertString(value.user_prompt, `negative_test_cases[${index}].user_prompt must be a string`)
    assert(value.tools_triggered === null, `negative_test_cases[${index}].tools_triggered must be null`)
    assertString(value.expected_output, `negative_test_cases[${index}].expected_output must be a string`)
    assert(value.file_attachment_urls === null, `negative_test_cases[${index}] should not include file attachments`)
    assert(value.expected_output_url === null, `negative_test_cases[${index}] should not include an output URL`)
  }
  assertNoCommittedSecretOrLocalPath(submission)
}

function getEndpoint() {
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

async function assertHostedMcp(endpoint: string) {
  const init = await postRpc(endpoint, 'initialize', {
    protocolVersion: LEGACY_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'portal-mcp-plugin-release-gate', version: '1.0.0' },
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
      'Codex plugin should advertise MCP 2026-07-28',
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
  const unreviewed = [...toolNames].filter((name) => !(EXPECTED_PUBLIC_TOOL_NAMES as readonly string[]).includes(name))
  assert(unreviewed.length === 0, `hosted tools/list exposes tools outside the reviewed list: ${unreviewed.join(', ')}`)
  // The hosted endpoint may still run the previous release while this
  // candidate is under review; tools it does not list yet are reported, not
  // failed, so the gate stays about the package and the submission.
  const notYetHosted = EXPECTED_PUBLIC_TOOL_NAMES.filter((name) => !toolNames.has(name))
  if (notYetHosted.length > 0) {
    console.log(
      `NOTE  hosted MCP v${String(init.serverInfo.version ?? 'unknown')} lists ${toolNames.size} of the ${EXPECTED_PUBLIC_TOOL_NAMES.length} reviewed tools; not deployed yet: ${notYetHosted.join(', ')}`,
    )
  }
  if (REQUIRE_OPENAI_LIVE_METADATA) {
    for (const value of list.tools) {
      assertRecord(value, 'each live MCP tool must be an object')
      assertString(value.title, `${String(value.name)} must expose a review-facing title`)
      assertRecord(value.annotations, `${String(value.name)} must expose annotations`)
      assert(value.annotations.readOnlyHint === true, `${String(value.name)} must expose readOnlyHint: true`)
      assert(value.annotations.openWorldHint === true, `${String(value.name)} must expose openWorldHint: true`)
      assert(value.annotations.destructiveHint === false, `${String(value.name)} must expose destructiveHint: false`)
    }
  }

  const discovery = await postRpc(endpoint, 'tools/call', {
    name: 'portal_list_networks',
    arguments: { query: 'base', limit: 1 },
  })
  const text = (discovery.content as JsonObject[] | undefined)?.find((item) => item.type === 'text')?.text
  assertString(text, 'portal_list_networks should return text content')
  const body = JSON.parse(text) as JsonObject
  assert(Array.isArray(body.items) && body.items.length > 0, 'portal_list_networks should return at least one item')
}

async function main() {
  assertManifest()
  assertMarketplace()
  assertChatgptSubmission()
  const endpoint = getEndpoint()
  await assertHostedMcp(endpoint)
  console.log(
    `Codex plugin release gate passed: manifest, marketplace, OpenAI submission, assets, and hosted MCP smoke are valid${REQUIRE_OPENAI_LIVE_METADATA ? ' with strict live metadata' : ''}${REQUIRE_MCP_2026_LIVE ? ' with live MCP 2026-07-28' : ''}`,
  )
}

await main()
