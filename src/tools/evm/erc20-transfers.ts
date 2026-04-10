import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { resolveDataset, validateBlockRange } from '../../cache/datasets.js'
import { EVENT_SIGNATURES, PORTAL_URL } from '../../constants/index.js'
import { detectChainType } from '../../helpers/chain.js'
import { ActionableError, createUnsupportedChainError } from '../../helpers/errors.js'
import { formatTokenValue, getKnownTokenDecimals } from '../../helpers/conversions.js'
import { getCoinGeckoTokenList } from '../../helpers/external-apis.js'
import { portalFetch, portalFetchRecentRecords } from '../../helpers/fetch.js'
import { buildEvmLogFields } from '../../helpers/fields.js'
import { formatResult } from '../../helpers/format.js'
import { formatTimestamp } from '../../helpers/formatting.js'
import { normalizeErc20TransferResult } from '../../helpers/normalized-results.js'
import { buildPaginationInfo, decodeRecentPageCursor, encodeRecentPageCursor, paginateAscendingItems } from '../../helpers/pagination.js'
import { buildChronologicalPageOrdering, buildQueryCoverage, buildQueryFreshness } from '../../helpers/result-metadata.js'
import { getTimestampWindowNotices, type TimestampInput, resolveTimeframeOrBlocks } from '../../helpers/timeframe.js'
import { buildExecutionMetadata, buildToolDescription } from '../../helpers/tool-ux.js'
import { normalizeAddresses, normalizeEvmAddress } from '../../helpers/validation.js'
import type { BlockHead } from '../../types/index.js'

// ============================================================================
// Tool: Get ERC20 Transfers
// ============================================================================

