import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { resolveDataset, validateBlockRange } from '../../cache/datasets.js'
import { PORTAL_URL } from '../../constants/index.js'
import { detectChainType } from '../../helpers/chain.js'
import { createUnsupportedChainError } from '../../helpers/errors.js'
import { portalFetchRecentRecords } from '../../helpers/fetch.js'
import {
  buildBitcoinOutputFields,
  buildBitcoinTransactionFields,
} from '../../helpers/fields.js'
import { formatResult } from '../../helpers/format.js'
import { normalizeBitcoinOutputResult } from '../../helpers/normalized-results.js'
import { buildPaginationInfo, decodeRecentPageCursor, encodeRecentPageCursor, paginateAscendingItems } from '../../helpers/pagination.js'
import { buildChronologicalPageOrdering, buildQueryCoverage, buildQueryFreshness } from '../../helpers/result-metadata.js'
import { applyResponseFormat, type ResponseFormat } from '../../helpers/response-modes.js'
import { getTimestampWindowNotices, type TimestampInput, resolveTimeframeOrBlocks } from '../../helpers/timeframe.js'

export function registerQueryBitcoinOutputsTool(server: McpServer) {
  type BitcoinOutputsRequest = {
    timeframe?: string
    from_timestamp?: TimestampInput
    to_timestamp?: TimestampInput
    limit: number
    finalized_only: boolean
    address?: string[]
    script_type?: string[]
    include_transaction: boolean
    response_format: ResponseFormat
  }

  type BitcoinOutputsCursor = {
    tool: 'portal_query_bitcoin_outputs'
    dataset: string
    request: BitcoinOutputsRequest
    window_from_block: number
    window_to_block: number
    page_to_block: number
    skip_inclusive_block: number
  }

  type BitcoinOutputItem = Record<string, unknown> & {
    block_number?: number
    transactionIndex?: number
    outputIndex?: number
    output_index?: number
    txid?: string
  }

  const getBlockNumber = (item: BitcoinOutputItem) => typeof item.block_number === 'number' ? item.block_number : undefined
  const getTransactionIndex = (item: BitcoinOutputItem) => {
    if (typeof item.transactionIndex === 'number') return item.transactionIndex
    if (typeof item.transactionIndex === 'string') {
      const parsed = Number(item.transactionIndex)
      if (Number.isFinite(parsed)) return parsed
    }
    return 0
  }
  const getOutputIndex = (item: BitcoinOutputItem) =>
    typeof item.outputIndex === 'number' ? item.outputIndex : typeof item.output_index === 'number' ? item.output_index : 0
  const sortOutputs = (items: BitcoinOutputItem[]) =>
    items.sort((left, right) => {
      const leftBlock = getBlockNumber(left) ?? 0
      const rightBlock = getBlockNumber(right) ?? 0
      if (leftBlock !== rightBlock) return leftBlock - rightBlock

      const leftTxIndex = getTransactionIndex(left)
      const rightTxIndex = getTransactionIndex(right)
      if (leftTxIndex !== rightTxIndex) return leftTxIndex - rightTxIndex

      const leftOutputIndex = getOutputIndex(left)
      const rightOutputIndex = getOutputIndex(right)
      if (leftOutputIndex !== rightOutputIndex) return leftOutputIndex - rightOutputIndex

      return String(left.txid ?? '').localeCompare(String(right.txid ?? ''))
    })

  server.tool(
    'portal_query_bitcoin_outputs',
    `Query Bitcoin transaction outputs — tracks receiving to addresses (UTXO creation).

WHEN TO USE:
- "Find all payments to this Bitcoin address"
- "Track incoming funds to a wallet"
- "Find outputs by script type (taproot, segwit, etc.)"

Bitcoin uses the UTXO model: outputs represent newly created UTXOs.
Filter by address to track payments TO an address.

EXAMPLES:
- Payments to address: { address: ["bc1q..."], timeframe: "24h" }
- Taproot outputs: { script_type: ["witness_v1_taproot"], timeframe: "1h" }
- All outputs in range: { from_block: 800000, to_block: 800010 }`,
    {
      dataset: z.string().optional().describe('Dataset name (default: bitcoin-mainnet). Optional when continuing with cursor.'),
      from_block: z.number().optional().describe('Starting block number'),
      to_block: z.number().optional().describe('Ending block number'),
      timeframe: z.string().optional().describe("Time range (e.g., '1h', '24h'). Alternative to from_block/to_block."),
      from_timestamp: z
        .union([z.number(), z.string()])
        .optional()
        .describe('Starting timestamp. Accepts Unix seconds, Unix milliseconds, ISO datetime, or relative input like "1h ago".'),
      to_timestamp: z
        .union([z.number(), z.string()])
        .optional()
        .describe('Ending timestamp. Accepts Unix seconds, Unix milliseconds, ISO datetime, or relative input like "now".'),
      finalized_only: z.boolean().optional().default(false).describe('Only query finalized blocks'),
      address: z.array(z.string()).optional().describe('Filter by recipient address. Tracks payments TO this address.'),
      script_type: z.array(z.string()).optional().describe('Filter by output script type (e.g., "witness_v1_taproot", "witness_v0_keyhash")'),
      include_transaction: z.boolean().optional().default(false).describe('Include parent transaction data'),
      response_format: z.enum(['full', 'compact', 'summary']).optional().default('full').describe("Response format: 'summary' (stats only, ~90% smaller), 'compact' (index+address+value only, ~50% smaller), 'full' (all fields)"),
      limit: z.number().optional().default(50).describe('Max outputs to return (default: 50)'),
      cursor: z.string().optional().describe('Continuation cursor from a previous response'),
    },
    async ({ dataset, from_block, to_block, timeframe, from_timestamp, to_timestamp, finalized_only, address, script_type, include_transaction, response_format, limit, cursor }) => {
      const queryStartTime = Date.now()
      const paginationCursor = cursor
        ? decodeRecentPageCursor<BitcoinOutputsRequest>(cursor, 'portal_query_bitcoin_outputs')
        : undefined
      dataset = paginationCursor?.dataset ?? (dataset ? await resolveDataset(dataset) : 'bitcoin-mainnet')
      const chainType = detectChainType(dataset)

      if (chainType !== 'bitcoin') {
        throw createUnsupportedChainError({
          toolName: 'portal_query_bitcoin_outputs',
          dataset,
          actualChainType: chainType,
          supportedChains: ['bitcoin'],
          suggestions: [
            'Use portal_evm_query_logs or portal_evm_query_transactions for EVM datasets.',
            'Use portal_solana_query_instructions or portal_solana_query_transactions for Solana datasets.',
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
        address = paginationCursor.request.address
        script_type = paginationCursor.request.script_type
        include_transaction = paginationCursor.request.include_transaction
        response_format = paginationCursor.request.response_format
      }

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
            dataset, timeframe, from_block, to_block, from_timestamp, to_timestamp,
          })
      const resolvedFromBlock = resolvedBlocks.from_block
      const resolvedToBlock = resolvedBlocks.to_block

      const { validatedToBlock: endBlock, head } = await validateBlockRange(
        dataset, resolvedFromBlock, resolvedToBlock ?? Number.MAX_SAFE_INTEGER, finalized_only,
      )
      const pageToBlock = paginationCursor?.page_to_block ?? endBlock

      const outputFilter: Record<string, unknown> = {}
      if (address) outputFilter.scriptPubKeyAddress = address
      if (script_type) outputFilter.scriptPubKeyType = script_type
      if (include_transaction) outputFilter.transaction = true

      const fields: Record<string, unknown> = {
        block: { number: true, hash: true, timestamp: true },
        output: buildBitcoinOutputFields(),
      }
      if (include_transaction) {
        fields.transaction = buildBitcoinTransactionFields()
      }

      const query = {
        type: 'bitcoin',
        fromBlock: resolvedFromBlock,
        toBlock: pageToBlock,
        fields,
        outputs: [outputFilter],
      }

      const hasFilters = !!(address || script_type)
      const cursorSkip = paginationCursor?.skip_inclusive_block ?? 0
      const fetchLimit = limit + cursorSkip + 1
      const results = await portalFetchRecentRecords(`${PORTAL_URL}/datasets/${dataset}/stream`, query, {
        itemKeys: ['outputs'],
        limit: fetchLimit,
        chunkSize: hasFilters ? 20 : 10,
      })

      const allOutputs = sortOutputs(results.flatMap((block: unknown) => {
        const typedBlock = block as {
          number?: number
          timestamp?: number
          header?: { number?: number; timestamp?: number }
          outputs?: Array<Record<string, unknown>>
        }
        const blockNumber = typedBlock.number ?? typedBlock.header?.number
        const timestamp = typedBlock.timestamp ?? typedBlock.header?.timestamp

        return (typedBlock.outputs || []).map((output) =>
          normalizeBitcoinOutputResult({
            ...output,
            ...(blockNumber !== undefined ? { block_number: blockNumber } : {}),
            ...(timestamp !== undefined ? { timestamp } : {}),
          }) as BitcoinOutputItem,
        )
      }))
      const page = paginateAscendingItems(
        allOutputs,
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
        ? encodeRecentPageCursor<BitcoinOutputsRequest>({
            tool: 'portal_query_bitcoin_outputs',
            dataset,
            request: {
              ...(timeframe ? { timeframe } : {}),
              ...(from_timestamp !== undefined ? { from_timestamp } : {}),
              ...(to_timestamp !== undefined ? { to_timestamp } : {}),
              limit,
              finalized_only,
              ...(address ? { address } : {}),
              ...(script_type ? { script_type } : {}),
              include_transaction,
              response_format: response_format as ResponseFormat,
            },
            window_from_block: resolvedFromBlock,
            window_to_block: endBlock,
            page_to_block: page.nextBoundary.page_to_block,
            skip_inclusive_block: page.nextBoundary.skip_inclusive_block,
          })
        : undefined
      const formattedData = applyResponseFormat(page.pageItems, response_format as ResponseFormat, 'bitcoin_outputs')
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

      const message = response_format === 'summary'
        ? `Summary of ${page.pageItems.length} Bitcoin outputs${page.hasMore ? ' (latest preview page)' : ''}`
        : `Retrieved ${page.pageItems.length} Bitcoin outputs${page.hasMore ? ` from the most recent matching blocks (preview page limited to ${limit})` : ''}`

      return formatResult(formattedData, message, {
        notices,
        pagination: buildPaginationInfo(limit, page.pageItems.length, nextCursor),
        ordering: buildChronologicalPageOrdering({
          sortedBy: 'block_number',
          tieBreakers: ['transactionIndex', 'txid', 'outputIndex'],
        }),
        freshness,
        coverage,
        metadata: { dataset, from_block: resolvedFromBlock, to_block: pageToBlock, query_start_time: queryStartTime },
      })
    },
  )
}
