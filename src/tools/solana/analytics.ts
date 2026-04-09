import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { resolveDataset, validateBlockRange } from '../../cache/datasets.js'
import { PORTAL_URL } from '../../constants/index.js'
import { detectChainType } from '../../helpers/chain.js'
import { portalFetchStream, portalFetchStreamVisit } from '../../helpers/fetch.js'
import { formatResult } from '../../helpers/format.js'
import { formatDuration, formatNumber, formatPct, shortenAddress } from '../../helpers/formatting.js'
import { hashString53 } from '../../helpers/hash.js'
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

const MAX_ANALYTICS_SLOTS = 9000
const INITIAL_SOLANA_ANALYTICS_CHUNK_SIZE = 3000
const MIN_SOLANA_ANALYTICS_CHUNK_SIZE = 250
const SOLANA_ANALYTICS_CONCURRENCY = 3
const INITIAL_SOLANA_PROGRAM_CHUNK_SIZE = 250
const MIN_SOLANA_PROGRAM_CHUNK_SIZE = 125
const SOLANA_PROGRAM_CONCURRENCY = 2
const SOLANA_ANALYTICS_CACHE_TTL_MS = 10_000

type CachedAnalyticsResult = {
  key: string
  response: Record<string, unknown>
  summary: string
  dataset: string
  fromBlock: number
  toBlock: number
  cachedAt: number
}

let cachedAnalyticsResult: CachedAnalyticsResult | undefined

type SolanaSlotRange = {
  from: number
  to: number
}

function buildSlotRanges(from: number, to: number, chunkSize: number): SolanaSlotRange[] {
  const ranges: SolanaSlotRange[] = []
  for (let current = from; current <= to; current += chunkSize) {
    ranges.push({
      from: current,
      to: Math.min(current + chunkSize - 1, to),
    })
  }
  return ranges
}

