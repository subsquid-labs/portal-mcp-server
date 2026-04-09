import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { resolveDataset, validateBlockRange } from '../../cache/datasets.js'
import { PORTAL_URL } from '../../constants/index.js'
import { detectChainType, isL2Chain } from '../../helpers/chain.js'
import { getBlockFields } from '../../helpers/field-presets.js'
import { portalFetchStreamRange } from '../../helpers/fetch.js'
import { buildBitcoinBlockFields, buildEvmBlockFields } from '../../helpers/fields.js'
import { formatResult } from '../../helpers/format.js'
import { hexToNumber, weiToGwei } from '../../helpers/formatting.js'
import { buildPaginationInfo, decodeRecentPageCursor, encodeRecentPageCursor, paginateAscendingItems } from '../../helpers/pagination.js'
import { buildQueryCoverage, buildQueryFreshness } from '../../helpers/result-metadata.js'
import { getTimestampWindowNotices, type TimestampInput, resolveTimeframeOrBlocks } from '../../helpers/timeframe.js'

// ============================================================================
// Tool: Query Blocks (EVM)
// ============================================================================

type QueryBlocksRequest = {
  timeframe?: string
  from_timestamp?: TimestampInput
  to_timestamp?: TimestampInput
  limit: number
  finalized_only: boolean
  include_l2_fields: boolean
  field_preset: 'minimal' | 'standard' | 'full'
}

type BlockItem = Record<string, unknown> & {
  number?: number
  header?: {
    number?: number
  }
}

function getBlockNumber(item: BlockItem): number | undefined {
  if (typeof item.number === 'number') return item.number
  if (typeof item.header?.number === 'number') return item.header.number
  return undefined
}

function sortBlocks(items: BlockItem[]) {
  return items.sort((left, right) => (getBlockNumber(left) ?? 0) - (getBlockNumber(right) ?? 0))
}

