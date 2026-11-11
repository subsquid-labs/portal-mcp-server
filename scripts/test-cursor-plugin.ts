#!/usr/bin/env tsx

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

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

function assertRelativePluginPath(path: unknown, field: string) {
  assert(typeof path === 'string' && path.length > 0, `${field} should be a path`)
  assert(!path.startsWith('/') && !path.split('/').includes('..'), `${field} should be relative and stay in the plugin`)
  assert(existsSync(resolve(PLUGIN_ROOT, path)), `${field} should resolve to an existing file or directory`)
}

function assertManifest() {
  const manifest = readJson(`${PLUGIN_ROOT}/.cursor-plugin/plugin.json`)
  const packageJson = readJson('package.json')
  assert(manifest.name === 'sqd', 'Cursor plugin identifier should be sqd')
  assert(manifest.displayName === 'SQD', 'Cursor display name should be SQD')
  assert(manifest.version === packageJson.version, 'Cursor plugin version should match the package version')
  assert(typeof manifest.description === 'string', 'Cursor description should be present')
  const description = manifest.description as string
  for (const phrase of [
    'blockchain',
    'supported networks',
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
    assert(description.toLowerCase().includes(phrase.toLowerCase()), `Cursor copy should include ${phrase}`)
  }
  assert(!/[\u2014\u2013]/.test(description), 'Cursor copy should not use em or en dashes')
  assert(manifest.logo === 'assets/sqd-logo.svg', 'Cursor should use the black SQD logo')
  assertRelativePluginPath(manifest.logo, 'logo')
  assertRelativePluginPath(manifest.skills, 'skills')
  assertRelativePluginPath(manifest.mcpServers, 'mcpServers')

  const logo = readFileSync(resolve(PLUGIN_ROOT, manifest.logo as string), 'utf8')
  assert(logo.includes('fill="black"'), 'Cursor logo should have a black background')
  assert(logo.includes('fill="white"'), 'Cursor logo should contain the white SQD mark')

  for (const skill of ['portal', 'pipes-sdk', 'migrate-to-portal', 'squid-perf']) {
    const skillPath = `${PLUGIN_ROOT}/skills/${skill}/SKILL.md`
    const content = readFileSync(skillPath, 'utf8')
    assert(content.startsWith('---\n'), `${skill} should have YAML frontmatter`)
    assert(new RegExp(`^name:\\s*["']?${skill}["']?\\s*$`, 'm').test(content), `${skill} should declare its name`)
    assert(/^description:\s*.+$/m.test(content), `${skill} should declare its description`)
  }

  const mcp = readJson(`${PLUGIN_ROOT}/.mcp.json`)
  assertRecord(mcp.mcpServers, 'Cursor MCP config should contain mcpServers')
  assertRecord(mcp.mcpServers.SQD, 'Cursor MCP config should contain SQD')
  assert(mcp.mcpServers.SQD.url === 'https://portal.sqd.dev/mcp', 'Cursor should use the canonical MCP URL')
  assert(!JSON.stringify(mcp).match(/api[_-]?key|authorization|bearer/i), 'Cursor package must not require credentials')
}

function assertMarketplace() {
  const marketplace = readJson('.cursor-plugin/marketplace.json')
  assert(marketplace.name === 'sqd', 'Cursor marketplace name should be sqd')
  assertRecord(marketplace.owner, 'Cursor marketplace owner should be present')
  assert(marketplace.owner.name === 'Subsquid Labs', 'Cursor marketplace owner should be Subsquid Labs')
  assertRecord(marketplace.metadata, 'Cursor marketplace metadata should be present')
  assert(marketplace.metadata.version === RELEASE_VERSION, 'Cursor marketplace should match the package release')
  assert(
    Array.isArray(marketplace.plugins) && marketplace.plugins.length === 1,
    'Cursor marketplace should list one plugin',
  )
  const entry = marketplace.plugins[0] as JsonObject
  assert(entry.name === 'sqd', 'Cursor marketplace plugin name should be sqd')
  assert(entry.source === './plugins/portal', 'Cursor marketplace should reuse the canonical plugin folder')
  assert(!/[\u2014\u2013]/.test(JSON.stringify(marketplace)), 'Cursor marketplace copy should not use em or en dashes')
}

assertManifest()
assertMarketplace()
console.log('Cursor plugin release gate passed')
