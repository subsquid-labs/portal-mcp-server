import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'

import { getChainAliases, getDatasets } from '../../cache/datasets.js'
import { detectChainType } from '../../helpers/chain.js'
import { formatResult } from '../../helpers/format.js'
import { registerPortalTool } from '../../helpers/mcp-registration.js'
import {
  buildPaginationInfo,
  decodeOffsetPageCursor,
  encodeOffsetPageCursor,
  paginateOffsetItems,
} from '../../helpers/pagination.js'
import { buildExecutionMetadata, buildToolDescription } from '../../helpers/tool-ux.js'

// ============================================================================
// Tool: List Datasets
// ============================================================================

type ListNetworksCursorRequest = {
  vm?: 'evm' | 'tron' | 'solana' | 'bitcoin' | 'substrate' | 'hyperliquid'
  network_type?: 'mainnet' | 'testnet' | 'devnet'
  query?: string
  real_time_only?: boolean
  limit: number
}

const FEATURED_MAINNET_ORDER = [
  'ethereum-mainnet',
  'base-mainnet',
  'arbitrum-one',
  'optimism-mainnet',
  'polygon-mainnet',
  'solana-mainnet',
  'bitcoin-mainnet',
  'hyperliquid-fills',
  'tron-mainnet',
  'polkadot',
  'binance-mainnet',
  'avalanche-mainnet',
  'zksync-mainnet',
  'linea-mainnet',
  'scroll-mainnet',
  'gnosis-mainnet',
  'monad-mainnet',
  'unichain-mainnet',
  'hyperliquid-mainnet',
  'kusama',
] as const

const FEATURED_MAINNET_RANK = new Map<string, number>(FEATURED_MAINNET_ORDER.map((dataset, index) => [dataset, index]))

export function compareNetworkRows(
  left: { network: string; type?: string; real_time?: boolean },
  right: { network: string; type?: string; real_time?: boolean },
  query?: string,
): number {
  const lowerQuery = query?.trim().toLowerCase()
  if (lowerQuery) {
    const leftExact = left.network.toLowerCase() === lowerQuery ? 0 : 1
    const rightExact = right.network.toLowerCase() === lowerQuery ? 0 : 1
    if (leftExact !== rightExact) return leftExact - rightExact
  }
  const leftFeatured = FEATURED_MAINNET_RANK.get(left.network)
  const rightFeatured = FEATURED_MAINNET_RANK.get(right.network)
  if (leftFeatured !== undefined || rightFeatured !== undefined) {
    if (leftFeatured === undefined) return 1
    if (rightFeatured === undefined) return -1
    return leftFeatured - rightFeatured
  }
  const typeRank = (type?: string) => (type === 'mainnet' ? 0 : type === 'testnet' ? 1 : 2)
  const typeDelta = typeRank(left.type) - typeRank(right.type)
  if (typeDelta !== 0) return typeDelta
  const rtDelta = Number(Boolean(right.real_time)) - Number(Boolean(left.real_time))
  if (rtDelta !== 0) return rtDelta
  return left.network.localeCompare(right.network)
}

