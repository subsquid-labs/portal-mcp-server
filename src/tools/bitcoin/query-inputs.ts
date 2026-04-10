import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { resolveDataset, validateBlockRange } from '../../cache/datasets.js'
import { PORTAL_URL } from '../../constants/index.js'
import { detectChainType } from '../../helpers/chain.js'
import { createUnsupportedChainError } from '../../helpers/errors.js'
import { portalFetchRecentRecords } from '../../helpers/fetch.js'
import {
  buildBitcoinInputFields,
  buildBitcoinTransactionFields,
} from '../../helpers/fields.js'
import { formatResult } from '../../helpers/format.js'
import { normalizeBitcoinInputResult } from '../../helpers/normalized-results.js'
import { buildPaginationInfo, decodeRecentPageCursor, encodeRecentPageCursor, paginateAscendingItems } from '../../helpers/pagination.js'
import { buildChronologicalPageOrdering, buildQueryCoverage, buildQueryFreshness } from '../../helpers/result-metadata.js'
import { applyResponseFormat, type ResponseFormat } from '../../helpers/response-modes.js'
import { getTimestampWindowNotices, type TimestampInput, resolveTimeframeOrBlocks } from '../../helpers/timeframe.js'

export function registerQueryBitcoinInputsTool(server: McpServer) {
  type BitcoinInputsRequest = {
    timeframe?: string
    from_timestamp?: TimestampInput
    to_timestamp?: TimestampInput
    limit: number
    finalized_only: boolean
    type?: string[]
    prevout_address?: string[]
    prevout_script_type?: string[]
    include_transaction: boolean
    response_format: ResponseFormat
  }

  type BitcoinInputsCursor = {
    tool: 'portal_query_bitcoin_inputs'
    dataset: string
    request: BitcoinInputsRequest
    window_from_block: number
    window_to_block: number
    page_to_block: number
    skip_inclusive_block: number
  }

  type BitcoinInputItem = Record<string, unknown> & {
    block_number?: number
    transactionIndex?: number
    inputIndex?: number
    input_index?: number
    txid?: string
  }

  const getBlockNumber = (item: BitcoinInputItem) => typeof item.block_number === 'number' ? item.block_number : undefined
  const getTransactionIndex = (item: BitcoinInputItem) => {
    if (typeof item.transactionIndex === 'number') return item.transactionIndex
    if (typeof item.transactionIndex === 'string') {
      const parsed = Number(item.transactionIndex)
      if (Number.isFinite(parsed)) return parsed
    }
    return 0
  }
  const getInputIndex = (item: BitcoinInputItem) =>
    typeof item.inputIndex === 'number' ? item.inputIndex : typeof item.input_index === 'number' ? item.input_index : 0
  const sortInputs = (items: BitcoinInputItem[]) =>
    items.sort((left, right) => {
      const leftBlock = getBlockNumber(left) ?? 0
      const rightBlock = getBlockNumber(right) ?? 0
      if (leftBlock !== rightBlock) return leftBlock - rightBlock

      const leftTxIndex = getTransactionIndex(left)
      const rightTxIndex = getTransactionIndex(right)
      if (leftTxIndex !== rightTxIndex) return leftTxIndex - rightTxIndex

      const leftInputIndex = getInputIndex(left)
      const rightInputIndex = getInputIndex(right)
      if (leftInputIndex !== rightInputIndex) return leftInputIndex - rightInputIndex

      return String(left.txid ?? '').localeCompare(String(right.txid ?? ''))
    })

  server.tool(
    'portal_query_bitcoin_inputs',
    `Query Bitcoin transaction inputs — tracks spending from addresses (UTXO consumption).

WHEN TO USE:
- "Find all spending from this Bitcoin address"
- "Track UTXO consumption for an address"
- "Find coinbase (mining reward) inputs"

Bitcoin uses the UTXO model: inputs reference previous outputs being spent.
Filter by prevout_address to track spending FROM an address.

EXAMPLES:
- Spending from address: { prevout_address: ["bc1q..."], timeframe: "24h" }
- Coinbase inputs: { type: ["coinbase"], timeframe: "1h" }
- All inputs in range: { from_block: 800000, to_block: 800010 }`,
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
      type: z.array(z.string()).optional().describe('Input type filter: "coinbase" or "tx"'),
      prevout_address: z.array(z.string()).optional().describe('Filter by address of the spent output. Tracks spending FROM this address.'),
      prevout_script_type: z.array(z.string()).optional().describe('Filter by script type (e.g., "witness_v1_taproot", "witness_v0_keyhash")'),
      include_transaction: z.boolean().optional().default(false).describe('Include parent transaction data'),
      response_format: z.enum(['full', 'compact', 'summary']).optional().default('full').describe("Response format: 'summary' (stats only, ~90% smaller), 'compact' (txid+address+value only, ~50% smaller), 'full' (all fields)"),
      limit: z.number().optional().default(50).describe('Max inputs to return (default: 50)'),
      cursor: z.string().optional().describe('Continuation cursor from a previous response'),
    },
    async ({ dataset, from_block, to_block, timeframe, from_timestamp, to_timestamp, finalized_only, type, prevout_address, prevout_script_type, include_transaction, response_format, limit, cursor }) => {
      const queryStartTime = Date.now()
      const paginationCursor = cursor
        ? decodeRecentPageCursor<BitcoinInputsRequest>(cursor, 'portal_query_bitcoin_inputs')
        : undefined
      dataset = paginationCursor?.dataset ?? (dataset ? await resolveDataset(dataset) : 'bitcoin-mainnet')
      const chainType = detectChainType(dataset)

      if (chainType !== 'bitcoin') {
        throw createUnsupportedChainError({
          toolName: 'portal_query_bitcoin_inputs',
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
        type = paginationCursor.request.type
        prevout_address = paginationCursor.request.prevout_address
        prevout_script_type = paginationCursor.request.prevout_script_type
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

      const inputFilter: Record<string, unknown> = {}
      if (type) inputFilter.type = type
      if (prevout_address) inputFilter.prevoutScriptPubKeyAddress = prevout_address
      if (prevout_script_type) inputFilter.prevoutScriptPubKeyType = prevout_script_type
      if (include_transaction) inputFilter.transaction = true

      const fields: Record<string, unknown> = {
        block: { number: true, hash: true, timestamp: true },
        input: buildBitcoinInputFields(),
      }
      if (include_transaction) {
        fields.transaction = buildBitcoinTransactionFields()
      }

      const query = {
        type: 'bitcoin',
        fromBlock: resolvedFromBlock,
        toBlock: pageToBlock,
        fields,
        inputs: [inputFilter],
      }

      const hasFilters = !!(type || prevout_address || prevout_script_type)
      const cursorSkip = paginationCursor?.skip_inclusive_block ?? 0
      const fetchLimit = limit + cursorSkip + 1
      const results = await portalFetchRecentRecords(`${PORTAL_URL}/datasets/${dataset}/stream`, query, {
        itemKeys: ['inputs'],
        limit: fetchLimit,
        chunkSize: hasFilters ? 20 : 10,
      })

      const allInputs = sortInputs(results.flatMap((block: unknown) => {
        const typedBlock = block as {
          number?: number
          timestamp?: number
          header?: { number?: number; timestamp?: number }
          inputs?: Array<Record<string, unknown>>
        }
        const blockNumber = typedBlock.number ?? typedBlock.header?.number
        const timestamp = typedBlock.timestamp ?? typedBlock.header?.timestamp

        return (typedBlock.inputs || []).map((input) =>
          normalizeBitcoinInputResult({
            ...input,
            ...(blockNumber !== undefined ? { block_number: blockNumber } : {}),
            ...(timestamp !== undefined ? { timestamp } : {}),
          }) as BitcoinInputItem,
        )
      }))
      const page = paginateAscendingItems(
        allInputs,
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
        ? encodeRecentPageCursor<BitcoinInputsRequest>({
            tool: 'portal_query_bitcoin_inputs',
            dataset,
            request: {
              ...(timeframe ? { timeframe } : {}),
              ...(from_timestamp !== undefined ? { from_timestamp } : {}),
              ...(to_timestamp !== undefined ? { to_timestamp } : {}),
              limit,
              finalized_only,
              ...(type ? { type } : {}),
              ...(prevout_address ? { prevout_address } : {}),
              ...(prevout_script_type ? { prevout_script_type } : {}),
              include_transaction,
              response_format: response_format as ResponseFormat,
            },
            window_from_block: resolvedFromBlock,
            window_to_block: endBlock,
            page_to_block: page.nextBoundary.page_to_block,
            skip_inclusive_block: page.nextBoundary.skip_inclusive_block,
          })
        : undefined
      const formattedData = applyResponseFormat(page.pageItems, response_format as ResponseFormat, 'bitcoin_inputs')
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
        ? `Summary of ${page.pageItems.length} Bitcoin inputs${page.hasMore ? ' (latest preview page)' : ''}`
        : `Retrieved ${page.pageItems.length} Bitcoin inputs${page.hasMore ? ` from the most recent matching blocks (preview page limited to ${limit})` : ''}`

      return formatResult(formattedData, message, {
        notices,
        pagination: buildPaginationInfo(limit, page.pageItems.length, nextCursor),
        ordering: buildChronologicalPageOrdering({
          sortedBy: 'block_number',
          tieBreakers: ['transactionIndex', 'txid', 'inputIndex'],
        }),
        freshness,
        coverage,
        metadata: { dataset, from_block: resolvedFromBlock, to_block: pageToBlock, query_start_time: queryStartTime },
      })
    },
  )
}
