import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { getBlockHead, resolveDataset, validateBlockRange } from '../../cache/datasets.js'
import { PORTAL_URL } from '../../constants/index.js'
import { detectChainType } from '../../helpers/chain.js'
import { createUnsupportedChainError } from '../../helpers/errors.js'
import { portalFetchStreamRange } from '../../helpers/fetch.js'
import { formatResult } from '../../helpers/format.js'
import { formatNumber, formatBTC, formatPct, formatDuration } from '../../helpers/formatting.js'
import { resolveTimeframeOrBlocks } from '../../helpers/timeframe.js'

// ============================================================================
// Tool: Bitcoin Network Analytics
// ============================================================================

/**
 * Comprehensive Bitcoin network analytics — block stats, fee analysis,
 * address activity, segwit/taproot adoption, and UTXO patterns.
 */
export function registerBitcoinAnalyticsTool(server: McpServer) {
  server.tool(
    'portal_bitcoin_analytics',
    `Comprehensive Bitcoin network analytics. Returns block stats (size, time, tx count), fee analysis (total/avg fees in BTC), address activity (unique addresses, output value), and script type adoption (segwit, taproot %).

WHEN TO USE:
- "How's the Bitcoin network doing?"
- "What are Bitcoin fees right now?"
- "Show me Bitcoin block stats"
- "What's the taproot adoption rate?"
- "How many unique addresses are active on Bitcoin?"

EXAMPLES:
- Quick snapshot: { timeframe: "1h" }
- Daily analysis: { timeframe: "24h" }
- Custom range: { from_block: 800000, to_block: 800010 }`,
    {
      dataset: z.string().default('bitcoin-mainnet').describe('Dataset name (default: bitcoin-mainnet)'),
      timeframe: z
        .string()
        .optional()
        .describe("Time range: '1h' (~6 blocks), '6h' (~36 blocks), '24h' (~144 blocks). Default: '1h'"),
      from_block: z.number().optional().describe('Starting block number (use this OR timeframe)'),
      to_block: z.number().optional().describe('Ending block number'),
      include_address_activity: z
        .boolean()
        .optional()
        .default(true)
        .describe('Include unique address count and output value (requires extra queries, slower)'),
    },
    async ({ dataset, timeframe, from_block, to_block, include_address_activity }) => {
      const queryStartTime = Date.now()
      dataset = await resolveDataset(dataset)
      const chainType = detectChainType(dataset)

      if (chainType !== 'bitcoin') {
        throw createUnsupportedChainError({
          toolName: 'portal_bitcoin_analytics',
          dataset,
          actualChainType: chainType,
          supportedChains: ['bitcoin'],
          suggestions: [
            'Use portal_solana_analytics for Solana snapshots.',
            'Use EVM convenience tools like portal_get_contract_activity for smart-contract chains.',
          ],
        })
      }

      // Default to 1h
      if (!timeframe && from_block === undefined) {
        timeframe = '1h'
      }

      const { from_block: resolvedFromBlock, to_block: resolvedToBlock } = await resolveTimeframeOrBlocks({
        dataset,
        timeframe,
        from_block,
        to_block,
      })

      const { validatedToBlock: endBlock } = await validateBlockRange(
        dataset,
        resolvedFromBlock,
        resolvedToBlock ?? Number.MAX_SAFE_INTEGER,
        false,
      )

      // Cap block range for performance
      const blockRange = endBlock - resolvedFromBlock
      const maxBlocks = Math.min(blockRange, 200) // ~33 hours max
      const effectiveFrom = blockRange > maxBlocks ? endBlock - maxBlocks : resolvedFromBlock

      // Query 1: Blocks + transactions (for block stats and tx counts)
      const txQuery = {
        type: 'bitcoin',
        fromBlock: effectiveFrom,
        toBlock: endBlock,
        fields: {
          block: { number: true, hash: true, timestamp: true },
          transaction: {
            transactionIndex: true,
            hash: true,
            size: true,
            vsize: true,
            weight: true,
            version: true,
          },
        },
        transactions: [{}],
      }

      const txResults = await portalFetchStreamRange(
        `${PORTAL_URL}/datasets/${dataset}/stream`,
        txQuery,
        {
          maxBytes: 100 * 1024 * 1024,
        },
      )

      // Compute block & transaction stats
      let totalTxs = 0
      let totalSize = 0
      let totalVsize = 0
      let totalWeight = 0
      const blockTimes: number[] = []
      const blockTxCounts: number[] = []
      const versions = new Map<number, number>()

      for (let i = 0; i < txResults.length; i++) {
        const block = txResults[i] as any
        const txs = block.transactions || []
        const txCount = txs.length
        totalTxs += txCount
        blockTxCounts.push(txCount)

        txs.forEach((tx: any) => {
          totalSize += tx.size || 0
          totalVsize += tx.vsize || 0
          totalWeight += tx.weight || 0
          const v = tx.version || 0
          versions.set(v, (versions.get(v) || 0) + 1)
        })

        // Block time (gap between consecutive blocks)
        if (i > 0) {
          const prevBlock = txResults[i - 1] as any
          const prevTs = prevBlock.header?.timestamp ?? prevBlock.timestamp
          const curTs = block.header?.timestamp ?? block.timestamp
          if (prevTs && curTs) {
            blockTimes.push(curTs - prevTs)
          }
        }
      }

      const numBlocks = txResults.length
      const avgBlockTime = blockTimes.length > 0 ? blockTimes.reduce((a, b) => a + b, 0) / blockTimes.length : 0
      const avgTxsPerBlock = numBlocks > 0 ? totalTxs / numBlocks : 0
      const avgTxSize = totalTxs > 0 ? totalSize / totalTxs : 0
      const avgBlockSize = numBlocks > 0 ? totalSize / numBlocks : 0

      // Segwit detection: if vsize < size, it uses segwit
      let segwitTxs = 0
      txResults.forEach((block: any) => {
        ;(block.transactions || []).forEach((tx: any) => {
          if (tx.vsize && tx.size && tx.vsize < tx.size) segwitTxs++
        })
      })
      const segwitPct = totalTxs > 0 ? (segwitTxs / totalTxs) * 100 : 0

      // Build response
      const txRate = avgBlockTime > 0 ? avgTxsPerBlock / avgBlockTime : 0

      const response: any = {
        block_details: {
          blocks_analyzed: numBlocks,
          block_range: `${effectiveFrom}-${endBlock}`,
          avg_block_time_seconds: parseFloat(avgBlockTime.toFixed(1)),
          avg_block_time_formatted: formatDuration(avgBlockTime),
          avg_block_size_mb: parseFloat((avgBlockSize / 1024 / 1024).toFixed(2)),
          avg_block_size_formatted: (avgBlockSize / 1024 / 1024).toFixed(2) + ' MB',
          avg_transactions_per_block: parseFloat(avgTxsPerBlock.toFixed(1)),
          avg_txs_formatted: formatNumber(avgTxsPerBlock),
          total_transactions: totalTxs,
          total_transactions_formatted: formatNumber(totalTxs),
        },
        transaction_stats: {
          avg_tx_size_bytes: Math.round(avgTxSize),
          avg_tx_vsize: totalTxs > 0 ? Math.round(totalVsize / totalTxs) : 0,
          avg_tx_weight: totalTxs > 0 ? Math.round(totalWeight / totalTxs) : 0,
          total_size_mb: parseFloat((totalSize / 1024 / 1024).toFixed(2)),
          segwit_percentage: parseFloat(segwitPct.toFixed(1)),
          segwit_formatted: formatPct(segwitPct) + ' segwit',
          version_breakdown: Object.fromEntries(versions),
          tx_rate_per_second: parseFloat(txRate.toFixed(2)),
          tx_rate_formatted: formatNumber(txRate) + ' tx/s',
        },
      }

      // Query 2: Outputs for address activity and value flow (optional)
      if (include_address_activity) {
        // Limit output query to fewer blocks to keep it fast
        const outputMaxBlocks = Math.min(numBlocks, 50)
        const outputFrom = endBlock - outputMaxBlocks

        const outputQuery = {
          type: 'bitcoin',
          fromBlock: outputFrom,
          toBlock: endBlock,
          fields: {
            block: { number: true, timestamp: true },
            output: {
              value: true,
              scriptPubKeyAddress: true,
              scriptPubKeyType: true,
            },
          },
          outputs: [{}],
        }

        try {
          const outputResults = await portalFetchStreamRange(
            `${PORTAL_URL}/datasets/${dataset}/stream`,
            outputQuery,
            {
              maxBlocks: outputMaxBlocks,
              maxBytes: 100 * 1024 * 1024,
            },
          )

          const addresses = new Set<string>()
          const scriptTypes = new Map<string, number>()
          let totalOutputValue = 0
          let totalOutputs = 0

          outputResults.forEach((block: any) => {
            ;(block.outputs || []).forEach((output: any) => {
              totalOutputs++
              if (output.scriptPubKeyAddress) addresses.add(output.scriptPubKeyAddress)
              totalOutputValue += output.value || 0

              const sType = output.scriptPubKeyType || 'unknown'
              scriptTypes.set(sType, (scriptTypes.get(sType) || 0) + 1)
            })
          })

          // Calculate adoption percentages
          const scriptTypeBreakdown: Record<string, { count: number; percentage: number }> = {}
          scriptTypes.forEach((count, type) => {
            scriptTypeBreakdown[type] = {
              count,
              percentage: parseFloat(((count / totalOutputs) * 100).toFixed(1)),
            }
          })

          const taprootCount = scriptTypes.get('witness_v1_taproot') || 0
          const segwitV0Count =
            (scriptTypes.get('witness_v0_keyhash') || 0) + (scriptTypes.get('witness_v0_scripthash') || 0)

          response.network_activity = {
            blocks_sampled: outputMaxBlocks,
            unique_addresses: addresses.size,
            total_outputs: totalOutputs,
            total_output_value_btc: parseFloat(totalOutputValue.toFixed(8)),
            avg_outputs_per_block: parseFloat((totalOutputs / outputMaxBlocks).toFixed(1)),
          }

          response.script_type_adoption = {
            taproot_percentage: parseFloat(((taprootCount / totalOutputs) * 100).toFixed(1)),
            segwit_v0_percentage: parseFloat(((segwitV0Count / totalOutputs) * 100).toFixed(1)),
            breakdown: scriptTypeBreakdown,
          }
        } catch {
          response.network_activity = { error: 'Failed to fetch output data — try a smaller range' }
        }
      }

      // Query 3: Inputs for fee estimation (sample a few blocks)
      const feeSampleBlocks = Math.min(numBlocks, 10)
      const feeSampleFrom = endBlock - feeSampleBlocks

      try {
        const inputQuery = {
          type: 'bitcoin',
          fromBlock: feeSampleFrom,
          toBlock: endBlock,
          fields: {
            block: { number: true, timestamp: true },
            input: { prevoutValue: true, transactionIndex: true },
          },
          inputs: [{}],
        }
        const outputFeeQuery = {
          type: 'bitcoin',
          fromBlock: feeSampleFrom,
          toBlock: endBlock,
          fields: {
            block: { number: true, timestamp: true },
            output: { value: true, transactionIndex: true },
          },
          outputs: [{}],
        }

        const [inputResults, outputFeeResults] = await Promise.all([
          portalFetchStreamRange(`${PORTAL_URL}/datasets/${dataset}/stream`, inputQuery, { maxBlocks: feeSampleBlocks }),
          portalFetchStreamRange(`${PORTAL_URL}/datasets/${dataset}/stream`, outputFeeQuery, { maxBlocks: feeSampleBlocks }),
        ])

        // Sum input values and output values to estimate fees.
        // Exclude coinbase (transactionIndex 0) — it has no real inputs
        // and its outputs include the block reward, which skews the calculation.
        let totalInputValue = 0
        let totalOutputValueFee = 0
        let feeTxCount = 0

        inputResults.forEach((block: any) => {
          ;(block.inputs || []).forEach((input: any) => {
            // Coinbase inputs have no prevoutValue (or 0)
            if (input.transactionIndex !== 0) {
              totalInputValue += input.prevoutValue || 0
            }
          })
        })

        outputFeeResults.forEach((block: any) => {
          ;(block.outputs || []).forEach((output: any) => {
            // Skip coinbase transaction outputs (block reward + fees)
            if (output.transactionIndex !== 0) {
              totalOutputValueFee += output.value || 0
            }
          })
        })

        // Count non-coinbase transactions in fee sample
        txResults.forEach((block: any) => {
          const bn = block.header?.number ?? block.number
          if (bn >= feeSampleFrom && bn <= endBlock) {
            feeTxCount += Math.max(0, (block.transactions?.length || 1) - 1)
          }
        })

        // Portal returns Bitcoin values in BTC (decimal), not satoshis
        const totalFees = Math.max(0, totalInputValue - totalOutputValueFee)
        const avgFeePerTx = feeTxCount > 0 ? totalFees / feeTxCount : 0

        const feesPerBlock = totalFees / feeSampleBlocks

        response.fee_analysis = {
          blocks_sampled: feeSampleBlocks,
          total_fees_btc: parseFloat(totalFees.toFixed(8)),
          total_fees_formatted: formatBTC(totalFees),
          avg_fee_per_tx_btc: parseFloat(avgFeePerTx.toFixed(8)),
          avg_fee_per_tx_formatted: formatBTC(avgFeePerTx),
          fees_per_block_btc: parseFloat(feesPerBlock.toFixed(8)),
          fees_per_block_formatted: formatBTC(feesPerBlock),
        }
      } catch {
        response.fee_analysis = { error: 'Failed to estimate fees — try a smaller range' }
      }

      const notices =
        blockRange > maxBlocks
          ? [`Analyzed ${numBlocks} of ${blockRange} requested blocks (capped for performance).`]
          : undefined

      return formatResult(
        response,
        `Bitcoin network analytics: ${numBlocks} blocks, ${totalTxs.toLocaleString()} txs, ${avgTxsPerBlock.toFixed(0)} avg txs/block, ${avgBlockTime.toFixed(0)}s avg block time, ${segwitPct.toFixed(0)}% segwit`,
        {
          notices,
          metadata: {
            dataset,
            from_block: effectiveFrom,
            to_block: endBlock,
            query_start_time: queryStartTime,
          },
        },
      )
    },
  )
}