export function registerListDatasetsTool(server: McpServer) {
  registerPortalTool(
    server,
    'portal_list_networks',
    buildToolDescription('portal_list_networks'),
    {
      vm: z
        .enum(['evm', 'tron', 'solana', 'bitcoin', 'substrate', 'hyperliquid'])
        .optional()
        .describe('Filter by VM family'),
      network_type: z.enum(['mainnet', 'testnet', 'devnet']).optional().describe('Filter by network type'),
      query: z.string().optional().describe('Search by name, alias, or chain ID'),
      real_time_only: z.boolean().optional().describe('Only show networks with a real-time indexed head'),
      limit: z.number().max(100).optional().default(25).describe('Max results to return (default: 25, max: 100)'),
      cursor: z.string().optional().describe('Continuation cursor from a previous network catalog page'),
    },
    async ({ vm, network_type, query, real_time_only, limit, cursor }) => {
      const paginationCursor = cursor
        ? decodeOffsetPageCursor<ListNetworksCursorRequest>(cursor, 'portal_list_networks')
        : undefined

      if (paginationCursor) {
        vm = paginationCursor.request.vm
        network_type = paginationCursor.request.network_type
        query = paginationCursor.request.query
        real_time_only = paginationCursor.request.real_time_only
        limit = paginationCursor.request.limit
      }

      const request: ListNetworksCursorRequest = {
        ...(vm ? { vm } : {}),
        ...(network_type ? { network_type } : {}),
        ...(query ? { query } : {}),
        ...(real_time_only !== undefined ? { real_time_only } : {}),
        limit,
      }
      const currentOffset = paginationCursor?.offset ?? 0
      let datasets = await getDatasets()

      if (vm) {
        datasets = datasets.filter((d) => {
          const kind = d.metadata?.kind ?? detectChainType(d.dataset)
          if (vm === 'hyperliquid') {
            return kind === 'hyperliquidFills' || kind === 'hyperliquidReplicaCmds'
          }
          return kind === vm
        })
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
            return (
              name.includes('mainnet') ||
              (!name.includes('testnet') &&
                !name.includes('devnet') &&
                !name.includes('sepolia') &&
                !name.includes('holesky') &&
                !name.includes('goerli'))
            )
          }
          if (network_type === 'testnet') {
            return (
              name.includes('testnet') ||
              name.includes('sepolia') ||
              name.includes('holesky') ||
              name.includes('goerli')
            )
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
          // The resolver accepts these nicknames, so the catalog must find them too.
          if (getChainAliases(d.dataset).some((a) => a === lower || a.includes(lower))) return true
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
        const kind = d.metadata?.kind ?? detectChainType(d.dataset)
        // Infer correct network type (Portal metadata has bugs)
        const name = d.dataset.toLowerCase()
        let inferredType = d.metadata?.type
        if (
          name.includes('testnet') ||
          name.includes('sepolia') ||
          name.includes('holesky') ||
          name.includes('goerli')
        ) {
          inferredType = 'testnet'
        } else if (name.includes('devnet')) {
          inferredType = 'devnet'
        } else if (
          name.includes('mainnet') ||
          name.includes('-fills') ||
          name.includes('-replica-cmds') ||
          (!name.includes('testnet') && !name.includes('devnet'))
        ) {
          // If name doesn't contain testnet/devnet keywords, assume mainnet
          // This catches datasets like "arbitrum-one", "arbitrum-nova", etc.
          inferredType = 'mainnet'
        }
        const aliases = [...new Set([...d.aliases, ...getChainAliases(d.dataset)])]
        return {
          network: d.dataset,
          aliases: aliases.length > 0 ? aliases : undefined,
          vm: kind === 'hyperliquidFills' || kind === 'hyperliquidReplicaCmds' ? 'hyperliquid' : kind,
          type: inferredType,
          chain_id: d.metadata?.evm?.chain_id,
          display_name: d.metadata?.display_name,
          real_time: d.real_time,
          tables: d.schema?.tables ? Object.keys(d.schema.tables) : undefined,
        }
      })

      results.sort((left, right) => compareNetworkRows(left, right, query))

      const totalAvailable = results.length
      const { pageItems, hasMore, nextOffset } = paginateOffsetItems(results, limit, currentOffset)
      const nextCursor = hasMore
        ? encodeOffsetPageCursor<ListNetworksCursorRequest>({
            tool: 'portal_list_networks',
            dataset: 'network-catalog',
            request,
            offset: nextOffset ?? currentOffset + pageItems.length,
          })
        : undefined
      const pageStart = pageItems.length > 0 ? currentOffset + 1 : 0
      const pageEnd = currentOffset + pageItems.length
      const message =
        hasMore || currentOffset > 0
          ? `Found ${totalAvailable} matching networks (showing ${pageStart}-${pageEnd}).${hasMore ? ' Continue with _pagination.next_cursor to see more.' : ''}`
          : `Found ${pageItems.length} network${pageItems.length === 1 ? '' : 's'}.`

      return formatResult(
        {
          items: pageItems,
          total_matching: totalAvailable,
          page_offset: currentOffset,
        },
        message,
        {
          toolName: 'portal_list_networks',
          pagination: buildPaginationInfo(limit, pageItems.length, nextCursor),
          ordering: {
            kind: 'catalog',
            page_order: 'portal_catalog_order',
            sorted_by: 'portal_catalog',
            direction: 'asc',
            continuation: nextCursor ? 'next_page' : 'none',
          },
          coverage: {
            kind: 'catalog_page',
            result_complete: !hasMore,
            continuation: hasMore ? 'cursor' : 'none',
            returned_items: pageItems.length,
            total_matching: totalAvailable,
          },
          execution: buildExecutionMetadata({
            limit,
          }),
        },
      )
    },
  )
}
