#!/usr/bin/env tsx

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  GEMINI_ARCHIVE,
  GEMINI_PLATFORMS,
  geminiReleaseAssetNames,
  geminiSelectsAsset,
} from './gemini-release-assets.mjs'

type JsonObject = Record<string, unknown>

const PLUGIN_ROOT = 'plugins/portal'

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function readJson(path: string): JsonObject {
  return JSON.parse(readFileSync(path, 'utf8')) as JsonObject
}

function assertRecord(value: unknown, message: string): asserts value is JsonObject {
  assert(Boolean(value) && typeof value === 'object' && !Array.isArray(value), message)
}

function assertManifest() {
  const manifest = readJson(`${PLUGIN_ROOT}/gemini-extension.json`)
  const packageJson = readJson('package.json')
  assert(manifest.name === 'sqd', 'Gemini extension identifier should be sqd')
  assert(manifest.version === packageJson.version, 'Gemini extension version should match the package version')
  assert(typeof manifest.description === 'string', 'Gemini extension description should be present')
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
    assert(description.toLowerCase().includes(phrase.toLowerCase()), `Gemini copy should include ${phrase}`)
  }
  assert(!/[\u2014\u2013]/.test(description), 'Gemini copy should not use em or en dashes')

  assertRecord(manifest.mcpServers, 'Gemini manifest should contain mcpServers')
  assertRecord(manifest.mcpServers.SQD, 'Gemini manifest should contain the SQD server')
  assert(
    manifest.mcpServers.SQD.httpUrl === 'https://portal.sqd.dev/mcp',
    'Gemini should use the canonical Streamable HTTP endpoint',
  )
  assert(!JSON.stringify(manifest).match(/api[_-]?key|authorization|bearer/i), 'Gemini must not require credentials')

  for (const skill of ['portal', 'pipes-sdk', 'migrate-to-portal', 'squid-perf']) {
    assert(existsSync(`${PLUGIN_ROOT}/skills/${skill}/SKILL.md`), `Gemini package should include ${skill}`)
  }
}

function assertArchive() {
  const tempRoot = mkdtempSync(join(tmpdir(), 'sqd-gemini-test-'))
  const archivePath = join(tempRoot, 'sqd.tar.gz')
  try {
    const packaged = spawnSync(process.execPath, ['scripts/package-gemini-extension.mjs', archivePath], {
      encoding: 'utf8',
    })
    assert(packaged.status === 0, `Gemini packaging failed: ${packaged.stderr || packaged.stdout}`)
    const listed = spawnSync('tar', ['-tzf', archivePath], { encoding: 'utf8' })
    assert(listed.status === 0, `Gemini archive listing failed: ${listed.stderr || listed.stdout}`)
    const files = listed.stdout
      .split('\n')
      .map((file) => file.replace(/^\.\//, '').replace(/\/$/, ''))
      .filter(Boolean)
    for (const file of [
      'gemini-extension.json',
      'README.md',
      'LICENSE',
      'assets/sqd-logo.svg',
      'skills/portal/SKILL.md',
      'skills/pipes-sdk/SKILL.md',
      'skills/migrate-to-portal/SKILL.md',
      'skills/squid-perf/SKILL.md',
    ]) {
      assert(files.includes(file), `Gemini archive should include ${file}`)
    }
    for (const prefix of ['.claude-plugin', '.codex-plugin', '.cursor-plugin']) {
      assert(!files.some((file) => file.startsWith(prefix)), `Gemini archive should not duplicate ${prefix}`)
    }
    const archive = readFileSync(archivePath)
    for (const platform of GEMINI_PLATFORMS) {
      const copy = join(tempRoot, `${platform}.${GEMINI_ARCHIVE}`)
      assert(existsSync(copy), `Gemini packaging should write ${platform}.${GEMINI_ARCHIVE}`)
      assert(readFileSync(copy).equals(archive), `${platform}.${GEMINI_ARCHIVE} should match ${GEMINI_ARCHIVE}`)
    }
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
}

/*
 * `gemini extensions install <repo>` installs a release asset only when it can
 * pick one. With sqd.mcpb beside the generic archive it picked none and cloned
 * the repository root, which has no manifest.
 */
function assertGitHubInstallPicksArchive() {
  const release = ['sqd.mcpb', ...geminiReleaseAssetNames()]
  for (const [platform, arch] of [
    ['darwin', 'arm64'],
    ['darwin', 'x64'],
    ['linux', 'x64'],
    ['linux', 'arm64'],
    ['win32', 'x64'],
  ]) {
    assert(
      geminiSelectsAsset(release, platform, arch) === `${platform}.${GEMINI_ARCHIVE}`,
      `Gemini CLI on ${platform}/${arch} should install ${platform}.${GEMINI_ARCHIVE} from the release`,
    )
  }
}

assertManifest()
assertArchive()
assertGitHubInstallPicksArchive()
console.log('Gemini extension release gate passed')