async function visitAdaptiveSolanaRange(
  url: string,
  buildQuery: (from: number, to: number) => Record<string, unknown>,
  from: number,
  to: number,
  minChunkSize: number,
  onRecord: (record: unknown) => void | Promise<void>,
): Promise<number> {
  try {
    return await portalFetchStreamVisit(
      url,
      buildQuery(from, to),
      {
        maxBytes: 150 * 1024 * 1024,
        onRecord,
      },
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const rangeSize = to - from + 1

    if (message.includes('Response too large') && rangeSize > minChunkSize && to > from) {
      const mid = from + Math.floor((to - from) / 2)
      const [left, right] = await Promise.all([
        visitAdaptiveSolanaRange(url, buildQuery, from, mid, minChunkSize, onRecord),
        visitAdaptiveSolanaRange(url, buildQuery, mid + 1, to, minChunkSize, onRecord),
      ])
      return left + right
    }

    throw err
  }
}

async function fetchSolanaBlockTimestamp(dataset: string, blockNumber: number): Promise<number | undefined> {
  const result = await portalFetchStream(
    `${PORTAL_URL}/datasets/${dataset}/stream`,
    {
      type: 'solana',
      fromBlock: blockNumber,
      toBlock: blockNumber,
      includeAllBlocks: true,
      fields: {
        block: {
          timestamp: true,
        },
      },
    },
    {
      maxBlocks: 1,
      maxBytes: 2 * 1024 * 1024,
    },
  )

  const firstBlock = result[0] as { header?: { timestamp?: number }; timestamp?: number } | undefined
  return firstBlock?.header?.timestamp ?? firstBlock?.timestamp
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
- Longer analysis: { dataset: "solana-mainnet", timeframe: "1h" }
- Include exact compute units: { dataset: "solana-mainnet", timeframe: "1h", include_compute_units: true }`,
    {
      dataset: z.string().default('solana-mainnet').describe('Dataset name (default: solana-mainnet)'),
      timeframe: z
        .string()
        .optional()
        .default('1h')
        .describe("Time range: '1h', '6h'. Default: '1h'. Solana slots are ~400ms so 1h = ~9000 slots."),
      include_compute_units: z
        .boolean()
        .optional()
        .default(false)
        .describe('Include average compute-unit stats across the full range (disabled by default for speed)'),
      include_programs: z
        .boolean()
        .optional()
        .default(false)
        .describe('Include top programs by instruction count (requires an extra instruction scan and is slower)'),
    },
    async ({ dataset, timeframe, include_compute_units, include_programs }) => {
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

      const requestedSlots = endBlock - fromBlock + 1
      const slotsAnalyzed = Math.min(requestedSlots, MAX_ANALYTICS_SLOTS)
      const effectiveFrom = requestedSlots > slotsAnalyzed ? endBlock - slotsAnalyzed + 1 : fromBlock
      const cacheKey = `${dataset}:${timeframe || '1h'}:${include_compute_units}:${include_programs}`
      const cached =
        cachedAnalyticsResult &&
        cachedAnalyticsResult.key === cacheKey &&
        Date.now() - cachedAnalyticsResult.cachedAt <= SOLANA_ANALYTICS_CACHE_TTL_MS
          ? cachedAnalyticsResult
          : undefined

      if (cached) {
        const response = JSON.parse(JSON.stringify(cached.response)) as Record<string, unknown>
        response._cache = {
          hit: true,
          age_ms: Date.now() - cached.cachedAt,
        }

        return formatResult(
          response,
          cached.summary,
          {
            metadata: {
              dataset: cached.dataset,
              from_block: cached.fromBlock,
              to_block: cached.toBlock,
              query_start_time: queryStartTime,
            },
          },
        )
      }

      const [firstTimestamp, lastTimestamp] = await Promise.all([
        fetchSolanaBlockTimestamp(dataset, effectiveFrom),
        fetchSolanaBlockTimestamp(dataset, endBlock),
      ])

      const feePayers = new Set<number>()
      let totalTxs = 0
      let totalFees = 0
      let errorCount = 0
      let totalComputeUnits = 0
      let computeUnitsSampleTxs = 0
      let chunksFetched = 0

      const txUrl = `${PORTAL_URL}/datasets/${dataset}/stream`
      const txQueryForRange = (chunkFrom: number, chunkTo: number) => ({
        type: 'solana',
        fromBlock: chunkFrom,
        toBlock: chunkTo,
        fields: {
          transaction: {
            fee: true,
            feePayer: true,
            err: true,
            ...(include_compute_units ? { computeUnitsConsumed: true } : {}),
          },
        },
        transactions: [{}],
      })

      const txRanges = buildSlotRanges(effectiveFrom, endBlock, INITIAL_SOLANA_ANALYTICS_CHUNK_SIZE)
      for (let index = 0; index < txRanges.length; index += SOLANA_ANALYTICS_CONCURRENCY) {
        const rangeBatch = txRanges.slice(index, index + SOLANA_ANALYTICS_CONCURRENCY)
        const batchResults = await Promise.all(
          rangeBatch.map((range) =>
            visitAdaptiveSolanaRange(
              txUrl,
              txQueryForRange,
              range.from,
              range.to,
              MIN_SOLANA_ANALYTICS_CHUNK_SIZE,
              (record) => {
                const typedBlock = record as { transactions?: Array<Record<string, unknown>> }
                const txs = typedBlock.transactions || []
                totalTxs += txs.length

                for (let index = 0; index < txs.length; index += 1) {
                  const tx = txs[index]
                  if (typeof tx.feePayer === 'string') feePayers.add(hashString53(tx.feePayer))
                  totalFees += parseInt(String(tx.fee || '0'), 10) || 0
                  if (tx.err) errorCount++
                  if (include_compute_units && tx.computeUnitsConsumed !== undefined) {
                    totalComputeUnits += Number(tx.computeUnitsConsumed) || 0
                    computeUnitsSampleTxs++
                  }
                }
              },
            ),
          ),
        )

        for (const processedRecords of batchResults) {
          if (processedRecords > 0) {
            chunksFetched++
          }
        }
      }

      const timeSpanSeconds =
        firstTimestamp !== undefined && lastTimestamp !== undefined
          ? Math.max(0, lastTimestamp - firstTimestamp)
          : slotsAnalyzed * 0.4
      const avgSlotTime = slotsAnalyzed > 1 && timeSpanSeconds > 0
        ? timeSpanSeconds / (slotsAnalyzed - 1)
        : 0.4
      const avgTxsPerSlot = slotsAnalyzed > 0 ? totalTxs / slotsAnalyzed : 0
      const tps = avgSlotTime > 0 ? avgTxsPerSlot / avgSlotTime : 0
      const avgFee = totalTxs > 0 ? totalFees / totalTxs : 0
      const successRate = totalTxs > 0 ? ((totalTxs - errorCount) / totalTxs) * 100 : 0
      const avgComputeUnits = computeUnitsSampleTxs > 0 ? totalComputeUnits / computeUnitsSampleTxs : 0
      const slotsPerHour = timeSpanSeconds > 0 ? (slotsAnalyzed / timeSpanSeconds) * 3600 : 0

      const response: any = {
        network: {
          slots_analyzed: slotsAnalyzed,
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
        },
      }

      if (include_compute_units && computeUnitsSampleTxs > 0) {
        response.activity.avg_compute_units = Math.round(avgComputeUnits)
        response.activity.avg_compute_formatted = formatNumber(avgComputeUnits) + ' CU'
        response.activity.compute_unit_sample_txs = computeUnitsSampleTxs
      }

      // Query 2: Top programs by instruction count (optional)
      if (include_programs) {
        const programSlots = Math.min(slotsAnalyzed, 250)
        const programFrom = Math.max(effectiveFrom, endBlock - programSlots + 1)

        try {
          const programCounts = new Map<string, { calls: number; computeUnits: number }>()
          let totalInstructions = 0
          let programSlotsAnalyzed = 0
          const instructionQueryForRange = (programChunkFrom: number, pTo: number) => ({
            type: 'solana',
            fromBlock: programChunkFrom,
            toBlock: pTo,
            fields: {
              instruction: {
                programId: true,
                computeUnitsConsumed: true,
              },
            },
            instructions: [{}],
          })

          const programRanges = buildSlotRanges(programFrom, endBlock, INITIAL_SOLANA_PROGRAM_CHUNK_SIZE)
          const programUrl = `${PORTAL_URL}/datasets/${dataset}/stream`

          for (let index = 0; index < programRanges.length; index += SOLANA_PROGRAM_CONCURRENCY) {
            const rangeBatch = programRanges.slice(index, index + SOLANA_PROGRAM_CONCURRENCY)
            await Promise.all(
              rangeBatch.map(async (range) => {
                try {
                  return await visitAdaptiveSolanaRange(
                    programUrl,
                    instructionQueryForRange,
                    range.from,
                    range.to,
                    MIN_SOLANA_PROGRAM_CHUNK_SIZE,
                    (record) => {
                      const block = record as { instructions?: Array<{ programId?: string; computeUnitsConsumed?: number | string }> }
                      programSlotsAnalyzed++
                      ;(block.instructions || []).forEach((instr) => {
                        totalInstructions++
                        const pid = instr.programId || 'unknown'
                        const existing = programCounts.get(pid) || { calls: 0, computeUnits: 0 }
                        existing.calls++
                        existing.computeUnits += Number(instr.computeUnitsConsumed) || 0
                        programCounts.set(pid, existing)
                      })
                    },
                  )
                } catch {
                  return 0
                }
              }),
            )
          }

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
            slots_sampled: programSlotsAnalyzed,
            total_instructions: totalInstructions,
            total_instructions_formatted: formatNumber(totalInstructions),
            programs: topPrograms,
          }
        } catch {
          response.top_programs = { error: 'Failed to fetch instruction data' }
        }
      }

      if (requestedSlots > slotsAnalyzed) {
        response._note = `Analyzed ${slotsAnalyzed} of ${requestedSlots} requested slots (capped for performance)`
      }
      if (chunksFetched > 1) {
        response._chunks_fetched = chunksFetched
      }

      const summary =
        `Solana analytics: ${formatNumber(tps)} TPS, ${formatNumber(totalTxs)} txs, ` +
        `${formatNumber(feePayers.size)} wallets, ${formatPct(successRate)} success, ` +
        `avg fee ${formatNumber(avgFee)} lamports`

      cachedAnalyticsResult = {
        key: cacheKey,
        response: JSON.parse(JSON.stringify(response)) as Record<string, unknown>,
        summary,
        dataset,
        fromBlock: effectiveFrom,
        toBlock: endBlock,
        cachedAt: Date.now(),
      }

      return formatResult(
        response,
        summary,
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
