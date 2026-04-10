import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { resolveDataset, validateBlockRange } from '../../cache/datasets.js'
import { PORTAL_URL } from '../../constants/index.js'
import { detectChainType } from '../../helpers/chain.js'
import { ActionableError, createUnsupportedChainError } from '../../helpers/errors.js'
import { portalFetchStream, portalFetchStreamRangeVisit } from '../../helpers/fetch.js'
import { formatResult } from '../../helpers/format.js'
import { formatDuration, formatNumber, formatPct, shortenAddress } from '../../helpers/formatting.js'
import { hashString53 } from '../../helpers/hash.js'
import { buildPaginationInfo, decodeOffsetPageCursor, encodeOffsetPageCursor, paginateOffsetItems } from '../../helpers/pagination.js'
import { buildAnalysisCoverage, buildQueryFreshness } from '../../helpers/result-metadata.js'
import type { ResponseFormat } from '../../helpers/response-modes.js'
import { buildPercentileSummary } from '../../helpers/statistics.js'
import { resolveTimeframeOrBlocks, type TimestampInput } from '../../helpers/timeframe.js'
import { buildExecutionMetadata, buildToolDescription } from '../../helpers/tool-ux.js'

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
const SOLANA_ANALYTICS_CACHE_TTL_MS = 30_000
const SOLANA_ANALYTICS_CACHE_MAX_ENTRIES = 8
const SOLANA_ANALYTICS_SLOT_BUDGET: Record<SolanaAnalyticsTimeframe, number> = {
  '5m': 750,
  '15m': 2250,
  '1h': 9000,
  '6h': 9000,
}
const SOLANA_ANALYTICS_FAST_SLOT_BUDGET: Record<SolanaAnalyticsTimeframe, number> = {
  '5m': 750,
  '15m': 2250,
  '1h': 4500,
  '6h': 6000,
}
const SOLANA_ANALYTICS_CHUNK_SIZE: Record<SolanaAnalyticsTimeframe, number> = {
  '5m': 500,
  '15m': 750,
  '1h': 3000,
  '6h': 3000,
}
const SOLANA_ANALYTICS_FAST_CHUNK_SIZE: Record<SolanaAnalyticsTimeframe, number> = {
  '5m': 500,
  '15m': 750,
  '1h': 1500,
  '6h': 2000,
}

type SolanaAnalyticsTimeframe = '5m' | '15m' | '1h' | '6h'

type SolanaAnalyticsCursorRequest = {
  timeframe: SolanaAnalyticsTimeframe
  mode: 'fast' | 'deep'
  include_compute_units: boolean
  include_programs: boolean
  response_format: ResponseFormat
  program_limit: number
  window_from_block: number
  window_to_block: number
  range_kind: 'timeframe' | 'block_range' | 'timestamp_range'
  from_timestamp?: TimestampInput
  to_timestamp?: TimestampInput
}

type CachedAnalyticsResult = {
  key: string
  response: Record<string, unknown>
  summary: string
  dataset: string
  fromBlock: number
  toBlock: number
  cachedAt: number
}

type FreshAnalyticsResult = {
  formattedResponse: Record<string, unknown>
  response: Record<string, any>
  summary: string
  shortSummary: string
  notices?: string[]
  hasMorePrograms: boolean
  effectiveFrom: number
}

type PendingAnalyticsResult = Promise<FreshAnalyticsResult>

const analyticsCache = new Map<string, CachedAnalyticsResult>()
const pendingAnalyticsResults = new Map<string, PendingAnalyticsResult>()

function getCachedAnalyticsResult(cacheKey: string): CachedAnalyticsResult | undefined {
  const cached = analyticsCache.get(cacheKey)
  if (!cached) return undefined
  if (Date.now() - cached.cachedAt > SOLANA_ANALYTICS_CACHE_TTL_MS) {
    analyticsCache.delete(cacheKey)
    return undefined
  }
  return cached
}

