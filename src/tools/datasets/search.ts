import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { getDatasets } from '../../cache/datasets.js'
import { formatResult } from '../../helpers/format.js'

// ============================================================================
// Tool: Search Datasets
// ============================================================================

// Common chain name aliases that users might search for
const CHAIN_ALIASES: Record<string, string[]> = {
  'hyperliquid-mainnet': ['hyperevm', 'hyperl', 'hyper'],
  'arbitrum-one': ['arbitrum', 'arb'],
  'optimism-mainnet': ['optimism', 'op'],
  'polygon-mainnet': ['polygon', 'matic'],
  'avalanche-mainnet': ['avalanche', 'avax'],
  'binance-mainnet': ['bsc', 'bnb', 'binance'],
  'base-mainnet': ['base'],
  'ethereum-mainnet': ['ethereum', 'eth'],
}

export function registerSearchDatasetsTool(server: McpServer) {
  server.tool(
    'portal_search_datasets',
    "Search datasets by query string. Supports fuzzy matching and common aliases (e.g., 'hyperevm' finds 'hyperliquid-mainnet', 'bsc' finds 'binance-mainnet').",
    {
      query: z.string().describe('Search query (chain name, network name, or alias)'),
    },
    async ({ query }) => {
      const datasets = await getDatasets()
      const lower = query.toLowerCase()

      // Find matches: exact substring, alias match, or fuzzy match
      const results = datasets.filter((d) => {
        const datasetLower = d.dataset.toLowerCase()

        // Direct substring match
        if (datasetLower.includes(lower)) return true

        // Alias match (from Portal API)
        if (d.aliases.some((a) => a.toLowerCase().includes(lower))) return true

        // Common alias match (our extended aliases)
        const aliases = CHAIN_ALIASES[d.dataset] || []
        if (aliases.some((a) => a.includes(lower) || lower.includes(a))) return true

        // Fuzzy match: query matches part of chain name
        const parts = datasetLower.split('-')
        if (parts.some((part) => part.includes(lower) || lower.includes(part))) return true

        return false
      })

      // Sort by relevance: exact matches first, then prefix matches, then others
      results.sort((a, b) => {
        const aLower = a.dataset.toLowerCase()
        const bLower = b.dataset.toLowerCase()

        if (aLower === lower) return -1
        if (bLower === lower) return 1

        if (aLower.startsWith(lower)) return -1
        if (bLower.startsWith(lower)) return 1

        return aLower.localeCompare(bLower)
      })

      return formatResult(results, `Found ${results.length} matching datasets for "${query}"`)
    },
  )
}
