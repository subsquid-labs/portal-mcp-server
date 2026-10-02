import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

// Kept separate from the offline package gate, which needs only Node and npm.
export function assertWithInstalledClaudeCli(pluginRoot: string, marketplacePath: string) {
  const pluginManifestPath = `${pluginRoot}/.claude-plugin/plugin.json`
  // Directory listing fields accepted without warnings starting in Claude Code 2.1.281.
  const directoryOnlyManifestFields = ['icon', 'privacyPolicyUrl']
  const version = spawnSync('claude', ['--version'], { encoding: 'utf8' })
  if (version.error && (version.error as NodeJS.ErrnoException).code === 'ENOENT') {
    console.log('SKIP  Claude Code CLI is not installed; static package checks passed')
    return
  }
  for (const path of [pluginRoot, marketplacePath]) {
    const result = spawnSync('claude', ['plugin', 'validate', path], { encoding: 'utf8' })
    assert(result.status === 0, `claude plugin validate failed for ${path}: ${result.stderr || result.stdout}`)
  }

  const installedVersion = version.stdout
    .match(/^(\d+)\.(\d+)\.(\d+)/)
    ?.slice(1)
    .map(Number)
  const supportsListingFields =
    installedVersion &&
    (installedVersion[0] > 2 ||
      (installedVersion[0] === 2 &&
        (installedVersion[1] > 1 || (installedVersion[1] === 1 && installedVersion[2] >= 281))))
  if (supportsListingFields) {
    for (const path of [pluginRoot, marketplacePath]) {
      const result = spawnSync('claude', ['plugin', 'validate', '--strict', path], { encoding: 'utf8' })
      assert(
        result.status === 0,
        `claude plugin validate --strict failed for ${path}: ${result.stderr || result.stdout}`,
      )
    }
    console.log('PASS  Claude Code strictly validates the actual plugin and marketplace')
    return
  }

  // Older CLIs report listing fields as unknown. Check their values separately and strictly validate a copy.
  const staging = mkdtempSync(join(tmpdir(), 'sqd-claude-plugin-'))
  try {
    cpSync(dirname(marketplacePath), join(staging, dirname(marketplacePath)), { recursive: true })
    cpSync(pluginRoot, join(staging, pluginRoot), { recursive: true })
    const stagedManifestPath = join(staging, pluginManifestPath)
    const stagedManifest = JSON.parse(readFileSync(stagedManifestPath, 'utf8')) as Record<string, unknown>
    for (const field of directoryOnlyManifestFields) delete stagedManifest[field]
    writeFileSync(stagedManifestPath, `${JSON.stringify(stagedManifest, null, 2)}\n`)
    for (const path of [pluginRoot, marketplacePath]) {
      const result = spawnSync('claude', ['plugin', 'validate', '--strict', join(staging, path)], { encoding: 'utf8' })
      assert(
        result.status === 0,
        `claude plugin validate --strict failed for ${path}: ${result.stderr || result.stdout}`,
      )
    }
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
  console.log('PASS  Claude Code strictly validates the plugin and marketplace apart from the directory listing fields')
}
