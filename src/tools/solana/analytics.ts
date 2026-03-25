import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { getBlockHead, resolveDataset, validateBlockRange } from '../../cache/datasets.js'
import { PORTAL_URL } from '../../constants/index.js'
import { detectChainType } from '../../helpers/chain.js'
import { portalFetchStream } from '../../helpers/fetch.js'
import { formatResult } from '../../helpers/format.js'
import { formatNumber, formatPct, formatDuration, shortenAddress } from '../../helpers/formatting.js'
import { resolveTimeframeOrBlocks } from '../../helpers/timeframe.js'

// ============================================================================
// Tool: Solana Network Analytics
// ============================================================================

// Well-known Solana program names
const PROGRAM_NAMES: Record<string, string> = {
  '11111111111111111111111111111111': 'System Program',
  TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA: 'Token Program',
  TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb: 'Token-2022',
  ComputeBudget111111111111111111111111111111: 'Compute Budget',
  ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL: 'Associated Token',
  JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4: 'Jupiter v6',
  whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc: 'Orca Whirlpool',
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8': 'Raydium AMM',
  CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK: 'Raydium CLMM',
  metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s: 'Metaplex Metadata',
  MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr: 'Memo v2',
  dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH: 'Drift Protocol',
  srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX: 'Serum v3',
  PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY: 'Phoenix',
  jCebN34bUfdeUYJT13J1yG16XWQpt5PDx6Mse9GUqhR: 'Solend',
  Vote111111111111111111111111111111111111111: 'Vote Program',
}

function getProgramName(id: string): string {
  return PROGRAM_NAMES[id] || shortenAddress(id)
}

