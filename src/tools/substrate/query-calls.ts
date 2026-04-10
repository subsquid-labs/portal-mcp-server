import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { resolveDataset, validateBlockRange } from '../../cache/datasets.js'
import { PORTAL_URL } from '../../constants/index.js'
import { detectChainType } from '../../helpers/chain.js'
import { createUnsupportedChainError } from '../../helpers/errors.js'
import { portalFetchRecentRecords } from '../../helpers/fetch.js'
import { buildSubstrateBlockFields, buildSubstrateCallFields, buildSubstrateEventFields, buildSubstrateExtrinsicFields } from '../../helpers/fields.js'
import { formatResult } from '../../helpers/format.js'
import { normalizeSubstrateCallResult } from '../../helpers/normalized-results.js'
import { buildPaginationInfo, decodeRecentPageCursor, encodeRecentPageCursor, paginateAscendingItems } from '../../helpers/pagination.js'
import { buildChronologicalPageOrdering, buildQueryCoverage, buildQueryFreshness } from '../../helpers/result-metadata.js'
import { applyResponseFormat, resolveDefaultResponseFormat, type ResponseFormat } from '../../helpers/response-modes.js'
import { getTimestampWindowNotices, type TimestampInput, resolveTimeframeOrBlocks } from '../../helpers/timeframe.js'
import { buildExecutionMetadata, buildToolDescription } from '../../helpers/tool-ux.js'
import { getValidationNotices, validateSubstrateQuerySize } from '../../helpers/validation.js'

import {
  buildSubstrateWindowLabel,
  flattenSubstrateCalls,
  getSubstrateCallSortKey,
  SUBSTRATE_INDEXING_NOTICE,
  type SubstrateCallRequest,
} from './shared.js'

type SubstrateCallCursor = {
  tool: 'portal_substrate_query_calls'
  dataset: string
  request: SubstrateCallRequest
  window_from_block: number
  window_to_block: number
  page_to_block: number
  skip_inclusive_block: number
}

type SubstrateCallItem = Record<string, unknown> & {
  block_number?: number
  primary_id?: string
}

function getBlockNumber(item: SubstrateCallItem) {
  return typeof item.block_number === 'number' ? item.block_number : undefined
}

function sortCalls(items: SubstrateCallItem[]) {
  return items.sort((left, right) => {
    const leftBlock = getBlockNumber(left) ?? 0
    const rightBlock = getBlockNumber(right) ?? 0
    if (leftBlock !== rightBlock) return leftBlock - rightBlock

    const leftKey = getSubstrateCallSortKey(left)
    const rightKey = getSubstrateCallSortKey(right)
    const compare = leftKey.localeCompare(rightKey)
    if (compare !== 0) return compare

    return String(left.primary_id ?? '').localeCompare(String(right.primary_id ?? ''))
  })
}

