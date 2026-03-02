import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { resolveDataset } from '../../cache/datasets.js'
import { PORTAL_URL } from '../../constants/index.js'
import { portalFetch, portalFetchStream } from '../../helpers/fetch.js'
import { formatResult } from '../../helpers/format.js'
import type { BlockHead } from '../../types/index.js'

// ============================================================================
// Tool: Paginated Query
// ============================================================================

export function registerQueryPaginatedTool(server: McpServer) {
  server.tool(
    'portal_query_paginated',
    'Execute a paginated query with cursor support for large block ranges',
    {
      dataset: z.string().describe('Dataset name or alias'),
      query: z
        .object({
          fromBlock: z.number(),
          toBlock: z.number().optional(),
          fields: z.record(z.unknown()).optional(),
          includeAllBlocks: z.boolean().optional(),
          logs: z.array(z.record(z.unknown())).optional(),
          transactions: z.array(z.record(z.unknown())).optional(),
          traces: z.array(z.record(z.unknown())).optional(),
          stateDiffs: z.array(z.record(z.unknown())).optional(),
          instructions: z.array(z.record(z.unknown())).optional(),
          balances: z.array(z.record(z.unknown())).optional(),
          tokenBalances: z.array(z.record(z.unknown())).optional(),
          rewards: z.array(z.record(z.unknown())).optional(),
        })
        .describe('Query object'),
      cursor: z.string().optional().describe('Pagination cursor from previous response'),
      page_size: z.number().optional().default(100).describe('Number of blocks per page'),
    },
    async ({ dataset, query, cursor, page_size }) => {
      dataset = await resolveDataset(dataset)

      const head = await portalFetch<BlockHead>(`${PORTAL_URL}/datasets/${dataset}/head`)

      // If we have a cursor, parse it to get the starting block
      let fromBlock = query.fromBlock
      if (cursor) {
        const cursorData = JSON.parse(Buffer.from(cursor, 'base64').toString())
        fromBlock = cursorData.nextBlock
      }

      const toBlock = Math.min(fromBlock + page_size!, query.toBlock ?? head.number)

      const paginatedQuery = {
        ...query,
        fromBlock,
        toBlock,
      }

      const results = await portalFetchStream(`${PORTAL_URL}/datasets/${dataset}/stream`, paginatedQuery)

      // Generate next cursor if there's more data
      let nextCursor: string | null = null
      if (toBlock < (query.toBlock ?? head.number)) {
        nextCursor = Buffer.from(JSON.stringify({ nextBlock: toBlock })).toString('base64')
      }

      return formatResult({
        data: results,
        pagination: {
          fromBlock,
          toBlock,
          hasMore: nextCursor !== null,
          cursor: nextCursor,
        },
      })
    },
  )
}