export function registerSolanaAnalyticsTool(server: McpServer) {
  server.tool(
    'portal_solana_analytics',
    `Comprehensive Solana network analytics dashboard. Returns TPS, slot production rate, fee analysis, unique wallets, success rate, and top programs — all in one call.

WHEN TO USE:
- "How's Solana doing?"
- "Solana TPS right now?"
- "What are Solana fees?"
- "Top programs on Solana"
- "Solana network activity"

EXAMPLES:
- Quick snapshot: { dataset: "solana-mainnet" }
- Longer analysis: { dataset: "solana-mainnet", timeframe: "1h" }`,
    {
      dataset: z.string().default('solana-mainnet').describe('Dataset name (default: solana-mainnet)'),
      timeframe: z
        .string()
        .optional()
        .default('1h')
        .describe("Time range: '1h', '6h'. Default: '1h'. Solana slots are ~400ms so 1h = ~9000 slots."),
      include_programs: z
        .boolean()
        .optional()
        .default(true)
        .describe('Include top programs by instruction count (requires extra query, slower)'),
    },
    async ({ dataset, timeframe, include_programs }) => {
      const queryStartTime = Date.now()
      dataset = await resolveDataset(dataset)
      const chainType = detectChainType(dataset)

      if (chainType !== 'solana') {
        throw new Error('portal_solana_analytics is only for Solana chains.')
      }

      const { from_block: fromBlock, to_block: toBlock } = await resolveTimeframeOrBlocks({
        dataset,
        timeframe,
      })

      const { validatedToBlock: endBlock } = await validateBlockRange(
        dataset,
        fromBlock,
        toBlock ?? Number.MAX_SAFE_INTEGER,
        false,
      )

      // Cap slots for performance — Solana is extremely dense
      const slotRange = endBlock - fromBlock
      const maxSlots = Math.min(slotRange, 5000) // ~33 min at 400ms/slot
      const effectiveFrom = slotRange > maxSlots ? endBlock - maxSlots : fromBlock

      // Query 1: Transactions (TPS, fees, wallets, success rate)
      const txQuery = {
        type: 'solana',
        fromBlock: effectiveFrom,
        toBlock: endBlock,
        includeAllBlocks: true,
        fields: {
          block: { number: true, timestamp: true },
          transaction: {
            transactionIndex: true,
            fee: true,
            feePayer: true,
            err: true,
            computeUnitsConsumed: true,
          },
        },
        transactions: [{}],
      }

      const txResults = await portalFetchStream(
        `${PORTAL_URL}/datasets/${dataset}/stream`,
        txQuery,
        undefined,
        maxSlots,
        100 * 1024 * 1024,
      )

      // Compute stats
      const feePayers = new Set<string>()
      let totalTxs = 0
      let totalFees = 0
      let totalComputeUnits = 0
      let errorCount = 0
      let slotCount = txResults.length
      const slotTimes: number[] = []

      for (let i = 0; i < txResults.length; i++) {
        const block = txResults[i] as any
        const txs = block.transactions || []
        totalTxs += txs.length

        txs.forEach((tx: any) => {
          if (tx.feePayer) feePayers.add(tx.feePayer)
          totalFees += parseInt(tx.fee || '0') || 0
          totalComputeUnits += tx.computeUnitsConsumed || 0
          if (tx.err) errorCount++
        })

        // Slot time
        if (i > 0) {
          const prevTs = (txResults[i - 1] as any).header?.timestamp
          const curTs = block.header?.timestamp
          if (prevTs && curTs && curTs > prevTs) {
            slotTimes.push(curTs - prevTs)
          }
        }
      }

      const avgSlotTime = slotTimes.length > 0 ? slotTimes.reduce((a, b) => a + b, 0) / slotTimes.length : 0.4
      const avgTxsPerSlot = slotCount > 0 ? totalTxs / slotCount : 0
      const tps = avgSlotTime > 0 ? avgTxsPerSlot / avgSlotTime : 0
      const avgFee = totalTxs > 0 ? totalFees / totalTxs : 0
      const successRate = totalTxs > 0 ? ((totalTxs - errorCount) / totalTxs) * 100 : 0
      const avgComputeUnits = totalTxs > 0 ? totalComputeUnits / totalTxs : 0

      // Time range
      const firstTs = (txResults[0] as any)?.header?.timestamp
      const lastTs = (txResults[txResults.length - 1] as any)?.header?.timestamp
      const timeSpanSeconds = firstTs && lastTs ? lastTs - firstTs : slotCount * 0.4

      const slotsPerHour = timeSpanSeconds > 0 ? (slotCount / timeSpanSeconds) * 3600 : 0

      const response: any = {
        network: {
          slots_analyzed: slotCount,
          slot_range: `${effectiveFrom}-${endBlock}`,
          time_span_formatted: formatDuration(timeSpanSeconds),
          avg_slot_time_ms: Math.round(avgSlotTime * 1000),
          slots_per_hour: Math.round(slotsPerHour),
          slots_per_hour_formatted: formatNumber(slotsPerHour),
        },
        throughput: {
          total_transactions: totalTxs,
          total_transactions_formatted: formatNumber(totalTxs),
          tps: parseFloat(tps.toFixed(1)),
          tps_formatted: formatNumber(tps) + ' tx/s',
          avg_txs_per_slot: parseFloat(avgTxsPerSlot.toFixed(1)),
        },
        fees: {
          total_fees_lamports: totalFees,
          total_fees_sol: parseFloat((totalFees / 1e9).toFixed(6)),
          total_fees_formatted: formatNumber(totalFees / 1e9) + ' SOL',
          avg_fee_lamports: Math.round(avgFee),
          avg_fee_formatted: formatNumber(avgFee) + ' lamports',
        },
        activity: {
          unique_wallets: feePayers.size,
          unique_wallets_formatted: formatNumber(feePayers.size),
          success_rate: parseFloat(successRate.toFixed(1)),
          success_rate_formatted: formatPct(successRate),
          error_count: errorCount,
          avg_compute_units: Math.round(avgComputeUnits),
          avg_compute_formatted: formatNumber(avgComputeUnits) + ' CU',
        },
      }

      // Query 2: Top programs by instruction count (optional)
      if (include_programs) {
        const programSlots = Math.min(slotCount, 1000) // Sample fewer slots for programs
        const programFrom = endBlock - programSlots

        try {
          const instrQuery = {
            type: 'solana',
            fromBlock: programFrom,
            toBlock: endBlock,
            fields: {
              block: { number: true },
              instruction: {
                programId: true,
                computeUnitsConsumed: true,
              },
            },
            instructions: [{}],
          }

          const instrResults = await portalFetchStream(
            `${PORTAL_URL}/datasets/${dataset}/stream`,
            instrQuery,
            undefined,
            programSlots,
            100 * 1024 * 1024,
          )

          const programCounts = new Map<string, { calls: number; computeUnits: number }>()
          let totalInstructions = 0

          instrResults.forEach((block: any) => {
            ;(block.instructions || []).forEach((instr: any) => {
              totalInstructions++
              const pid = instr.programId || 'unknown'
              const existing = programCounts.get(pid) || { calls: 0, computeUnits: 0 }
              existing.calls++
              existing.computeUnits += instr.computeUnitsConsumed || 0
              programCounts.set(pid, existing)
            })
          })

          const topPrograms = Array.from(programCounts.entries())
            .map(([programId, data]) => ({
              program_id: programId,
              program_name: getProgramName(programId),
              instruction_count: data.calls,
              instruction_count_formatted: formatNumber(data.calls),
              share: formatPct((data.calls / totalInstructions) * 100),
              avg_compute_units: Math.round(data.computeUnits / data.calls),
            }))
            .sort((a, b) => b.instruction_count - a.instruction_count)
            .slice(0, 20)
            .map((item, i) => ({ rank: i + 1, ...item }))

          response.top_programs = {
            slots_sampled: programSlots,
            total_instructions: totalInstructions,
            total_instructions_formatted: formatNumber(totalInstructions),
            programs: topPrograms,
          }
        } catch {
          response.top_programs = { error: 'Failed to fetch instruction data' }
        }
      }

      const wasPartial = slotRange > maxSlots
      if (wasPartial) {
        response._note = `Analyzed ${slotCount} of ${slotRange} requested slots (capped for performance)`
      }

      return formatResult(
        response,
        `Solana analytics: ${formatNumber(tps)} TPS, ${formatNumber(totalTxs)} txs, ${formatNumber(feePayers.size)} wallets, ${formatPct(successRate)} success, avg fee ${formatNumber(avgFee)} lamports`,
        {
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