export function registerGetErc20TransfersTool(server: McpServer) {
  type Erc20Request = {
    timeframe?: string
    from_block?: number
    to_block?: number
    from_timestamp?: TimestampInput
    to_timestamp?: TimestampInput
    limit: number
    token_addresses?: string[]
    from_addresses?: string[]
    to_addresses?: string[]
    include_token_info: boolean
  }

  type Erc20Cursor = {
    tool: 'portal_evm_query_token_transfers'
    dataset: string
    request: Erc20Request
    window_from_block: number
    window_to_block: number
    page_to_block: number
    skip_inclusive_block: number
  }

  type Erc20TransferItem = Record<string, unknown> & {
    block_number?: number
    log_index?: number
    transaction_hash?: string
  }

  const getBlockNumber = (item: Erc20TransferItem) => typeof item.block_number === 'number' ? item.block_number : undefined
  const sortTransfers = (items: Erc20TransferItem[]) =>
    items.sort((left, right) => {
      const leftBlock = getBlockNumber(left) ?? 0
      const rightBlock = getBlockNumber(right) ?? 0
      if (leftBlock !== rightBlock) return leftBlock - rightBlock

      const leftIndex = typeof left.log_index === 'number' ? left.log_index : 0
      const rightIndex = typeof right.log_index === 'number' ? right.log_index : 0
      if (leftIndex !== rightIndex) return leftIndex - rightIndex

      return String(left.transaction_hash ?? '').localeCompare(String(right.transaction_hash ?? ''))
    })

  server.tool(
    'portal_evm_query_token_transfers',
    buildToolDescription('portal_evm_query_token_transfers'),
    {
      network: z.string().optional().describe('Network name or alias. Optional when continuing with cursor.'),
      from_block: z.number().optional().describe('Starting block number'),
      to_block: z.number().optional().describe('Ending block number. RECOMMENDED: <10k blocks for fast responses.'),
      timeframe: z.string().optional().describe("Time range (e.g., '1h', '24h'). Alternative to block numbers."),
      from_timestamp: z
        .union([z.number(), z.string()])
        .optional()
        .describe('Starting timestamp. Accepts Unix seconds, Unix milliseconds, ISO datetime, or relative input like "1h ago".'),
      to_timestamp: z
        .union([z.number(), z.string()])
        .optional()
        .describe('Ending timestamp. Accepts Unix seconds, Unix milliseconds, ISO datetime, or relative input like "now".'),
      token_addresses: z.array(z.string()).optional().describe('Token contract addresses'),
      from_addresses: z.array(z.string()).optional().describe('Sender addresses'),
      to_addresses: z.array(z.string()).optional().describe('Recipient addresses'),
      limit: z.number().optional().default(50).describe('Max transfers'),
      include_token_info: z
        .boolean()
        .optional()
        .default(false)
        .describe('Include token metadata (symbol, decimals) inline. Avoids separate token metadata lookups.'),
      cursor: z.string().optional().describe('Continuation cursor from a previous response'),
    },
    async ({
      network,
      timeframe,
      from_block,
      to_block,
      from_timestamp,
      to_timestamp,
      token_addresses,
      from_addresses,
      to_addresses,
      limit,
      include_token_info,
      cursor,
    }) => {
      const queryStartTime = Date.now()
      const paginationCursor = cursor
        ? decodeRecentPageCursor<Erc20Request>(cursor, 'portal_evm_query_token_transfers')
        : undefined
      let dataset = paginationCursor?.dataset ?? (network ? await resolveDataset(network) : undefined)
      if (!dataset) {
        throw new Error('network is required unless you are continuing with cursor.')
      }
      const chainType = detectChainType(dataset)

      if (chainType !== 'evm') {
        throw createUnsupportedChainError({
          toolName: 'portal_evm_query_token_transfers',
          dataset,
          actualChainType: chainType,
          supportedChains: ['evm'],
          suggestions: [
            'Use portal_solana_query_instructions for Solana token program activity.',
            'Use portal_bitcoin_query_transactions with include_outputs for Bitcoin value movement.',
          ],
        })
      }
      if (paginationCursor) {
        dataset = paginationCursor.dataset
        timeframe = paginationCursor.request.timeframe
        from_block = paginationCursor.request.from_block
        to_block = paginationCursor.request.to_block
        from_timestamp = paginationCursor.request.from_timestamp
        to_timestamp = paginationCursor.request.to_timestamp
        limit = paginationCursor.request.limit
        token_addresses = paginationCursor.request.token_addresses
        from_addresses = paginationCursor.request.from_addresses
        to_addresses = paginationCursor.request.to_addresses
        include_token_info = paginationCursor.request.include_token_info
      }
      if (!paginationCursor && from_block === undefined && timeframe === undefined && from_timestamp === undefined) {
        throw new ActionableError('portal_evm_query_token_transfers requires from_block, timeframe, or from_timestamp unless you are continuing with cursor.', [
          'Provide from_block for a fresh query.',
          'Or use timeframe for a recent window like "1h".',
          'Or use from_timestamp/to_timestamp for a natural time window.',
          'Reuse _pagination.next_cursor from a previous response to continue paging.',
        ])
      }

      const normalizedTokens = normalizeAddresses(token_addresses, chainType)
      const normalizedFrom = from_addresses
        ? from_addresses.map((a) => '0x' + normalizeEvmAddress(a).slice(2).padStart(64, '0'))
        : undefined
      const normalizedTo = to_addresses
        ? to_addresses.map((a) => '0x' + normalizeEvmAddress(a).slice(2).padStart(64, '0'))
        : undefined

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
        false,
      )
      const pageToBlock = paginationCursor?.page_to_block ?? endBlock

      const logFilter: Record<string, unknown> = {
        topic0: [EVENT_SIGNATURES.TRANSFER_ERC20],
      }
      if (normalizedTokens) logFilter.address = normalizedTokens
      if (normalizedFrom) logFilter.topic1 = normalizedFrom
      if (normalizedTo) logFilter.topic2 = normalizedTo

      const query = {
        type: 'evm',
        fromBlock: resolvedFromBlock,
        toBlock: pageToBlock,
        fields: {
          block: { number: true, timestamp: true },
          log: buildEvmLogFields(),
        },
        logs: [logFilter],
      }

      const hasAddressFilters = !!(normalizedTokens || normalizedFrom || normalizedTo)
      const cursorSkip = paginationCursor?.skip_inclusive_block ?? 0
      const fetchLimit = limit + cursorSkip + 1
      const results = await portalFetchRecentRecords(`${PORTAL_URL}/datasets/${dataset}/stream`, query, {
        itemKeys: ['logs'],
        limit: fetchLimit,
        chunkSize: hasAddressFilters ? 500 : 100,
      })

      const allTransfers = sortTransfers(results.flatMap((block: unknown) => {
        const b = block as {
          header?: { number: number; timestamp: number }
          logs?: Array<{
            transactionHash: string
            logIndex: number
            address: string
            topics?: string[]
            data: string
          }>
        }
        return (b.logs || []).map((log) => {
          const tokenAddress = log.address
          const decimals = getKnownTokenDecimals(tokenAddress) || 18
          const valueFormatted = formatTokenValue(log.data, decimals)

          return {
            block_number: b.header?.number,
            timestamp: b.header?.timestamp,
            timestamp_human: b.header?.timestamp ? formatTimestamp(b.header.timestamp) : undefined,
            transaction_hash: log.transactionHash,
            log_index: log.logIndex,
            token_address: tokenAddress,
            from: '0x' + (log.topics?.[1]?.slice(-40) || ''),
            to: '0x' + (log.topics?.[2]?.slice(-40) || ''),
            value: log.data,
            value_decimal: valueFormatted.decimal,
            value_formatted: valueFormatted.formatted,
          }
        })
      }) as Erc20TransferItem[]).map((item) => normalizeErc20TransferResult(item))
      const page = paginateAscendingItems(
        allTransfers,
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
        ? encodeRecentPageCursor<Erc20Request>({
            tool: 'portal_evm_query_token_transfers',
            dataset,
            request: {
              ...(timeframe ? { timeframe } : {}),
              ...(from_block !== undefined ? { from_block } : {}),
              ...(to_block !== undefined ? { to_block } : {}),
              ...(from_timestamp !== undefined ? { from_timestamp } : {}),
              ...(to_timestamp !== undefined ? { to_timestamp } : {}),
              limit,
              ...(token_addresses ? { token_addresses } : {}),
              ...(from_addresses ? { from_addresses } : {}),
              ...(to_addresses ? { to_addresses } : {}),
              include_token_info,
            },
            window_from_block: resolvedFromBlock,
            window_to_block: endBlock,
            page_to_block: page.nextBoundary.page_to_block,
            skip_inclusive_block: page.nextBoundary.skip_inclusive_block,
          })
        : undefined

      // Optionally enrich with token metadata
      let enrichedTransfers = page.pageItems
      if (include_token_info) {
        try {
          // Map dataset to chain for CoinGecko
          const chainMap: Record<string, string> = {
            'base-mainnet': 'base',
            'ethereum-mainnet': 'ethereum',
            'arbitrum-one': 'arbitrum',
            'optimism-mainnet': 'optimism',
            'polygon-mainnet': 'polygon',
            'avalanche-mainnet': 'avalanche',
            'bsc-mainnet': 'bsc',
          }
          const chain = chainMap[dataset] || dataset.split('-')[0]

          const tokenList = await getCoinGeckoTokenList(chain)
          const tokenMap = new Map(tokenList.map((t) => [t.address.toLowerCase(), t]))

          enrichedTransfers = page.pageItems.map((transfer: any) => {
            const tokenInfo = tokenMap.get(transfer.token_address.toLowerCase())
            if (tokenInfo) {
              return {
                ...transfer,
                token_symbol: tokenInfo.symbol,
                token_name: tokenInfo.name,
                token_decimals: tokenInfo.decimals,
              }
            }
            return transfer
          })
        } catch (error) {
          // If token info fetch fails, continue without it
          console.error('Failed to fetch token info:', error)
        }
      }
      const notices = getTimestampWindowNotices(resolvedBlocks)
      if (nextCursor) notices.push('Older results are available via _pagination.next_cursor.')
      const freshness = buildQueryFreshness({
        finality: 'latest',
        headBlockNumber: head.number,
        windowToBlock: endBlock,
        resolvedWindow: resolvedBlocks,
      })
      const coverage = buildQueryCoverage({
        windowFromBlock: resolvedFromBlock,
        windowToBlock: endBlock,
        pageToBlock,
        items: enrichedTransfers,
        getBlockNumber,
        hasMore: page.hasMore,
      })

      return formatResult(
        enrichedTransfers,
        `Retrieved ${page.pageItems.length} ERC20 transfers${page.hasMore ? ` from the most recent matching blocks (preview page limited to ${limit})` : ''}`,
        {
          toolName: 'portal_evm_query_token_transfers',
          notices,
          pagination: buildPaginationInfo(limit, page.pageItems.length, nextCursor),
          ordering: buildChronologicalPageOrdering({
            sortedBy: 'block_number',
            tieBreakers: ['log_index', 'transaction_index', 'tx_hash'],
          }),
          freshness,
          coverage,
          execution: buildExecutionMetadata({
            limit,
            from_block: resolvedFromBlock,
            to_block: endBlock,
            page_to_block: pageToBlock,
            range_kind: resolvedBlocks.range_kind,
            normalized_output: true,
            notes: [
              include_token_info
                ? 'Token metadata was enriched inline.'
                : 'Token metadata enrichment was disabled for a lighter response.',
            ],
          }),
          metadata: {
            network: dataset,
            dataset,
            from_block: resolvedFromBlock,
            to_block: pageToBlock,
            query_start_time: queryStartTime,
          },
        },
      )
    },
  )
}