export function registerQueryBlocksTool(server: McpServer) {
  server.tool(
    'portal_query_blocks',
    'Query recent block data from EVM, Solana, or Bitcoin datasets',
    {
      dataset: z.string().optional().describe('Dataset name or alias. Optional when continuing with cursor.'),
      timeframe: z
        .string()
        .optional()
        .describe("Time range (e.g., '1h', '24h'). Alternative to from_block/to_block."),
      from_block: z.number().optional().describe('Starting block number (use this OR timeframe)'),
      to_block: z.number().optional().describe('Ending block number'),
      from_timestamp: z
        .union([z.number(), z.string()])
        .optional()
        .describe('Starting timestamp. Accepts Unix seconds, Unix milliseconds, ISO datetime, or relative input like "1h ago".'),
      to_timestamp: z
        .union([z.number(), z.string()])
        .optional()
        .describe('Ending timestamp. Accepts Unix seconds, Unix milliseconds, ISO datetime, or relative input like "now".'),
      finalized_only: z.boolean().optional().default(false).describe('Only query finalized blocks'),
      limit: z
        .number()
        .optional()
        .default(20)
        .describe('Max blocks to return (default: 20). Note: Lower default for MCP to reduce context usage.'),
      include_l2_fields: z
        .boolean()
        .optional()
        .default(false)
        .describe('Include L2-specific fields (auto-detected for L2 chains)'),
      field_preset: z
        .enum(['minimal', 'standard', 'full'])
        .optional()
        .default('standard')
        .describe(
          "Field preset for EVM datasets: 'minimal' (number+timestamp+gas), 'standard' (+hash+miner+size), 'full' (all block fields). Ignored for Solana/Bitcoin.",
        ),
      cursor: z.string().optional().describe('Continuation cursor from a previous response'),
    },
    async ({ dataset, timeframe, from_block, to_block, from_timestamp, to_timestamp, limit, include_l2_fields, finalized_only, field_preset, cursor }) => {
      const queryStartTime = Date.now()
      const paginationCursor = cursor
        ? decodeRecentPageCursor<QueryBlocksRequest>(cursor, 'portal_query_blocks')
        : undefined
      dataset = paginationCursor?.dataset ?? (dataset ? await resolveDataset(dataset) : undefined)
      if (!dataset) {
        throw new Error('dataset is required unless you are continuing with cursor.')
      }
      const chainType = detectChainType(dataset)

      if (chainType === 'hyperliquidFills' || chainType === 'hyperliquidReplicaCmds') {
        throw new Error('portal_query_blocks supports EVM, Solana, and Bitcoin datasets. Hyperliquid datasets do not expose block metadata through this tool.')
      }

      if (paginationCursor) {
        dataset = paginationCursor.dataset
        timeframe = paginationCursor.request.timeframe
        from_timestamp = paginationCursor.request.from_timestamp
        to_timestamp = paginationCursor.request.to_timestamp
        limit = paginationCursor.request.limit
        include_l2_fields = paginationCursor.request.include_l2_fields
        finalized_only = paginationCursor.request.finalized_only
        field_preset = paginationCursor.request.field_preset
      }

      // Resolve timeframe or use explicit blocks
      const resolvedBlocks = paginationCursor
        ? {
            from_block: paginationCursor.window_from_block,
            to_block: paginationCursor.window_to_block,
            range_kind:
              paginationCursor.request.from_timestamp !== undefined || paginationCursor.request.to_timestamp !== undefined
                ? 'timestamp_range'
                : paginationCursor.request.timeframe
                  ? 'timeframe'
                  : 'block_range',
          }
        : await resolveTimeframeOrBlocks({
            dataset,
            timeframe,
            from_block,
            to_block,
            from_timestamp,
            to_timestamp,
          })
      const resolvedFromBlock = resolvedBlocks.from_block
      const resolvedToBlock = resolvedBlocks.to_block

      const { validatedToBlock, head } = await validateBlockRange(
        dataset,
        resolvedFromBlock,
        resolvedToBlock ?? Number.MAX_SAFE_INTEGER,
        finalized_only,
      )
      const endBlock = validatedToBlock
      const pageToBlock = paginationCursor?.page_to_block ?? endBlock
      const cursorSkip = paginationCursor?.skip_inclusive_block ?? 0
      const startBlock = Math.max(resolvedFromBlock, pageToBlock - (limit! + cursorSkip))
      const includeL2 = chainType === 'evm' && (include_l2_fields || isL2Chain(dataset))

      const blockFields =
        chainType === 'evm'
          ? field_preset === 'full'
            ? buildEvmBlockFields(includeL2)
            : { ...getBlockFields(field_preset), ...(includeL2 ? { l1BlockNumber: true } : {}) }
          : chainType === 'bitcoin'
            ? buildBitcoinBlockFields()
            : {
                number: true,
                hash: true,
                timestamp: true,
              }

      const queryType = chainType === 'bitcoin' ? 'bitcoin' : chainType === 'solana' ? 'solana' : 'evm'

      const query = {
        type: queryType,
        fromBlock: startBlock,
        toBlock: pageToBlock,
        fields: {
          block: blockFields,
        },
        includeAllBlocks: true,
      }

      const results = await portalFetchStreamRange(`${PORTAL_URL}/datasets/${dataset}/stream`, query)

      const formattedBlocks =
        chainType !== 'evm'
          ? results
          : results.map((block: any) => {
              const header = block.header || block
              if (header.gasUsed && typeof header.gasUsed === 'string') {
                header.gasUsed = hexToNumber(header.gasUsed)
              }
              if (header.gasLimit && typeof header.gasLimit === 'string') {
                header.gasLimit = hexToNumber(header.gasLimit)
              }
              if (header.baseFeePerGas && typeof header.baseFeePerGas === 'string') {
                header.baseFeePerGas_gwei = weiToGwei(header.baseFeePerGas)
                delete header.baseFeePerGas
              }
              if (header.size && typeof header.size === 'string') {
                header.size = hexToNumber(header.size)
              }
              if (header.difficulty && typeof header.difficulty === 'string') {
                header.difficulty = hexToNumber(header.difficulty)
              }
              if (header.totalDifficulty && typeof header.totalDifficulty === 'string') {
                header.totalDifficulty = hexToNumber(header.totalDifficulty)
              }
              return block
            })

      const sortedBlocks = sortBlocks(formattedBlocks as BlockItem[])
      const page = paginateAscendingItems(
        sortedBlocks,
        limit!,
        getBlockNumber,
        paginationCursor
          ? {
              page_to_block: paginationCursor.page_to_block,
              skip_inclusive_block: paginationCursor.skip_inclusive_block,
            }
          : undefined,
      )
      const nextCursor = page.hasMore && page.nextBoundary
        ? encodeRecentPageCursor<QueryBlocksRequest>({
            tool: 'portal_query_blocks',
            dataset,
            request: {
              ...(timeframe ? { timeframe } : {}),
              ...(from_timestamp !== undefined ? { from_timestamp } : {}),
              ...(to_timestamp !== undefined ? { to_timestamp } : {}),
              limit: limit!,
              finalized_only,
              include_l2_fields,
              field_preset,
            },
            window_from_block: resolvedFromBlock,
            window_to_block: endBlock,
            page_to_block: page.nextBoundary.page_to_block,
            skip_inclusive_block: page.nextBoundary.skip_inclusive_block,
          })
        : undefined

      const notices = getTimestampWindowNotices(resolvedBlocks)
      if (nextCursor) notices.push('Older results are available via _pagination.next_cursor.')
      const freshness = buildQueryFreshness({
        finality: finalized_only ? 'finalized' : 'latest',
        headBlockNumber: head.number,
        windowToBlock: endBlock,
        resolvedWindow: resolvedBlocks,
      })
      const coverage = buildQueryCoverage({
        windowFromBlock: resolvedFromBlock,
        windowToBlock: endBlock,
        pageToBlock,
        items: page.pageItems,
        getBlockNumber,
        hasMore: page.hasMore,
      })

      return formatResult(page.pageItems, `Retrieved ${page.pageItems.length} blocks${page.hasMore ? ` from the most recent matching range (preview page limited to ${limit})` : ''}`, {
        notices,
        pagination: buildPaginationInfo(limit!, page.pageItems.length, nextCursor),
        freshness,
        coverage,
        metadata: {
          dataset,
          from_block: startBlock,
          to_block: pageToBlock,
          query_start_time: queryStartTime,
        },
      })
    },
  )
}
