import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { getBlockHead, resolveDataset } from '../../cache/datasets.js'

import { PORTAL_URL } from '../../constants/index.js'
import { buildTableDescriptor } from '../../helpers/chart-metadata.js'
import { detectChainType } from '../../helpers/chain.js'
import { ActionableError, createUnsupportedChainError } from '../../helpers/errors.js'
import { getRecordBlockNumber, portalFetchStreamRangeVisit } from '../../helpers/fetch.js'
import { formatResult } from '../../helpers/format.js'
import { buildAnalysisCoverage, buildQueryFreshness, buildRankedOrdering } from '../../helpers/result-metadata.js'
import { buildPaginationInfo, decodeOffsetPageCursor, encodeOffsetPageCursor, paginateOffsetItems } from '../../helpers/pagination.js'
import { getTimestampWindowNotices, type ResolvedBlockWindow, type TimestampInput, resolveTimeframeOrBlocks } from '../../helpers/timeframe.js'
import { buildExecutionMetadata, buildToolDescription } from '../../helpers/tool-ux.js'
import { buildMetricCard, buildPortalUi, buildRankedBarsPanel, buildTablePanel } from '../../helpers/ui-metadata.js'

type TopContractsCursorRequest = {
  num_blocks?: number
  timeframe?: string
  from_timestamp?: TimestampInput
  to_timestamp?: TimestampInput
  limit: number
  include_details: boolean
  window_from_block: number
  window_to_block: number
  range_label: string
}

const INITIAL_EVM_ANALYTICS_CHUNK_SIZE = 500
const MIN_EVM_ANALYTICS_CHUNK_SIZE = 50

// ============================================================================
// Tool: Get Top Contracts
// ============================================================================

/**
 * Find the most active contracts on a chain by transaction volume.
 * Perfect for "which contracts are trending?" questions.
 */
