#!/usr/bin/env tsx

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'

type JsonObject = Record<string, unknown>

const PLUGIN_ROOT = 'plugins/portal'
const RELEASE_VERSION = readJson('package.json').version

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function readJson(path: string): JsonObject {
  return JSON.parse(readFileSync(path, 'utf8')) as JsonObject
}

function assertRecord(value: unknown, message: string): asserts value is JsonObject {
  assert(Boolean(value) && typeof value === 'object' && !Array.isArray(value), message)
}

function assertClaudeCompatiblePackage() {
  const manifest = readJson(`${PLUGIN_ROOT}/.claude-plugin/plugin.json`)
  assert(manifest.name === 'portal', 'Grok-compatible plugin name should be portal')
  assert(manifest.displayName === 'SQD', 'Grok-compatible plugin display name should be SQD')
  assert(
    manifest.description ===
      'Query blockchain data across supported networks with SQD Portal, including Ethereum, Base, Solana, Polkadot, Bitcoin, Tron, and Hyperliquid. The SQD plugin also includes Pipes SDK and Squid SDK skills for building, migrating, troubleshooting, and improving blockchain data projects.',
    'Grok-compatible copy should lead with broad network coverage',
  )
  assert(!/[\u2014\u2013]/.test(JSON.stringify(manifest)), 'Grok-compatible copy should not use em or en dashes')
  assert(manifest.version === RELEASE_VERSION, 'Grok-compatible plugin version should match the package release')
  assert(manifest.mcpServers === './.mcp.json', 'Grok-compatible plugin should reference ./.mcp.json')
  for (const skill of ['portal', 'pipes-sdk', 'migrate-to-portal', 'squid-perf']) {
    assert(
      existsSync(`${PLUGIN_ROOT}/skills/${skill}/SKILL.md`),
      `Grok-compatible package should include the ${skill} skill`,
    )
  }
  assert(!existsSync(`${PLUGIN_ROOT}/.grok-plugin`), 'Do not invent a Grok-only manifest format')

  const mcp = readJson(`${PLUGIN_ROOT}/.mcp.json`)
  assertRecord(mcp.mcpServers, '.mcp.json should contain mcpServers')
  assertRecord(mcp.mcpServers.SQD, '.mcp.json should contain SQD')
  assert(mcp.mcpServers.SQD.type === 'http', 'Grok should use the public HTTP MCP transport')
  assert(mcp.mcpServers.SQD.url === 'https://portal.sqd.dev/mcp', 'Grok should use the canonical MCP URL')
  assert(!JSON.stringify(mcp).match(/api[_-]?key|authorization|bearer/i), 'Grok package must not require credentials')
}

function assertWithInstalledGrokCli() {
  const result = spawnSync('grok', ['plugin', 'validate', PLUGIN_ROOT], { encoding: 'utf8' })
  if (result.error && (result.error as NodeJS.ErrnoException).code === 'ENOENT') {
    console.log('SKIP  Grok Build CLI is not installed; static compatibility checks passed')
    return
  }
  assert(result.status === 0, `grok plugin validate failed: ${result.stderr || result.stdout}`)
  assert(result.stdout.includes('Plugin manifest is valid.'), 'Grok Build should accept the Claude-compatible package')
  console.log('PASS  Grok Build validates the Claude-compatible plugin package')
}

assertClaudeCompatiblePackage()
assertWithInstalledGrokCli()
console.log('Grok plugin release gate passed')