export function registerSubstrateQueryCallsTool(server: McpServer) {
  server.tool(
    'portal_substrate_query_calls',
    buildToolDescription('portal_substrate_query_calls'),
    {
      network: z.string().optional().describe('Substrate network name or alias. Optional when continuing with cursor.'),
      timeframe: z.string().optional().describe("Time range (e.g. '1h', '24h'). Alternative to from_block/to_block."),
      from_block: z.number().optional().describe('Starting block number'),
      to_block: z.number().optional().describe('Ending block number'),
      from_timestamp: z
        .union([z.number(), z.string()])
        .optional()
        .describe('Starting timestamp. Accepts Unix seconds, Unix milliseconds, ISO datetime, or relative input like "6h ago".'),
      to_timestamp: z
        .union([z.number(), z.string()])
        .optional()
        .describe('Ending timestamp. Accepts Unix seconds, Unix milliseconds, ISO datetime, or relative input like "now".'),
      finalized_only: z.boolean().optional().default(false).describe('Only query finalized blocks'),
      call_names: z.array(z.string()).optional().describe('Optional qualified call names like Timestamp.set or Balances.transfer_keep_alive'),
      include_subcalls: z.boolean().optional().default(false).describe('Attach direct descendant calls inline for each matching call'),
      include_extrinsic: z.boolean().optional().default(false).describe('Attach the parent extrinsic inline for each matching call'),
      include_stack: z.boolean().optional().default(false).describe('Attach the parent call stack for each matching call'),
      include_events: z.boolean().optional().default(false).describe('Attach events emitted directly by each matching call'),
      response_format: z.enum(['full', 'compact', 'summary']).optional().describe("Response format: defaults to 'compact' for chat-friendly output. Compact mode keeps requested subcalls, events, and extrinsic context in a smaller inline shape."),
      limit: z.number().optional().default(50).describe('Max calls to return'),
      cursor: z.string().optional().describe('Continuation cursor from a previous response'),
    },
    async ({ network, timeframe, from_block, to_block, from_timestamp, to_timestamp, finalized_only, call_names, include_subcalls, include_extrinsic, include_stack, include_events, response_format, limit, cursor }) => {
      const queryStartTime = Date.now()
      const paginationCursor = cursor
        ? decodeRecentPageCursor<SubstrateCallRequest>(cursor, 'portal_substrate_query_calls')
        : undefined

      let dataset = paginationCursor?.dataset ?? (network ? await resolveDataset(network) : undefined)
      if (!dataset) {
        throw new Error('network is required unless you are continuing with cursor.')
      }
      const chainType = detectChainType(dataset)

      if (chainType !== 'substrate') {
        throw createUnsupportedChainError({
          toolName: 'portal_substrate_query_calls',
          dataset,
          actualChainType: chainType,
          supportedChains: ['substrate'],
          suggestions: [
            'Use portal_evm_query_transactions for EVM transactions and calls.',
            'Use portal_solana_query_instructions for Solana instruction activity.',
          ],
        })
      }

      if (paginationCursor) {
        dataset = paginationCursor.dataset
        timeframe = paginationCursor.request.timeframe
        from_timestamp = paginationCursor.request.from_timestamp
        to_timestamp = paginationCursor.request.to_timestamp
        limit = paginationCursor.request.limit
        finalized_only = paginationCursor.request.finalized_only
        call_names = paginationCursor.request.call_names
        include_subcalls = paginationCursor.request.include_subcalls
        include_extrinsic = paginationCursor.request.include_extrinsic
        include_stack = paginationCursor.request.include_stack
        include_events = paginationCursor.request.include_events
        response_format = paginationCursor.request.response_format
      }
      const effectiveResponseFormat = resolveDefaultResponseFormat(response_format)

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

      const { validatedToBlock: endBlock, head } = await validateBlockRange(
        dataset,
        resolvedFromBlock,
        resolvedToBlock ?? Number.MAX_SAFE_INTEGER,
        finalized_only,
      )
      const pageToBlock = paginationCursor?.page_to_block ?? endBlock
      const blockRange = pageToBlock - resolvedFromBlock + 1
      const hasFilters = Boolean(call_names?.length)
      const validation = validateSubstrateQuerySize({
        blockRange,
        hasFilters,
        queryType: 'calls',
        limit,
      })
      if (!validation.valid) {
        throw new Error(validation.error)
      }

      const fields: Record<string, unknown> = {
        block: buildSubstrateBlockFields(),
        call: buildSubstrateCallFields(),
      }
      if (include_extrinsic) fields.extrinsic = buildSubstrateExtrinsicFields()
      if (include_events) fields.event = buildSubstrateEventFields()

      const query = {
        type: 'substrate',
        fromBlock: resolvedFromBlock,
        toBlock: pageToBlock,
        fields,
        calls: [{
          ...(call_names?.length ? { name: call_names } : {}),
          ...(include_subcalls ? { subcalls: true } : {}),
          ...(include_extrinsic ? { extrinsic: true } : {}),
          ...(include_stack ? { stack: true } : {}),
          ...(include_events ? { events: true } : {}),
        }],
      }

      const cursorSkip = paginationCursor?.skip_inclusive_block ?? 0
      const fetchLimit = limit + cursorSkip + 1
      const blocks = await portalFetchRecentRecords(`${PORTAL_URL}/datasets/${dataset}/stream`, query, {
        itemKeys: ['calls'],
        limit: fetchLimit,
        chunkSize: 200,
      })

      const allCalls = sortCalls(
        flattenSubstrateCalls(blocks, {
          include_subcalls,
          include_extrinsic,
          include_stack,
          include_events,
        }).map((item) => normalizeSubstrateCallResult(item) as SubstrateCallItem),
      )

      const page = paginateAscendingItems(
        allCalls,
        limit,
        getBlockNumber,
        paginationCursor
          ? {
              page_to_block: paginationCursor.page_to_block,
              skip_inclusive_block: paginationCursor.skip_inclusive_block,
            }
          : undefined,
      )

      const nextCursor = page.hasMore && page.nextBoundary
        ? encodeRecentPageCursor<SubstrateCallRequest>({
            tool: 'portal_substrate_query_calls',
            dataset,
            request: {
              ...(timeframe ? { timeframe } : {}),
              ...(from_timestamp !== undefined ? { from_timestamp } : {}),
              ...(to_timestamp !== undefined ? { to_timestamp } : {}),
              limit,
              finalized_only,
              ...(call_names?.length ? { call_names } : {}),
              include_subcalls,
              include_extrinsic,
              include_stack,
              include_events,
              response_format: effectiveResponseFormat,
            },
            window_from_block: resolvedFromBlock,
            window_to_block: endBlock,
            page_to_block: page.nextBoundary.page_to_block,
            skip_inclusive_block: page.nextBoundary.skip_inclusive_block,
          })
        : undefined

      const formattedData = applyResponseFormat(page.pageItems, effectiveResponseFormat, 'substrate_calls')
      const notices = [SUBSTRATE_INDEXING_NOTICE, ...getTimestampWindowNotices(resolvedBlocks), ...getValidationNotices(validation)]
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

      const windowLabel = buildSubstrateWindowLabel({
        timeframe,
        from_timestamp,
        to_timestamp,
        from_block: resolvedFromBlock,
        to_block: endBlock,
        resolvedWindow: resolvedBlocks,
      })
      const message = effectiveResponseFormat === 'summary'
        ? `Substrate call summary for ${page.pageItems.length} rows across ${windowLabel}${page.hasMore ? ' (latest preview page)' : ''}`
        : `Retrieved ${page.pageItems.length} Substrate calls${page.hasMore ? ` from the most recent matching blocks (preview page limited to ${limit})` : ''}`

      return formatResult(formattedData, message, {
        toolName: 'portal_substrate_query_calls',
        notices,
        pagination: buildPaginationInfo(limit, page.pageItems.length, nextCursor),
        ordering: buildChronologicalPageOrdering({
          sortedBy: 'block_number',
          tieBreakers: ['call_address', 'primary_id'],
        }),
        freshness,
        coverage,
        execution: buildExecutionMetadata({
          response_format: effectiveResponseFormat,
          finalized_only,
          limit,
          from_block: resolvedFromBlock,
          to_block: endBlock,
          page_to_block: pageToBlock,
          range_kind: resolvedBlocks.range_kind,
          normalized_output: true,
          notes: [
            call_names?.length
              ? `Filtered by ${call_names.length} call name${call_names.length === 1 ? '' : 's'}.`
              : 'Unfiltered Substrate call scan.',
            include_subcalls || include_extrinsic || include_stack || include_events
              ? 'Requested inline related context for matching calls.'
              : 'Call rows only.',
          ],
        }),
        metadata: {
          network: dataset,
          dataset,
          from_block: resolvedFromBlock,
          to_block: pageToBlock,
          query_start_time: queryStartTime,
        },
      })
    },
  )
}
