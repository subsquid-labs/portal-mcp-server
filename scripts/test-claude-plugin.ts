#!/usr/bin/env tsx

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

type JsonObject = Record<string, unknown>

const PLUGIN_ROOT = 'plugins/portal'
const MARKETPLACE_PATH = '.claude-plugin/marketplace.json'
const PLUGIN_JSON_PATH = `${PLUGIN_ROOT}/.claude-plugin/plugin.json`
const MCP_JSON_PATH = `${PLUGIN_ROOT}/.mcp.json`
const DISCOVERY_TERMS = ['blockchain', 'onchain', 'Hyperliquid', 'Bitcoin', 'Solana']

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`)
  }
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

function assertDiscoveryDescription(value: unknown, field: string) {
  assertString(value, `${field} must be a string`)
  for (const term of DISCOVERY_TERMS) {
    assert(value.toLowerCase().includes(term.toLowerCase()), `${field} should mention ${term}`)
  }
}

function assertDiscoveryKeywords(value: unknown, field: string) {
  assert(Array.isArray(value), `${field} must be an array`)
  const keywords = value.map((keyword) => String(keyword).toLowerCase())
  for (const term of DISCOVERY_TERMS) {
    assert(keywords.includes(term.toLowerCase()), `${field} should include ${term.toLowerCase()}`)
  }
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

function parseSseJson(text: string) {
  const dataLine = text
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.startsWith('data: '))
  assert(Boolean(dataLine), `Expected SSE data line, got: ${text.slice(0, 240)}`)
  return JSON.parse(dataLine!.slice('data: '.length)) as JsonObject
}

async function postRpc(endpoint: string, method: string, params: JsonObject) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'x-mcp-client-name': 'portal-mcp-claude-plugin-release-gate',
      'x-mcp-client-version': '1.0.0',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: method, method, params }),
  })
  const text = await response.text()
  assert(response.ok, `RPC ${method} should return HTTP 2xx, got ${response.status}: ${text.slice(0, 240)}`)
  const parsed = parseSseJson(text)
  assert(!parsed.error, `RPC ${method} returned JSON-RPC error: ${JSON.stringify(parsed.error)}`)
  return parsed.result as JsonObject
}

function assertMarketplace() {
  const marketplace = readJson(MARKETPLACE_PATH)
  assert(marketplace.name === 'sqd', 'Claude marketplace name should be sqd')
  assertDiscoveryDescription(marketplace.description, 'Claude marketplace description')
  assertRecord(marketplace.owner, 'Claude marketplace owner must be an object')
  assert(marketplace.owner.name === 'Subsquid Labs', 'Claude marketplace owner should be Subsquid Labs')
  assert(marketplace.version === '0.8.0', 'Claude marketplace version should match the plugin release')
  assert(Array.isArray(marketplace.plugins), 'Claude marketplace plugins must be an array')
  const entry = marketplace.plugins.find((plugin) => plugin?.name === 'portal') as JsonObject | undefined
  assertRecord(entry, 'Claude marketplace should include portal')
  assert(entry.source === './plugins/portal', 'Claude marketplace portal source should point at ./plugins/portal')
  assert(entry.displayName === 'SQD', 'Claude marketplace display name should be SQD')
  assertDiscoveryDescription(entry.description, 'Claude marketplace plugin description')
  assertDiscoveryKeywords(entry.keywords, 'Claude marketplace plugin keywords')
  assert(entry.version === '0.8.0', 'Claude marketplace plugin entry version should be 0.8.0')
  assertNoCommittedSecretOrLocalPath(marketplace)
}

function getEndpoint() {
  const manifest = readJson(PLUGIN_JSON_PATH)
  assert(manifest.name === 'portal', 'Claude plugin name should be portal')
  assert(manifest.displayName === 'SQD', 'Claude plugin display name should be SQD')
  assertDiscoveryDescription(manifest.description, 'Claude plugin description')
  assertDiscoveryKeywords(manifest.keywords, 'Claude plugin keywords')
  assert(manifest.version === '0.8.0', 'Claude plugin version should be 0.8.0')
  assert(manifest.skills === './skills/', 'Claude plugin should reference bundled skills')
  assert(manifest.mcpServers === './.mcp.json', 'Claude plugin should reference ./.mcp.json')
  assert(existsSync(resolve(PLUGIN_ROOT, '.mcp.json')), 'Claude plugin MCP config should exist')
  assert(existsSync(resolve(PLUGIN_ROOT, 'skills/portal/SKILL.md')), 'Claude plugin should bundle the Portal skill')
  assert(
    existsSync(resolve(PLUGIN_ROOT, 'skills/pipes-sdk/SKILL.md')),
    'Claude plugin should bundle the Pipes SDK skill',
  )
  assertNoCommittedSecretOrLocalPath(manifest)

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
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'portal-mcp-claude-plugin-release-gate', version: '1.0.0' },
  })
  assertRecord(init.serverInfo, 'initialize should return serverInfo')
  assert(init.serverInfo.name === 'sqd-portal-mcp-server', 'unexpected MCP server name')

  const list = await postRpc(endpoint, 'tools/list', {})
  assert(Array.isArray(list.tools), 'tools/list should return tools array')
  const toolNames = new Set(list.tools.map((tool) => (tool as JsonObject).name))
  assert(toolNames.has('portal_list_networks'), 'tools/list should include portal_list_networks')
  assert(toolNames.has('portal_resolve_entity'), 'tools/list should include portal_resolve_entity')
}

async function main() {
  assertMarketplace()
  const endpoint = getEndpoint()
  await assertHostedMcp(endpoint)
  console.log('Claude plugin release gate passed: marketplace, manifest, skills, and hosted MCP smoke are valid')
}

await main()
