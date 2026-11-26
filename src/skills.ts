import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import type { McpServer } from '@modelcontextprotocol/server'
import { type SkillCatalog, type SkillFiles, SkillsExtension } from '@modelcontextprotocol/server/ext/skills'
import { nodeSkillFiles } from '@modelcontextprotocol/server/ext/skills/node'

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url))

function hasAnySkillFolder(dir: string): boolean {
  if (!existsSync(dir)) return false
  try {
    return readdirSync(dir, { withFileTypes: true }).some(
      (entry) => entry.isDirectory() && existsSync(path.join(dir, entry.name, 'SKILL.md')),
    )
  } catch {
    return false
  }
}

/**
 * Resolve the directory containing SQD's bundled skill folders.
 * When running from `dist/`, prefers the packaged `dist/skills` directory;
 * when running from `src/` during development, prefers `plugins/portal/skills`
 * so source edits are not shadowed by a stale build output.
 */
export function resolveSkillsDirectory(): string | undefined {
  const runningFromSource = path.basename(MODULE_DIR) === 'src'
  const candidates = runningFromSource
    ? [path.resolve(MODULE_DIR, '../plugins/portal/skills'), path.resolve(MODULE_DIR, '../dist/skills')]
    : [
        path.resolve(MODULE_DIR, 'skills'),
        path.resolve(MODULE_DIR, '../dist/skills'),
        path.resolve(MODULE_DIR, '../plugins/portal/skills'),
      ]
  for (const candidate of candidates) {
    if (hasAnySkillFolder(candidate)) {
      return candidate
    }
  }
  return undefined
}

/**
 * Wrap `nodeSkillFiles` so non-directory metadata files at the skills root
 * (such as `SOURCE.md` in `plugins/portal/skills`) are ignored cleanly instead
 * of generating catalog warnings.
 */
function createPortalSkillFiles(root: string): SkillFiles {
  const inner = nodeSkillFiles(root)
  return {
    async list(dir: string) {
      const entries = await inner.list(dir)
      if (dir === '') {
        return entries.filter((entry) => entry.kind === 'directory')
      }
      return entries
    },
    read(relativePath: string) {
      return inner.read(relativePath)
    },
  }
}

async function loadPortalSkillCatalog(): Promise<SkillCatalog | undefined> {
  const root = resolveSkillsDirectory()
  if (!root) return undefined
  try {
    return await SkillsExtension.load(createPortalSkillFiles(root), {
      cacheHint: { ttlMs: 300_000, cacheScope: 'public' },
      onWarning(warning) {
        console.error(`[mcp:skills] ${warning.path}: ${warning.message}`)
      },
    })
  } catch (error) {
    console.error('[mcp:skills] Failed to load bundled skills:', error instanceof Error ? error.message : String(error))
    return undefined
  }
}

const PORTAL_SKILL_CATALOG = await loadPortalSkillCatalog()

export function getPortalSkillCatalog(): SkillCatalog | undefined {
  return PORTAL_SKILL_CATALOG
}

/**
 * Attach SQD's bundled MCP Skills extension (SEP-2640 / `io.modelcontextprotocol/skills`)
 * so both stdio and remote Streamable HTTP clients can discover and read
 * `portal`, `pipes-sdk`, `migrate-to-portal`, and `squid-perf` via
 * `skills/list`, `skills/get`, and `skill://` resource reads.
 */
export function attachPortalSkills(server: McpServer): void {
  PORTAL_SKILL_CATALOG?.attach(server)
}
