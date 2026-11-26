import { getActivityExplorerDeploymentMode } from './apps/activity-explorer.js'
import { SQD_SERVER_ICONS } from './icons.js'
import { getPortalSkillCatalog } from './skills.js'
import { npmVersion } from './version.js'

const DOCS_URL = 'https://docs.sqd.dev/en/ai/mcp-server'
const REPO_URL = 'https://github.com/subsquid-labs/portal-mcp-server'

export type ServerCardOptions = {
  /** Base origin derived from the HTTP request when available (e.g. `https://portal.sqd.dev`). */
  origin?: string
}

/**
 * Well-known MCP Server Card (`/.well-known/mcp/server-card.json`) for
 * connector directories, discovery registries, and stateless 2026-07-28 clients.
 */
export function buildServerCard(options: ServerCardOptions = {}) {
  const endpoint = options.origin ? `${options.origin.replace(/\/+$/, '')}/mcp` : '/mcp'
  const skills = getPortalSkillCatalog()?.entries.map((entry) => ({
    name: entry.frontmatter.name,
    uri: entry.uri,
    description: entry.frontmatter.description,
  }))

  return {
    schemaVersion: '2026-07-28',
    serverInfo: {
      name: 'sqd-portal-mcp-server',
      title: 'SQD',
      version: npmVersion,
      description:
        'Read-only blockchain data from SQD Portal across EVM, Solana, Bitcoin, Substrate, Hyperliquid, and Tron datasets.',
      websiteUrl: DOCS_URL,
      icons: SQD_SERVER_ICONS,
    },
    transport: {
      type: 'streamable-http',
      endpoint,
      protocolVersions: ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26'],
    },
    authentication: {
      required: false,
      type: 'none',
    },
    capabilities: {
      tools: true,
      resources: true,
      prompts: true,
      progress: true,
      elicitation: { form: true },
      extensions: {
        'io.modelcontextprotocol/ui': {
          name: 'SQD Explorer',
          stage: 'beta',
          mode: getActivityExplorerDeploymentMode(),
          mimeTypes: ['text/html;profile=mcp-app'],
        },
        ...(skills && skills.length > 0
          ? {
              'io.modelcontextprotocol/skills': {
                count: skills.length,
                skills,
              },
            }
          : {}),
      },
    },
    links: {
      documentation: DOCS_URL,
      repository: REPO_URL,
      health: '/health',
      ready: '/ready',
    },
  }
}

export const SERVER_CARD_HEADERS: Record<string, string> = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'public, max-age=300',
  'Access-Control-Allow-Origin': '*',
  'X-Content-Type-Options': 'nosniff',
}