export function registerGetTopContractsTool(server: McpServer) {
  server.tool(
    'portal_evm_get_analytics',
    buildToolDescription('portal_evm_get_analytics'),
    {
      network: z.string().optional().describe("Network name (supports short names: 'ethereum', 'polygon', 'base', etc.). Optional when continuing with cursor."),
      num_blocks: z
        .number()
        .max(10000)
        .optional()
        .default(50)
        .describe('Number of recent blocks to analyze when timeframe is omitted (default: 50, max: 10000)'),
      timeframe: z.string().optional().describe("Optional natural time window like '1h' or '24h'"),
      from_timestamp: z
        .union([z.number(), z.string()])
        .optional()
        .describe('Starting timestamp. Accepts Unix seconds, Unix milliseconds, ISO datetime, or relative input like "1h ago".'),
      to_timestamp: z
        .union([z.number(), z.string()])
        .optional()
        .describe('Ending timestamp. Accepts Unix seconds, Unix milliseconds, ISO datetime, or relative input like "now".'),
      limit: z
        .number()
        .max(100)
        .optional()
        .default(10)
        .describe('Number of top contracts to return (default: 10, max: 100)'),
      include_details: z
        .boolean()
        .optional()
        .default(false)
        .describe('Include sample transaction hashes for each contract'),
      cursor: z.string().optional().describe('Continuation cursor from a previous response'),
    },
    async ({ network, num_blocks, timeframe, from_timestamp, to_timestamp, limit, include_details, cursor }) => {
      const queryStartTime = Date.now()
      const paginationCursor = cursor ? decodeOffsetPageCursor<TopContractsCursorRequest>(cursor, 'portal_evm_get_analytics') : undefined
      const requestedDataset = network ? await resolveDataset(network) : undefined
      let dataset = paginationCursor?.dataset ?? requestedDataset
      if (!dataset) {
        throw new ActionableError('network is required unless you are continuing with cursor.', [
          'Provide network for a fresh EVM analytics query.',
          'Reuse _pagination.next_cursor from a previous response to continue paging.',
        ])
      }
      const chainType = detectChainType(dataset)

      if (chainType !== 'evm') {
        throw createUnsupportedChainError({
          toolName: 'portal_evm_get_analytics',
          dataset,
          actualChainType: chainType,
          supportedChains: ['evm'],
          suggestions: [
            'Use portal_get_time_series for cross-chain activity over time.',
            'Use portal_get_recent_activity for wallet-style previews on Solana, Bitcoin, or Hyperliquid.',
          ],
        })
      }

      const head = await getBlockHead(dataset)
      if (paginationCursor && requestedDataset && paginationCursor.dataset !== requestedDataset) {
        throw new ActionableError('This cursor belongs to a different network.', [
          'Reuse the cursor with the same network as the previous response.',
          'Omit cursor to start a fresh EVM analytics query.',
        ], {
          cursor_dataset: paginationCursor.dataset,
          requested_dataset: requestedDataset,
        })
      }

      const resolvedWindow: ResolvedBlockWindow = paginationCursor
        ? {
            from_block: paginationCursor.request.window_from_block,
            to_block: paginationCursor.request.window_to_block,
            range_kind:
              paginationCursor.request.from_timestamp !== undefined || paginationCursor.request.to_timestamp !== undefined
                ? 'timestamp_range'
                : paginationCursor.request.timeframe
                  ? 'timeframe'
                  : 'block_range',
          }
        : (from_timestamp !== undefined || to_timestamp !== undefined || timeframe
            ? await resolveTimeframeOrBlocks({
                dataset,
                timeframe,
                from_timestamp,
                to_timestamp,
              })
            : {
                from_block: Math.max(0, head.number - num_blocks + 1),
                to_block: head.number,
                range_kind: 'block_range' as const,
              })

      const rangeLabel = paginationCursor?.request.range_label
        ?? (resolvedWindow.range_kind === 'timestamp_range'
          ? `${resolvedWindow.from_lookup?.normalized_input ?? 'window start'} -> ${resolvedWindow.to_lookup?.normalized_input ?? 'window end'}`
          : timeframe ?? `${num_blocks} blocks`)

      const request = paginationCursor?.request ?? {
        num_blocks,
        ...(timeframe ? { timeframe } : {}),
        ...(from_timestamp !== undefined ? { from_timestamp } : {}),
        ...(to_timestamp !== undefined ? { to_timestamp } : {}),
        limit,
        include_details,
        window_from_block: resolvedWindow.from_block,
        window_to_block: resolvedWindow.to_block,
        range_label: rangeLabel,
      }

      const fromBlock = request.window_from_block
      const latestBlock = request.window_to_block
      const pageSize = request.limit
      const currentOffset = paginationCursor?.offset ?? 0
      const windowDescription = request.range_label.includes('->') || request.range_label.endsWith('blocks')
        ? request.range_label
        : `last ${request.range_label}`

      const query = {
        type: 'evm',
        fromBlock,
        toBlock: latestBlock,
        fields: {
          block: { number: true },
          transaction: {
            to: true,
            hash: true,
          },
        },
        transactions: [{}], // Get all transactions
      }

      // Count transactions per contract. Large EVM windows can exceed Portal's response-size cap,
      // so we automatically scan them in smaller block chunks instead of failing the whole request.
      const contractCounts: Map<string, { count: number; samples: string[] }> = new Map()
      let totalTxs = 0
      let currentFrom = fromBlock
      let chunkSize = Math.min(INITIAL_EVM_ANALYTICS_CHUNK_SIZE, Math.max(1, latestBlock - fromBlock + 1))
      let autoChunked = false

      while (currentFrom <= latestBlock) {
        const plannedTo = Math.min(currentFrom + chunkSize - 1, latestBlock)
        let lastProcessedBlock: number | undefined
        const chunkCounts: Map<string, { count: number; samples: string[] }> = new Map()
        let chunkTotalTxs = 0

        try {
          const processed = await portalFetchStreamRangeVisit(`${PORTAL_URL}/datasets/${dataset}/stream`, {
            ...query,
            fromBlock: currentFrom,
            toBlock: plannedTo,
          }, {
            onRecord: (record) => {
              const transactions = (record as {
                transactions?: Array<{ to?: string; hash?: string }>
              }).transactions || []

              lastProcessedBlock = getRecordBlockNumber(record) ?? lastProcessedBlock

              transactions.forEach((tx) => {
                if (!tx.to) {
                  return
                }

                const address = tx.to.toLowerCase()
                chunkTotalTxs++

                if (!chunkCounts.has(address)) {
                  chunkCounts.set(address, { count: 0, samples: [] })
                }

                const entry = chunkCounts.get(address)!
                entry.count++

                if (include_details && tx.hash && entry.samples.length < 5) {
                  entry.samples.push(tx.hash)
                }
              })
            },
          })

          if (processed === 0 || lastProcessedBlock === undefined || lastProcessedBlock < currentFrom) {
            break
          }

          totalTxs += chunkTotalTxs
          chunkCounts.forEach((chunkEntry, address) => {
            const merged = contractCounts.get(address) ?? { count: 0, samples: [] }
            merged.count += chunkEntry.count

            if (include_details && chunkEntry.samples.length > 0 && merged.samples.length < 5) {
              merged.samples.push(...chunkEntry.samples.slice(0, 5 - merged.samples.length))
            }

            contractCounts.set(address, merged)
          })

          currentFrom = lastProcessedBlock + 1
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          if (message.includes('Response too large') && chunkSize > MIN_EVM_ANALYTICS_CHUNK_SIZE) {
            chunkSize = Math.max(MIN_EVM_ANALYTICS_CHUNK_SIZE, Math.floor(chunkSize / 2))
            autoChunked = true
            continue
          }

          throw error
        }
      }

      // Convert to array and sort by transaction count
      const sortedContracts = Array.from(contractCounts.entries())
        .map(([address, data]) => {
          return {
            address,
            transaction_count: data.count,
            percentage: ((data.count / totalTxs) * 100).toFixed(2),
            sample_transactions: include_details ? data.samples : undefined,
          }
        })
        .sort((a, b) => b.transaction_count - a.transaction_count)
        .map((contract, index) => ({
          rank: index + 1,
          ...contract,
        }))

      const { pageItems, hasMore, nextOffset } = paginateOffsetItems(sortedContracts, pageSize, currentOffset)
      const nextCursor = hasMore
        ? encodeOffsetPageCursor<TopContractsCursorRequest>({
            tool: 'portal_evm_get_analytics',
            dataset,
            request,
            offset: nextOffset ?? currentOffset + pageItems.length,
          })
        : undefined

      const summary = {
        network: dataset,
        total_transactions: totalTxs,
        unique_contracts: contractCounts.size,
        blocks_analyzed: latestBlock - fromBlock + 1,
        from_block: fromBlock,
        to_block: latestBlock,
        window: windowDescription,
        page_offset: currentOffset,
        page_returned: pageItems.length,
        top_contract: sortedContracts[0]?.address,
        top_contract_txs: sortedContracts[0]?.transaction_count,
      }

      const notices = getTimestampWindowNotices(resolvedWindow)
      if (autoChunked) {
        notices.push('Large activity windows were automatically scanned in smaller block chunks to stay within Portal response limits.')
      }
      if (hasMore) {
        notices.push(`Showing ranked contracts ${currentOffset + 1}-${currentOffset + pageItems.length}. Use _pagination.next_cursor to continue.`)
      }

      return formatResult(
        {
          overview: {
            network: dataset,
            total_transactions: totalTxs,
            unique_contracts: contractCounts.size,
            blocks_analyzed: latestBlock - fromBlock + 1,
            from_block: fromBlock,
            to_block: latestBlock,
            window: windowDescription,
          },
          summary,
          tables: [
            buildTableDescriptor({
              id: 'top_contracts',
              dataKey: 'top_contracts',
              rowCount: pageItems.length,
              title: 'Top contracts',
              subtitle: 'Ranked by transaction count across the selected analysis window',
              keyField: 'address',
              defaultSort: { key: 'rank', direction: 'asc' },
              dense: true,
              columns: [
                { key: 'rank', label: 'Rank', kind: 'rank', format: 'integer', align: 'right' },
                { key: 'address', label: 'Contract', kind: 'dimension', format: 'address' },
                { key: 'transaction_count', label: 'Transactions', kind: 'metric', format: 'integer', align: 'right' },
                { key: 'percentage', label: 'Share', kind: 'metric', format: 'percent', unit: '%', align: 'right' },
              ],
            }),
          ],
          top_contracts: pageItems,
        },
        `Analyzed ${totalTxs.toLocaleString()} EVM transactions across ${windowDescription}. Top contract: ${sortedContracts[0]?.address} (${sortedContracts[0]?.transaction_count} txs, ${sortedContracts[0]?.percentage}%)`,
        {
          toolName: 'portal_evm_get_analytics',
          ...(notices.length > 0 ? { notices } : {}),
          pagination: buildPaginationInfo(pageSize, pageItems.length, nextCursor),
          ordering: buildRankedOrdering({
            sortedBy: 'transaction_count',
            direction: 'desc',
            rankField: 'rank',
          }),
          freshness: buildQueryFreshness({
            finality: 'latest',
            headBlockNumber: head.number,
            windowToBlock: latestBlock,
            resolvedWindow,
          }),
          coverage: buildAnalysisCoverage({
            windowFromBlock: fromBlock,
            windowToBlock: latestBlock,
            analyzedFromBlock: fromBlock,
            analyzedToBlock: latestBlock,
            hasMore,
          }),
          execution: buildExecutionMetadata({
            limit: pageSize,
            from_block: fromBlock,
            to_block: latestBlock,
            range_kind: resolvedWindow.range_kind,
            notes: [include_details ? 'Sample transaction hashes were included for ranked contracts.' : 'Compact ranked-contract view.'],
          }),
          ui: buildPortalUi({
            version: 'portal_ui_v1',
            layout: 'dashboard',
            density: 'compact',
            design_intent: 'analytics_dashboard',
            headline: {
              title: `Top contracts on ${dataset}`,
              subtitle: windowDescription,
            },
            metric_cards: [
              buildMetricCard({ id: 'total-transactions', label: 'Transactions', value_path: 'summary.total_transactions', format: 'integer', emphasis: 'primary' }),
              buildMetricCard({ id: 'unique-contracts', label: 'Unique contracts', value_path: 'summary.unique_contracts', format: 'integer' }),
              buildMetricCard({ id: 'top-contract-txs', label: 'Top contract txs', value_path: 'summary.top_contract_txs', format: 'integer' }),
            ],
            panels: [
              buildRankedBarsPanel({
                id: 'contract-bars',
                kind: 'ranked_bars_panel',
                title: 'Top contracts',
                subtitle: 'Horizontal ranking by transaction count.',
                data_key: 'top_contracts',
                category_key: 'address',
                value_key: 'transaction_count',
                rank_key: 'rank',
                value_format: 'integer',
                emphasis: 'primary',
              }),
              buildTablePanel({
                id: 'contract-table',
                kind: 'table_panel',
                title: 'Top contracts table',
                subtitle: 'Ranked contract rows with count and share.',
                table_id: 'top_contracts',
              }),
            ],
            follow_up_actions: [
              ...(nextCursor ? [{ label: 'Load more ranked contracts', intent: 'continue' as const, target: '_pagination.next_cursor' }] : []),
              { label: 'Show raw ranked rows', intent: 'show_raw', target: 'top_contracts' },
            ],
          }),
          llm: {
            answer_sequence: ['overview', 'summary.total_transactions', 'summary.unique_contracts', 'summary.top_contract', 'summary.top_contract_txs', 'top_contracts'],
            parser_notes: [
              'overview is the network and window context; top_contracts is the ranked result set for the actual leaders.',
              'top_contracts is sorted by transaction_count descending, so rank 1 is the most active contract in the selected window.',
            ],
          },
          metadata: {
            network: dataset,
            dataset,
            from_block: fromBlock,
            to_block: latestBlock,
            query_start_time: queryStartTime,
          },
        },
      )
    },
  )
}
