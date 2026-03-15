import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { resolveDataset } from '../../cache/datasets.js'
import { PORTAL_URL } from '../../constants/index.js'
import { detectChainType } from '../../helpers/chain.js'
import { portalFetchStream } from '../../helpers/fetch.js'
import { formatResult } from '../../helpers/format.js'
import { getBlockRangeForDuration } from '../../helpers/timestamp-to-block.js'

// ============================================================================
// Tool: Get Gas Analytics
// ============================================================================

/**
 * Analyze gas prices and patterns to answer "when is gas cheapest?"
 */
export function registerGetGasAnalyticsTool(server: McpServer) {
  server.tool(
    'portal_get_gas_analytics',
    `Analyze gas prices and usage patterns. Returns current price, percentiles, trends, and cost estimates.`,
    {
      dataset: z.string().describe("Dataset name (supports short names: 'ethereum', 'polygon', 'base', etc.)"),
      timeframe: z.enum(['1h', '6h', '24h', '7d']).default('24h').describe('Time period to analyze (default: 24h)'),
      include_cost_estimates: z
        .boolean()
        .optional()
        .default(true)
        .describe('Include USD cost estimates for common operations'),
    },
    async ({ dataset, timeframe, include_cost_estimates }) => {
      const queryStartTime = Date.now()
      dataset = await resolveDataset(dataset)
      const chainType = detectChainType(dataset)

      if (chainType !== 'evm') {
        throw new Error('portal_get_gas_analytics is only for EVM chains')
      }

      // Get block range using Portal's timestamp-to-block API
      const { fromBlock, toBlock } = await getBlockRangeForDuration(dataset, timeframe)

      // Query block data with gas fields
      const query = {
        type: 'evm',
        fromBlock,
        toBlock,
        includeAllBlocks: true, // CRITICAL: Return all blocks, not just those with matching transactions
        fields: {
          block: {
            number: true,
            timestamp: true,
            gasUsed: true,
            gasLimit: true,
            baseFeePerGas: true,
          },
        },
        // Don't specify transactions filter at all - we want ALL blocks
      }

      const results = await portalFetchStream(`${PORTAL_URL}/datasets/${dataset}/stream`, query)

      // Extract gas data
      // Portal API may return block data directly or wrapped in 'header'
      const gasData = results
        .map((item: any) => {
          const block = item.header || item
          return {
            block_number: block.number,
            timestamp: block.timestamp,
            gas_used: parseInt(block.gasUsed || '0'),
            gas_limit: parseInt(block.gasLimit || '0'),
            base_fee: block.baseFeePerGas ? parseInt(block.baseFeePerGas) : null,
            utilization: block.gasLimit ? (parseInt(block.gasUsed || '0') / parseInt(block.gasLimit)) * 100 : 0,
          }
        })
        .filter((d) => d.base_fee !== null)

      if (gasData.length === 0) {
        throw new Error('No gas data available for this time period')
      }

      // Calculate statistics
      const baseFees = gasData.map((d) => d.base_fee!).sort((a, b) => a - b)
      const utilizations = gasData.map((d) => d.utilization).sort((a, b) => a - b)

      const getPercentile = (arr: number[], p: number) => {
        const index = Math.floor((arr.length - 1) * p)
        return arr[index]
      }

      const current = gasData[gasData.length - 1]
      const avg = baseFees.reduce((sum, v) => sum + v, 0) / baseFees.length
      const median = getPercentile(baseFees, 0.5)

      // Convert to Gwei (1 Gwei = 1e9 wei)
      const toGwei = (wei: number) => (wei / 1e9).toFixed(2)

      const analytics = {
        current_gas: {
          base_fee_gwei: toGwei(current.base_fee!),
          utilization_percent: current.utilization.toFixed(2),
          block_number: current.block_number,
        },
        statistics: {
          avg_gwei: toGwei(avg),
          median_gwei: toGwei(median),
          min_gwei: toGwei(baseFees[0]),
          max_gwei: toGwei(baseFees[baseFees.length - 1]),
          p10_gwei: toGwei(getPercentile(baseFees, 0.1)),
          p25_gwei: toGwei(getPercentile(baseFees, 0.25)),
          p75_gwei: toGwei(getPercentile(baseFees, 0.75)),
          p90_gwei: toGwei(getPercentile(baseFees, 0.9)),
        },
        utilization: {
          avg_percent: (utilizations.reduce((sum, v) => sum + v, 0) / utilizations.length).toFixed(2),
          median_percent: utilizations[Math.floor(utilizations.length / 2)].toFixed(2),
          current_percent: current.utilization.toFixed(2),
        },
        trend: {
          direction: current.base_fee! > median * 1.2 ? 'high' : current.base_fee! < median * 0.8 ? 'low' : 'stable',
          vs_median: `${(((current.base_fee! - median) / median) * 100).toFixed(1)}%`,
          recommendation:
            current.base_fee! > median * 1.2
              ? 'Wait for lower gas prices (currently above median)'
              : current.base_fee! < median * 0.8
                ? 'Good time to transact (gas below median)'
                : 'Gas prices are near average',
        },
      }

      // Cost estimates (assuming 21000 gas for simple transfer, 100k for complex)
      if (include_cost_estimates) {
        const ethPriceEstimate = 2000 // Placeholder - in production, fetch from oracle
        const simpleGas = 21000
        const complexGas = 100000

        ;(analytics as any).cost_estimates = {
          simple_transfer: {
            gas_units: simpleGas,
            cost_gwei: ((current.base_fee! * simpleGas) / 1e9).toFixed(2),
            cost_usd_estimate: `$${(((current.base_fee! * simpleGas) / 1e18) * ethPriceEstimate).toFixed(2)}`,
          },
          complex_transaction: {
            gas_units: complexGas,
            cost_gwei: ((current.base_fee! * complexGas) / 1e9).toFixed(2),
            cost_usd_estimate: `$${(((current.base_fee! * complexGas) / 1e18) * ethPriceEstimate).toFixed(2)}`,
          },
          note: 'USD estimates use approximate ETH price and may vary',
        }
      }

      return formatResult(
        analytics,
        `Analyzed ${gasData.length} blocks. Current gas: ${analytics.current_gas.base_fee_gwei} Gwei. ${analytics.trend.recommendation}`,
        {
          metadata: {
            dataset,
            from_block: fromBlock,
            to_block: toBlock,
            query_start_time: queryStartTime,
          },
        },
      )
    },
  )
}
