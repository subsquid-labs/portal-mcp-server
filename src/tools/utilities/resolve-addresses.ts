import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { resolveDataset } from '../../cache/datasets.js'
import { getLabelsForDataset, resolveContractLabel } from '../../constants/contract-labels.js'
import { formatResult } from '../../helpers/format.js'

// ============================================================================
// Tool: Resolve Contract Addresses
// ============================================================================

/**
 * Resolve contract addresses to human-readable labels.
 * Reduces manual cross-referencing.
 */
export function registerResolveAddressesTool(server: McpServer) {
  server.tool(
    'portal_resolve_addresses',
    `Resolve contract addresses to human-readable labels (USDC, Uniswap, etc.). Avoids manual lookups.

WHEN TO USE:
- "What is 0x833589...?"
- "Identify this contract address"
- "Is this USDC or something else?"
- "Show me all known contracts on Base"

ONE CALL SOLUTION: Returns name, category, symbol for well-known contracts.

EXAMPLES:
- Single address: { dataset: "base", addresses: ["0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"] }
- Multiple: { dataset: "ethereum", addresses: ["0xa0b869...", "0xdac17f..."] }
- List all: { dataset: "base", list_all: true }

FAST: Instant lookup from built-in database. No API calls.`,
    {
      dataset: z.string().describe('Dataset name'),
      addresses: z.array(z.string()).optional().describe('Contract addresses to resolve'),
      list_all: z.boolean().optional().default(false).describe('List all known contracts for this chain'),
    },
    async ({ dataset, addresses, list_all }) => {
      const queryStartTime = Date.now()
      dataset = await resolveDataset(dataset)

      if (list_all) {
        // Return all known labels for this dataset
        const labels = getLabelsForDataset(dataset)
        const grouped = {
          tokens: labels.filter((l) => l.category === 'token'),
          dexs: labels.filter((l) => l.category === 'dex'),
          lending: labels.filter((l) => l.category === 'lending'),
          bridges: labels.filter((l) => l.category === 'bridge'),
          nfts: labels.filter((l) => l.category === 'nft'),
          other: labels.filter((l) => l.category === 'other'),
        }

        return formatResult(
          {
            total_known_contracts: labels.length,
            by_category: {
              tokens: grouped.tokens.length,
              dexs: grouped.dexs.length,
              lending: grouped.lending.length,
              bridges: grouped.bridges.length,
              nfts: grouped.nfts.length,
              other: grouped.other.length,
            },
            contracts: labels,
          },
          `Found ${labels.length} known contracts on ${dataset}`,
          {
            metadata: {
              dataset,
              query_start_time: queryStartTime,
            },
          },
        )
      }

      if (!addresses || addresses.length === 0) {
        throw new Error('Either provide addresses or set list_all=true')
      }

      // Resolve each address
      const resolved = addresses.map((addr) => {
        const label = resolveContractLabel(addr, dataset)
        if (label) {
          return {
            address: addr,
            found: true,
            name: label.name,
            category: label.category,
            symbol: label.symbol,
            website: label.website,
          }
        }
        return {
          address: addr,
          found: false,
          name: 'Unknown',
          category: 'unknown',
        }
      })

      const foundCount = resolved.filter((r) => r.found).length
      const message =
        foundCount > 0
          ? `Resolved ${foundCount}/${addresses.length} addresses`
          : `No known labels for provided addresses on ${dataset}`

      return formatResult(
        {
          resolved_addresses: resolved,
          found: foundCount,
          total: addresses.length,
        },
        message,
        {
          metadata: {
            dataset,
            query_start_time: queryStartTime,
          },
        },
      )
    },
  )
}
