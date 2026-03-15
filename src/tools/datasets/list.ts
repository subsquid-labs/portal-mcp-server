import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { getDatasets } from '../../cache/datasets.js'
import { formatResult } from '../../helpers/format.js'

// ============================================================================
// Tool: List Datasets
// ============================================================================

export function registerListDatasetsTool(server: McpServer) {
  server.tool(
    'portal_list_datasets',
    'List and search available blockchain datasets. Filter by chain type (evm/solana), network type (mainnet/testnet), or search by name. Returns dataset names, aliases, chain metadata, and available tables.',
    {
      chain_type: z.enum(['evm', 'solana', 'hyperliquidFills', 'hyperliquidReplicaCmds']).optional().describe('Filter by chain type'),
      network_type: z.enum(['mainnet', 'testnet', 'devnet']).optional().describe('Filter by network type'),
      query: z.string().optional().describe('Search by name, alias, or chain ID'),
      real_time_only: z.boolean().optional().describe('Only show real-time datasets'),
    },
    async ({ chain_type, network_type, query, real_time_only }) => {
      let datasets = await getDatasets()

      if (chain_type) {
        datasets = datasets.filter((d) => d.metadata?.kind === chain_type)
      }

      if (network_type) {
        datasets = datasets.filter((d) => {
          // Use metadata.type if available, but fall back to name heuristic
          // (Portal API metadata has many mainnets mislabeled as "testnet")
          const metaType = d.metadata?.type
          if (metaType && metaType !== 'testnet') return metaType === network_type
          // Heuristic: infer from dataset name
          const name = d.dataset.toLowerCase()
          if (network_type === 'mainnet') {
            return name.includes('mainnet') || (!name.includes('testnet') && !name.includes('devnet') && !name.includes('sepolia') && !name.includes('holesky') && !name.includes('goerli'))
          }
          if (network_type === 'testnet') {
            return name.includes('testnet') || name.includes('sepolia') || name.includes('holesky') || name.includes('goerli')
          }
          if (network_type === 'devnet') {
            return name.includes('devnet')
          }
          return metaType === network_type
        })
      }

      if (real_time_only) {
        datasets = datasets.filter((d) => d.real_time)
      }

      if (query) {
        const lower = query.toLowerCase()
        datasets = datasets.filter((d) => {
          if (d.dataset.toLowerCase().includes(lower)) return true
          if (d.aliases.some((a) => a.toLowerCase().includes(lower))) return true
          if (d.metadata?.display_name?.toLowerCase().includes(lower)) return true
          // Search by chain ID
          if (d.metadata?.evm?.chain_id?.toString() === lower) return true
          // Fuzzy: match parts
          const parts = d.dataset.toLowerCase().split('-')
          if (parts.some((part) => part.includes(lower) || lower.includes(part))) return true
          return false
        })
      }

      // Return compact results with metadata
      const results = datasets.map((d) => {
        // Infer correct network type (Portal metadata has bugs)
        const name = d.dataset.toLowerCase()
        let inferredType = d.metadata?.type
        if (name.includes('testnet') || name.includes('sepolia') || name.includes('holesky') || name.includes('goerli')) {
          inferredType = 'testnet'
        } else if (name.includes('devnet')) {
          inferredType = 'devnet'
        } else if (name.includes('mainnet') || name.includes('-fills') || name.includes('-replica-cmds') ||
          (!name.includes('testnet') && !name.includes('devnet'))) {
          // If name doesn't contain testnet/devnet keywords, assume mainnet
          // This catches datasets like "arbitrum-one", "arbitrum-nova", etc.
          inferredType = 'mainnet'
        }
        return {
          dataset: d.dataset,
          aliases: d.aliases.length > 0 ? d.aliases : undefined,
          kind: d.metadata?.kind,
          type: inferredType,
          chain_id: d.metadata?.evm?.chain_id,
          display_name: d.metadata?.display_name,
          real_time: d.real_time,
          tables: d.schema?.tables ? Object.keys(d.schema.tables) : undefined,
        }
      })

      return formatResult(results, `Found ${results.length} datasets`)
    },
  )
}