function setCachedAnalyticsResult(cacheKey: string, result: Omit<CachedAnalyticsResult, 'cachedAt' | 'key'>): void {
  analyticsCache.set(cacheKey, {
    key: cacheKey,
    cachedAt: Date.now(),
    ...result,
  })

  if (analyticsCache.size > SOLANA_ANALYTICS_CACHE_MAX_ENTRIES) {
    const oldestEntry = Array.from(analyticsCache.entries()).reduce<[string, CachedAnalyticsResult] | undefined>(
      (oldest, entry) => {
        if (!oldest || entry[1].cachedAt < oldest[1].cachedAt) return entry
        return oldest
      },
      undefined,
    )
    if (oldestEntry) analyticsCache.delete(oldestEntry[0])
  }
}

function formatSolanaAnalyticsResponse(response: Record<string, any>, responseFormat: ResponseFormat) {
  if (responseFormat === 'full') {
    return response
  }

  if (responseFormat === 'summary') {
    return {
      overview: {
        mode: response.network?.mode,
        timeframe_requested: response.network?.timeframe_requested,
        slots_analyzed: response.network?.slots_analyzed,
        total_transactions: response.throughput?.total_transactions,
        tps: response.throughput?.tps,
        total_fees_sol: response.fees?.total_fees_sol,
        avg_fee_lamports: response.fees?.avg_fee_lamports,
        fee_percentiles_lamports: response.fees?.fee_percentiles_lamports,
        unique_wallets: response.activity?.unique_wallets,
        success_rate: response.activity?.success_rate,
        avg_compute_units: response.activity?.avg_compute_units,
      },
      ...(response.top_programs?.programs?.[0]
        ? {
            top_program: response.top_programs.programs[0],
          }
        : {}),
    }
  }

  return {
    network: response.network,
    throughput: response.throughput,
    fees: {
      total_fees_lamports: response.fees?.total_fees_lamports,
      total_fees_sol: response.fees?.total_fees_sol,
      avg_fee_lamports: response.fees?.avg_fee_lamports,
      fee_percentiles_lamports: response.fees?.fee_percentiles_lamports,
    },
    activity: response.activity,
    ...(response.top_programs ? { top_programs: response.top_programs } : {}),
  }
}

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
    return await portalFetchStreamRangeVisit(
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
    'portal_solana_get_analytics',
    buildToolDescription('portal_solana_get_analytics'),
    {
      network: z.string().default('solana-mainnet').describe('Network name (default: solana-mainnet)'),
      timeframe: z
        .enum(['5m', '15m', '1h', '6h'])
        .optional()
        .describe("Time range: '5m', '15m', '1h', '6h'. Optional; defaults depend on mode."),
      mode: z
        .enum(['fast', 'deep'])
        .optional()
        .default('fast')
        .describe("fast = lighter snapshot with smaller scan budgets, deep = larger scan budgets for fuller coverage"),
      from_timestamp: z
        .union([z.string(), z.number()])
        .optional()
        .describe('Natural start time like "1h ago", "today 09:00", ISO datetime, or Unix timestamp'),
      to_timestamp: z
        .union([z.string(), z.number()])
        .optional()
        .describe('Natural end time like "now", ISO datetime, or Unix timestamp'),
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
      program_limit: z
        .number()
        .optional()
        .default(20)
        .describe('Max top-program rows to return per page when include_programs is enabled'),
      response_format: z
        .enum(['full', 'compact', 'summary'])
        .optional()
        .default('full')
        .describe("Response format: 'summary' (high-level metrics), 'compact' (core sections), 'full' (complete analytics)."),
      cursor: z.string().optional().describe('Continuation cursor for paginating top_programs'),
    },
    async ({ network, timeframe, mode, from_timestamp, to_timestamp, include_compute_units, include_programs, program_limit, response_format, cursor }) => {
      const queryStartTime = Date.now()
      const paginationCursor = cursor
        ? decodeOffsetPageCursor<SolanaAnalyticsCursorRequest>(cursor, 'portal_solana_get_analytics')
        : undefined
      const requestedDataset = network ? await resolveDataset(network) : undefined
      let dataset = paginationCursor?.dataset ?? requestedDataset ?? 'solana-mainnet'
      if (paginationCursor && requestedDataset && paginationCursor.dataset !== requestedDataset) {
        throw new ActionableError('This cursor belongs to a different dataset.', [
          'Reuse the cursor with the same dataset as the previous response.',
          'Omit cursor to start a fresh Solana analytics snapshot.',
        ], {
          cursor_dataset: paginationCursor.dataset,
          requested_dataset: requestedDataset,
        })
      }
      if (paginationCursor) {
        timeframe = paginationCursor.request.timeframe
        mode = paginationCursor.request.mode
        include_compute_units = paginationCursor.request.include_compute_units
        include_programs = paginationCursor.request.include_programs
        program_limit = paginationCursor.request.program_limit
        response_format = paginationCursor.request.response_format
        from_timestamp = paginationCursor.request.from_timestamp
        to_timestamp = paginationCursor.request.to_timestamp
      }
      const requestedTimeframe: SolanaAnalyticsTimeframe = timeframe ?? (mode === 'deep' ? '1h' : '5m')
      const chainType = detectChainType(dataset)

      if (chainType !== 'solana') {
        throw createUnsupportedChainError({
          toolName: 'portal_solana_get_analytics',
          dataset,
          actualChainType: chainType,
          supportedChains: ['solana'],
          suggestions: [
            'Use portal_get_time_series for generic EVM or Bitcoin charts.',
            'Use portal_bitcoin_get_analytics or EVM convenience tools for other chains.',
          ],
        })
      }

      const freshResolvedWindow = paginationCursor
        ? undefined
        : await resolveTimeframeOrBlocks({
            dataset,
            timeframe: from_timestamp === undefined && to_timestamp === undefined ? requestedTimeframe : undefined,
            from_timestamp: from_timestamp as TimestampInput | undefined,
            to_timestamp: to_timestamp as TimestampInput | undefined,
          })
      const resolvedWindow = paginationCursor
        ? { range_kind: paginationCursor.request.range_kind }
        : freshResolvedWindow!
      const fromBlock = paginationCursor?.request.window_from_block ?? freshResolvedWindow!.from_block

      const { validatedToBlock: endBlock, head } = await validateBlockRange(
        dataset,
        fromBlock,
        paginationCursor?.request.window_to_block ?? freshResolvedWindow?.to_block ?? Number.MAX_SAFE_INTEGER,
        false,
      )

      const requestedSlots = endBlock - fromBlock + 1
      const maxSlotsForTimeframe = mode === 'deep'
        ? SOLANA_ANALYTICS_SLOT_BUDGET[requestedTimeframe]
        : SOLANA_ANALYTICS_FAST_SLOT_BUDGET[requestedTimeframe]
      const slotsAnalyzed = Math.min(requestedSlots, maxSlotsForTimeframe, MAX_ANALYTICS_SLOTS)
      const effectiveFrom = requestedSlots > slotsAnalyzed ? endBlock - slotsAnalyzed + 1 : fromBlock
      const cacheKey = `${dataset}:${mode}:${requestedTimeframe}:${String(from_timestamp ?? '')}:${String(to_timestamp ?? '')}:${include_compute_units}:${include_programs}:${response_format}:${program_limit}`
      const cached = !cursor && !include_programs ? getCachedAnalyticsResult(cacheKey) : undefined

      if (cached) {
        const response = JSON.parse(JSON.stringify(cached.response)) as Record<string, any>
        response._cache = {
          hit: true,
          age_ms: Date.now() - cached.cachedAt,
        }

        return formatResult(
          formatSolanaAnalyticsResponse(response, response_format as ResponseFormat),
          response_format === 'summary'
            ? `Solana summary: ${formatNumber(response.throughput?.tps ?? 0)} TPS, ${formatNumber(response.throughput?.total_transactions ?? 0)} txs, ${formatNumber(response.activity?.unique_wallets ?? 0)} wallets`
            : cached.summary,
          {
            toolName: 'portal_solana_get_analytics',
            ordering: {
              kind: 'sections',
            },
            freshness: buildQueryFreshness({
              finality: 'latest',
              headBlockNumber: head.number,
              windowToBlock: endBlock,
              resolvedWindow,
            }),
            coverage: buildAnalysisCoverage({
              windowFromBlock: fromBlock,
              windowToBlock: endBlock,
              analyzedFromBlock: cached.fromBlock,
              analyzedToBlock: endBlock,
            }),
            execution: buildExecutionMetadata({
              mode,
              response_format,
              from_block: cached.fromBlock,
              to_block: endBlock,
              range_kind: resolvedWindow.range_kind,
              notes: ['Served from the short-lived Solana analytics cache.'],
            }),
            metadata: {
              dataset: cached.dataset,
              from_block: cached.fromBlock,
              to_block: cached.toBlock,
              query_start_time: queryStartTime,
            },
          },
        )
      }

      const loadFreshAnalytics = async () => {
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
        const feeSamples: number[] = []
        const computeUnitSamples: number[] = []

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

        const analyticsChunkSize = (
          mode === 'deep' ? SOLANA_ANALYTICS_CHUNK_SIZE[requestedTimeframe] : SOLANA_ANALYTICS_FAST_CHUNK_SIZE[requestedTimeframe]
        ) || INITIAL_SOLANA_ANALYTICS_CHUNK_SIZE
        const txRanges = buildSlotRanges(effectiveFrom, endBlock, analyticsChunkSize)
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
                    const fee = parseInt(String(tx.fee || '0'), 10) || 0
                    totalFees += fee
                    feeSamples.push(fee)
                    if (tx.err) errorCount++
                    if (include_compute_units && tx.computeUnitsConsumed !== undefined) {
                      const computeUnits = Number(tx.computeUnitsConsumed) || 0
                      totalComputeUnits += computeUnits
                      computeUnitsSampleTxs++
                      computeUnitSamples.push(computeUnits)
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
            mode,
            timeframe_requested: requestedTimeframe,
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
            fee_percentiles_lamports: buildPercentileSummary(feeSamples),
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
          response.activity.compute_unit_percentiles = buildPercentileSummary(computeUnitSamples)
        }

        // Query 2: Top programs by instruction count (optional)
        if (include_programs) {
          const programSlots = Math.min(slotsAnalyzed, requestedTimeframe === '5m' ? 150 : 250)
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
              .map((item, i) => ({ rank: i + 1, ...item }))

            const { pageItems, hasMore, nextOffset } = paginateOffsetItems(
              topPrograms,
              program_limit,
              paginationCursor?.offset ?? 0,
            )
            const nextCursor = hasMore
              ? encodeOffsetPageCursor<SolanaAnalyticsCursorRequest>({
                  tool: 'portal_solana_get_analytics',
                  dataset,
                  request: {
                    timeframe: requestedTimeframe,
                    mode,
                    include_compute_units,
                    include_programs,
                    response_format: response_format as ResponseFormat,
                    program_limit,
                    window_from_block: fromBlock,
                    window_to_block: endBlock,
                    range_kind: resolvedWindow.range_kind,
                    ...(from_timestamp !== undefined ? { from_timestamp: from_timestamp as TimestampInput } : {}),
                    ...(to_timestamp !== undefined ? { to_timestamp: to_timestamp as TimestampInput } : {}),
                  },
                  offset: nextOffset ?? (paginationCursor?.offset ?? 0) + pageItems.length,
                })
              : undefined

            response.top_programs = {
              slots_sampled: programSlotsAnalyzed,
              total_instructions: totalInstructions,
              total_instructions_formatted: formatNumber(totalInstructions),
              total_programs: topPrograms.length,
              programs: pageItems,
              program_limit,
              has_more: hasMore,
              ...(nextCursor ? { next_cursor: nextCursor } : {}),
            }
          } catch {
            response.top_programs = { error: 'Failed to fetch instruction data' }
          }
        }

        const notices =
          requestedSlots > slotsAnalyzed
            ? [`${mode === 'fast' ? 'Fast' : 'Deep'} mode analyzed ${slotsAnalyzed} of ${requestedSlots} requested slots to keep the snapshot responsive.`]
            : mode === 'fast' && !timeframe
              ? ['Fast snapshot mode defaults to a 5-minute Solana window for better UX.']
              : undefined
        if (chunksFetched > 1) {
          response._chunks_fetched = chunksFetched
        }
        const hasMorePrograms = Boolean(response.top_programs?.has_more)
        const formattedResponse = formatSolanaAnalyticsResponse(response, response_format as ResponseFormat)

        const summary =
          `Solana analytics: ${formatNumber(tps)} TPS, ${formatNumber(totalTxs)} txs, ` +
          `${formatNumber(feePayers.size)} wallets, ${formatPct(successRate)} success, ` +
          `avg fee ${formatNumber(avgFee)} lamports`

        if (!cursor && !include_programs) {
          setCachedAnalyticsResult(cacheKey, {
            response: JSON.parse(JSON.stringify(response)) as Record<string, unknown>,
            summary,
            dataset,
            fromBlock: effectiveFrom,
            toBlock: endBlock,
          })
        }

        return {
          formattedResponse,
          summary,
          shortSummary: `Solana summary: ${formatNumber(tps)} TPS, ${formatNumber(totalTxs)} txs, ${formatNumber(feePayers.size)} wallets`,
          notices,
          hasMorePrograms,
          effectiveFrom,
          response,
        }
      }

      const pending = !cursor && !include_programs ? pendingAnalyticsResults.get(cacheKey) : undefined
      const analyticsResult = pending ?? loadFreshAnalytics()
      if (!pending && !cursor && !include_programs) {
        pendingAnalyticsResults.set(cacheKey, analyticsResult)
      }

      let freshAnalytics
      try {
        freshAnalytics = await analyticsResult
      } finally {
        if (!pending && !cursor && !include_programs) {
          pendingAnalyticsResults.delete(cacheKey)
        }
      }

      return formatResult(
        freshAnalytics.formattedResponse,
        response_format === 'summary' ? freshAnalytics.shortSummary : freshAnalytics.summary,
        {
          toolName: 'portal_solana_get_analytics',
          notices: freshAnalytics.notices,
          ...(include_programs
            ? {
                pagination: buildPaginationInfo(
                  program_limit,
                  freshAnalytics.response.top_programs?.programs?.length ?? 0,
                  freshAnalytics.response.top_programs?.next_cursor,
                ),
              }
            : {}),
          ordering: {
            kind: 'sections',
            ...(include_programs
              ? {
                  top_programs: {
                    order: 'rank_ascending',
                    sorted_by: 'instruction_count',
                    direction: 'desc',
                  },
                }
              : {}),
          },
          freshness: buildQueryFreshness({
            finality: 'latest',
            headBlockNumber: head.number,
            windowToBlock: endBlock,
            resolvedWindow,
          }),
          coverage: buildAnalysisCoverage({
            windowFromBlock: fromBlock,
            windowToBlock: endBlock,
            analyzedFromBlock: freshAnalytics.effectiveFrom,
            analyzedToBlock: endBlock,
            hasMore: freshAnalytics.hasMorePrograms,
          }),
          execution: buildExecutionMetadata({
            mode,
            response_format,
            from_block: freshAnalytics.effectiveFrom,
            to_block: endBlock,
            range_kind: resolvedWindow.range_kind,
            notes: [
              include_programs ? 'Top-program pagination is active.' : 'Program scan was skipped unless requested.',
              include_compute_units ? 'Compute-unit sampling was enabled.' : 'Compute-unit sampling stayed lightweight.',
            ],
          }),
          metadata: {
            dataset,
            from_block: freshAnalytics.effectiveFrom,
            to_block: endBlock,
            query_start_time: queryStartTime,
          },
        },
      )
    },
  )
}
