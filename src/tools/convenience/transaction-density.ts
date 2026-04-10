import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { getBlockHead, resolveDataset } from '../../cache/datasets.js'
import { PORTAL_URL } from '../../constants/index.js'
import { buildTableDescriptor, buildTimeSeriesChart } from '../../helpers/chart-metadata.js'
import { detectChainType } from '../../helpers/chain.js'
import { createUnsupportedChainError } from '../../helpers/errors.js'
import { portalFetchStreamRange } from '../../helpers/fetch.js'
import { formatResult } from '../../helpers/format.js'
import { formatTimestamp, formatNumber } from '../../helpers/formatting.js'
import { buildAnalysisCoverage, buildQueryFreshness } from '../../helpers/result-metadata.js'
import { resolveTimeframeOrBlocks, type TimestampInput } from '../../helpers/timeframe.js'

// ============================================================================
// Tool: Get Transaction Density
// ============================================================================

/**
 * Get transaction density (tx count per block) for analysis and charts.
 * Much faster than fetching full transaction data.
 */
export function registerGetTransactionDensityTool(server: McpServer) {
  server.tool(
    'portal_get_transaction_density',
    `Get transaction density (tx count per block) for recent blocks. Returns block-level counts for charting and analysis.`,
    {
      dataset: z.string().describe("Dataset name (supports short names: 'polygon', 'base', 'ethereum', etc.)"),
      num_blocks: z
        .number()
        .max(200)
        .default(50)
        .describe('Number of recent blocks to analyze (default: 50, max: 1000)'),
      timeframe: z.string().optional().describe("Optional natural time window like '1h' or '24h'"),
      from_timestamp: z
        .union([z.string(), z.number()])
        .optional()
        .describe('Optional natural start time like "1h ago", ISO datetime, or Unix timestamp'),
      to_timestamp: z
        .union([z.string(), z.number()])
        .optional()
        .describe('Optional natural end time like "now", ISO datetime, or Unix timestamp'),
    },
    async ({ dataset, num_blocks, timeframe, from_timestamp, to_timestamp }) => {
      const queryStartTime = Date.now()
      dataset = await resolveDataset(dataset)
      const chainType = detectChainType(dataset)

      if (chainType === 'hyperliquidFills' || chainType === 'hyperliquidReplicaCmds') {
        throw createUnsupportedChainError({
          toolName: 'portal_get_transaction_density',
          dataset,
          actualChainType: chainType,
          supportedChains: ['evm', 'solana', 'bitcoin'],
          suggestions: [
            'Use portal_hyperliquid_query_fills for Hyperliquid activity.',
            'Use portal_hyperliquid_time_series for fills-based charts.',
          ],
        })
      }

      const head = await getBlockHead(dataset)
      const resolvedWindow =
        timeframe !== undefined || from_timestamp !== undefined || to_timestamp !== undefined
          ? await resolveTimeframeOrBlocks({
              dataset,
              timeframe,
              from_timestamp: from_timestamp as TimestampInput | undefined,
              to_timestamp: to_timestamp as TimestampInput | undefined,
            })
          : {
              from_block: Math.max(0, head.number - num_blocks + 1),
              to_block: head.number,
              range_kind: 'block_range' as const,
            }
      const latestBlock = resolvedWindow.to_block
      const fromBlock = resolvedWindow.from_block

      // Build chain-specific query — only need block metadata + tx count
      const blockFieldKey = 'block'
      const query = {
        type: chainType === 'solana' ? 'solana' : chainType === 'bitcoin' ? 'bitcoin' : 'evm',
        fromBlock,
        toBlock: latestBlock,
        fields: {
          [blockFieldKey]: { number: true, timestamp: true },
          transaction: { transactionIndex: true },
        },
        transactions: [{}],
      }

      const results = await portalFetchStreamRange(`${PORTAL_URL}/datasets/${dataset}/stream`, query)

      // Calculate tx density per block
      const densityData = results.map((block: any) => {
        const ts = block.header?.timestamp ?? block.timestamp
        return {
          block_number: block.header?.number ?? block.number,
          timestamp: ts,
          timestamp_human: ts ? formatTimestamp(ts) : undefined,
          transaction_count: block.transactions?.length || 0,
        }
      })

      const totalTxs = densityData.reduce((sum, b) => sum + b.transaction_count, 0)
      const avgTxsPerBlock = densityData.length > 0 ? (totalTxs / densityData.length).toFixed(2) : 0

      return formatResult(
        {
          chart: buildTimeSeriesChart({
            interval: '1 block',
            totalPoints: densityData.length,
            unit: 'transactions',
            recommendedVisual: 'bar',
            dataKey: 'blocks',
            title: 'Transactions per block',
            xAxisLabel: 'Block',
            yAxisLabel: 'Transactions',
            valueFormat: 'integer',
          }),
          tables: [
            buildTableDescriptor({
              id: 'blocks',
              dataKey: 'blocks',
              rowCount: densityData.length,
              title: 'Transaction density by block',
              keyField: 'block_number',
              defaultSort: { key: 'block_number', direction: 'asc' },
              dense: true,
              columns: [
                { key: 'block_number', label: 'Block', kind: 'dimension', format: 'integer', align: 'right' },
                { key: 'timestamp_human', label: 'Time', kind: 'time', format: 'timestamp_human' },
                { key: 'transaction_count', label: 'Transactions', kind: 'metric', format: 'integer', align: 'right' },
              ],
            }),
          ],
          blocks: densityData,
          summary: {
            total_blocks: densityData.length,
            total_transactions: totalTxs,
            avg_transactions_per_block: Number(avgTxsPerBlock),
          },
        },
        `Analyzed ${densityData.length} blocks: ${totalTxs} total transactions, ${avgTxsPerBlock} avg txs/block`,
        {
          ordering: {
            kind: 'series',
            blocks: {
              order: 'block_ascending',
            },
          },
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
          }),
          metadata: {
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
