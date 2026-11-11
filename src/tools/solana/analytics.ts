import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'

import { resolveDataset, validateBlockRange } from '../../cache/datasets.js'
import { PORTAL_URL } from '../../constants/index.js'
import { detectChainType } from '../../helpers/chain.js'
import { buildTableDescriptor } from '../../helpers/chart-metadata.js'
import { ActionableError, RequestCancelledError, createUnsupportedChainError } from '../../helpers/errors.js'
import { divideExactDecimals, formatIntegerUnitsExact } from '../../helpers/exact-decimal.js'
import { portalFetchStream, portalFetchStreamRangeVisit } from '../../helpers/fetch.js'
import { formatDuration, formatNumber, formatPct, formatResult, shortenAddress } from '../../helpers/format.js'
import { hashString53 } from '../../helpers/hash.js'
import { registerPortalTool } from '../../helpers/mcp-registration.js'
import {
  buildPaginationInfo,
  decodeOffsetPageCursor,
  encodeOffsetPageCursor,
  paginateOffsetItems,
} from '../../helpers/pagination.js'
import {
  type SharedPortalWork,
  getPortalRequestSignal,
  runAsSharedPortalWork,
  waitForSharedPortalWork,
} from '../../helpers/request-context.js'
import type { ResponseFormat } from '../../helpers/response-modes.js'
import { buildAnalysisCoverage, buildQueryFreshness } from '../../helpers/result-metadata.js'
import { buildPercentileSummary } from '../../helpers/statistics.js'
import { StreamRecoveryBudget, getStreamRangeRecovery } from '../../helpers/stream-progress.js'
import { type TimestampInput, parseTimeframeToSeconds, resolveTimeframeOrBlocks } from '../../helpers/timeframe.js'
import { buildExecutionMetadata, buildToolDescription } from '../../helpers/tool-ux.js'
import { buildMetricCard, buildPortalUi, buildRankedBarsPanel, buildTablePanel } from '../../helpers/ui-metadata.js'

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

const MAX_ANALYTICS_SLOTS = 10_000
const INITIAL_SOLANA_ANALYTICS_CHUNK_SIZE = 3000
const MIN_SOLANA_ANALYTICS_CHUNK_SIZE = 250
const SOLANA_ANALYTICS_CONCURRENCY = 3
const INITIAL_SOLANA_PROGRAM_CHUNK_SIZE = 250
const MIN_SOLANA_PROGRAM_CHUNK_SIZE = 125
const SOLANA_PROGRAM_CONCURRENCY = 2
const SOLANA_ANALYTICS_CACHE_TTL_MS = 30_000
const SOLANA_ANALYTICS_CACHE_MAX_ENTRIES = 8
const SOLANA_ANALYTICS_SLOT_BUDGET: Record<SolanaAnalyticsBudgetKey, number> = {
  '5m': 1_000,
  '15m': 2_500,
  '1h': 10_000,
  '6h': 10_000,
}
const SOLANA_ANALYTICS_FAST_SLOT_BUDGET: Record<SolanaAnalyticsBudgetKey, number> = {
  '5m': 1_000,
  '15m': 2_500,
  '1h': 10_000,
  '6h': 10_000,
}
const SOLANA_ANALYTICS_CHUNK_SIZE: Record<SolanaAnalyticsBudgetKey, number> = {
  '5m': 500,
  '15m': 750,
  '1h': 3000,
  '6h': 3000,
}
const SOLANA_ANALYTICS_FAST_CHUNK_SIZE: Record<SolanaAnalyticsBudgetKey, number> = {
  '5m': 500,
  '15m': 750,
  '1h': 1500,
  '6h': 2000,
}

type SolanaAnalyticsBudgetKey = '5m' | '15m' | '1h' | '6h'

type SolanaAnalyticsCursorRequest = {
  timeframe: string
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

function selectSolanaAnalyticsBudgetKey(timeframe: string): SolanaAnalyticsBudgetKey {
  const seconds = parseTimeframeToSeconds(timeframe)
  if (seconds <= 300) return '5m'
  if (seconds <= 900) return '15m'
  if (seconds <= 3600) return '1h'
  return '6h'
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

type PendingAnalyticsResult = {
  work: SharedPortalWork<FreshAnalyticsResult>
}

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
      ...(response.top_programs?.status === 'unavailable' ? { top_programs: response.top_programs } : {}),
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

function decorateSolanaAnalyticsPresentation(response: Record<string, any>) {
  const programRows = Array.isArray(response.top_programs?.programs)
    ? response.top_programs.programs
    : response.top_program
      ? [response.top_program]
      : []
  const tables =
    programRows.length > 0
      ? [
          buildTableDescriptor({
            id: 'top_programs',
            dataKey: 'top_programs.programs',
            rowCount: programRows.length,
            title: 'Top Solana programs',
            subtitle: 'Programs ranked by observed instruction count in the analyzed slots',
            keyField: 'program_id',
            defaultSort: { key: 'rank', direction: 'asc' },
            dense: true,
            columns: [
              { key: 'rank', label: 'Rank', kind: 'rank', format: 'integer', align: 'right' },
              { key: 'program_name', label: 'Program', kind: 'dimension' },
              { key: 'program_id', label: 'Program ID', kind: 'dimension', format: 'address' },
              { key: 'instruction_count', label: 'Instructions', kind: 'metric', format: 'integer', align: 'right' },
              { key: 'share', label: 'Share', kind: 'metric', align: 'right' },
              {
                key: 'avg_compute_units',
                label: 'Avg compute',
                kind: 'metric',
                format: 'integer',
                unit: 'compute units',
                align: 'right',
              },
            ],
          }),
        ]
      : []
  const overview = response.overview ?? {}
  const summary = {
    tps: response.throughput?.tps ?? overview.tps,
    total_transactions: response.throughput?.total_transactions ?? overview.total_transactions,
    total_fees_sol: response.fees?.total_fees_sol ?? overview.total_fees_sol,
    success_rate: response.activity?.success_rate ?? overview.success_rate,
    slots_analyzed: response.network?.slots_analyzed ?? overview.slots_analyzed,
  }
  const normalizedResponse = {
    ...response,
    presentation_summary: summary,
    ...(response.top_program && !response.top_programs
      ? { top_programs: { programs: programRows, total_programs: programRows.length, has_more: false } }
      : {}),
    ...(tables.length > 0 ? { tables } : {}),
  }

  return {
    response: normalizedResponse,
    ui: buildPortalUi({
      version: 'portal_ui_v1',
      layout: 'dashboard',
      density: 'compact',
      design_intent: 'analytics_dashboard',
      headline: { title: 'Solana network analytics' },
      metric_cards: [
        buildMetricCard({
          id: 'tps',
          label: 'TPS',
          value_path: 'presentation_summary.tps',
          format: 'decimal',
          emphasis: 'primary',
        }),
        buildMetricCard({
          id: 'fees',
          label: 'Fees',
          value_path: 'presentation_summary.total_fees_sol',
          format: 'decimal',
          unit: 'SOL',
        }),
        buildMetricCard({
          id: 'success',
          label: 'Success rate',
          value_path: 'presentation_summary.success_rate',
          format: 'percent',
        }),
      ],
      panels: [
        ...(programRows.length > 0
          ? [
              buildRankedBarsPanel({
                id: 'program-bars',
                kind: 'ranked_bars_panel',
                title: 'Top programs',
                subtitle: 'Programs ranked by observed instruction count.',
                data_key: 'top_programs.programs',
                category_key: 'program_name',
                value_key: 'instruction_count',
                rank_key: 'rank',
                value_format: 'integer',
                emphasis: 'primary',
              }),
              buildTablePanel({
                id: 'program-table-panel',
                kind: 'table_panel',
                title: 'Program evidence',
                subtitle: 'Exact program IDs and observed counts.',
                table_id: 'top_programs',
              }),
            ]
          : []),
      ],
      ...(programRows.length > 0
        ? {
            follow_up_actions: [
              { label: 'Show ranked program rows', intent: 'show_raw' as const, target: 'top_programs.programs' },
            ],
          }
        : {}),
    }),
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
  recoveryBudget: StreamRecoveryBudget,
  onRecord: (record: unknown) => void | Promise<void>,
): Promise<number> {
  try {
    return await portalFetchStreamRangeVisit(url, buildQuery(from, to), {
      maxBytes: 150 * 1024 * 1024,
      onRecord,
    })
  } catch (err) {
    const recovery = getStreamRangeRecovery(err, from, to, { budget: recoveryBudget, allowTimeout: true })
    if (recovery && (recovery.fromBlock > from || to - from + 1 > minChunkSize)) {
      const nextFrom = recovery.fromBlock
      if (nextFrom > to) return recovery.deliveredRecords
      const mid = nextFrom + Math.floor((to - nextFrom) / 2)
      const left = await visitAdaptiveSolanaRange(
        url,
        buildQuery,
        nextFrom,
        mid,
        minChunkSize,
        recoveryBudget,
        onRecord,
      )
      const right =
        mid < to
          ? await visitAdaptiveSolanaRange(url, buildQuery, mid + 1, to, minChunkSize, recoveryBudget, onRecord)
          : 0
      return recovery.deliveredRecords + left + right
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
  registerPortalTool(
    server,
    'portal_solana_get_analytics',
    buildToolDescription('portal_solana_get_analytics'),
    {
      network: z.string().default('solana-mainnet').describe('Network name (default: solana-mainnet)'),
      timeframe: z
        .string()
        .optional()
        .describe(
          "Time range. Accepts compact durations like '15m' or natural phrases like 'past 30 minutes'. Optional; defaults to a 1h analysis window.",
        ),
      mode: z
        .enum(['fast', 'deep'])
        .optional()
        .default('deep')
        .describe(
          'Execution depth. Defaults to complete requested-window analysis; the optional fast value is only for explicitly bounded previews.',
        ),
      from_timestamp: z
        .union([z.string(), z.number()])
        .optional()
        .describe(
          'Starting timestamp. Accepts Unix seconds, Unix milliseconds, ISO datetime, or relative input like "1h ago".',
        ),
      to_timestamp: z
        .union([z.string(), z.number()])
        .optional()
        .describe(
          'Ending timestamp. Accepts Unix seconds, Unix milliseconds, ISO datetime, or relative input like "now".',
        ),
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
        .describe(
          "Response format: 'summary' (high-level metrics), 'compact' (core sections), 'full' (complete analytics).",
        ),
      cursor: z.string().optional().describe('Continuation cursor for paginating top_programs'),
    },
    async ({
      network,
      timeframe,
      mode,
      from_timestamp,
      to_timestamp,
      include_compute_units,
      include_programs,
      program_limit,
      response_format,
      cursor,
    }) => {
      const queryStartTime = Date.now()
      const paginationCursor = cursor
        ? decodeOffsetPageCursor<SolanaAnalyticsCursorRequest>(cursor, 'portal_solana_get_analytics')
        : undefined
      const requestedDataset = network ? await resolveDataset(network) : undefined
      let dataset = paginationCursor?.dataset ?? requestedDataset ?? 'solana-mainnet'
      if (paginationCursor && requestedDataset && paginationCursor.dataset !== requestedDataset) {
        throw new ActionableError(
          'This cursor belongs to a different dataset.',
          [
            'Reuse the cursor with the same dataset as the previous response.',
            'Omit cursor to start a fresh Solana analytics snapshot.',
          ],
          {
            cursor_dataset: paginationCursor.dataset,
            requested_dataset: requestedDataset,
          },
        )
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
      const requestedTimeframe = timeframe ?? (mode === 'deep' ? '1h' : '5m')
      const analyticsBudgetKey = selectSolanaAnalyticsBudgetKey(requestedTimeframe)
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
      const maxSlotsForTimeframe =
        mode === 'deep'
          ? SOLANA_ANALYTICS_SLOT_BUDGET[analyticsBudgetKey]
          : SOLANA_ANALYTICS_FAST_SLOT_BUDGET[analyticsBudgetKey]
      const slotsAnalyzed = Math.min(requestedSlots, maxSlotsForTimeframe, MAX_ANALYTICS_SLOTS)
      const effectiveFrom = requestedSlots > slotsAnalyzed ? endBlock - slotsAnalyzed + 1 : fromBlock
      const cacheKey = `${dataset}:${fromBlock}:${endBlock}:${mode}:${requestedTimeframe}:${String(from_timestamp ?? '')}:${String(to_timestamp ?? '')}:${include_compute_units}:${include_programs}:${response_format}:${program_limit}`
      const cached = !cursor && !include_programs ? getCachedAnalyticsResult(cacheKey) : undefined

      if (cached) {
        const response = JSON.parse(JSON.stringify(cached.response)) as Record<string, any>
        response._cache = {
          hit: true,
          age_ms: Date.now() - cached.cachedAt,
        }

        const presentation = decorateSolanaAnalyticsPresentation(
          formatSolanaAnalyticsResponse(response, response_format as ResponseFormat),
        )
        return formatResult(
          presentation.response,
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
            ui: presentation.ui,
            llm: {
              compact: true,
              primary_path: response.top_programs?.programs?.length ? 'top_programs.programs' : 'presentation_summary',
              answer_sequence: [
                'presentation_summary',
                'network',
                'throughput',
                'fees',
                'activity',
                'top_programs.programs',
              ],
              parser_notes: [
                'Fee totals are exact decimal strings; ranked program rows appear only when include_programs is requested.',
              ],
            },
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
        let totalFees = 0n
        let errorCount = 0
        let totalComputeUnits = 0
        let computeUnitsSampleTxs = 0
        let chunksFetched = 0
        const feeSamples: number[] = []
        const computeUnitSamples: number[] = []

        const recoveryBudget = new StreamRecoveryBudget()
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

        const analyticsChunkSize =
          (mode === 'deep'
            ? SOLANA_ANALYTICS_CHUNK_SIZE[analyticsBudgetKey]
            : SOLANA_ANALYTICS_FAST_CHUNK_SIZE[analyticsBudgetKey]) || INITIAL_SOLANA_ANALYTICS_CHUNK_SIZE
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
                recoveryBudget,
                (record) => {
                  const typedBlock = record as { transactions?: Record<string, unknown>[] }
                  const txs = typedBlock.transactions || []
                  totalTxs += txs.length

                  for (let index = 0; index < txs.length; index += 1) {
                    const tx = txs[index]
                    if (typeof tx.feePayer === 'string') feePayers.add(hashString53(tx.feePayer))
                    const feeText = String(tx.fee ?? '0')
                    const fee = /^\d+$/.test(feeText) ? BigInt(feeText) : 0n
                    totalFees += fee
                    const feeNumber = Number(fee)
                    if (Number.isSafeInteger(feeNumber)) feeSamples.push(feeNumber)
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
        const avgSlotTime = slotsAnalyzed > 1 && timeSpanSeconds > 0 ? timeSpanSeconds / (slotsAnalyzed - 1) : 0.4
        const avgTxsPerSlot = slotsAnalyzed > 0 ? totalTxs / slotsAnalyzed : 0
        const tps = avgSlotTime > 0 ? avgTxsPerSlot / avgSlotTime : 0
        const avgFee = totalTxs > 0 ? Number(totalFees) / totalTxs : 0
        const avgFeeExact =
          totalTxs > 0
            ? (divideExactDecimals({ coefficient: totalFees, scale: 0 }, { coefficient: BigInt(totalTxs), scale: 0 }, 9)
                .value ?? '0')
            : '0'
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
            total_fees_lamports: totalFees.toString(),
            total_fees_sol: formatIntegerUnitsExact(totalFees, 9),
            total_fees_formatted: formatIntegerUnitsExact(totalFees, 9) + ' SOL',
            avg_fee_lamports: avgFeeExact,
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
          const programSlots = Math.min(slotsAnalyzed, analyticsBudgetKey === '5m' ? 150 : 250)
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
              const samples = await Promise.all(
                rangeBatch.map(async (range) => {
                  const counts = new Map<string, { calls: number; computeUnits: number }>()
                  let instructions = 0
                  let slots = 0
                  await visitAdaptiveSolanaRange(
                    programUrl,
                    instructionQueryForRange,
                    range.from,
                    range.to,
                    MIN_SOLANA_PROGRAM_CHUNK_SIZE,
                    recoveryBudget,
                    (record) => {
                      const block = record as {
                        instructions?: Array<{ programId?: string; computeUnitsConsumed?: number | string }>
                      }
                      slots++
                      for (const instr of block.instructions || []) {
                        instructions++
                        const pid = instr.programId || 'unknown'
                        const existing = counts.get(pid) || { calls: 0, computeUnits: 0 }
                        existing.calls++
                        existing.computeUnits += Number(instr.computeUnitsConsumed) || 0
                        counts.set(pid, existing)
                      }
                    },
                  )
                  return { counts, instructions, slots }
                }),
              )
              for (const sample of samples) {
                totalInstructions += sample.instructions
                programSlotsAnalyzed += sample.slots
                for (const [pid, count] of sample.counts) {
                  const existing = programCounts.get(pid) || { calls: 0, computeUnits: 0 }
                  existing.calls += count.calls
                  existing.computeUnits += count.computeUnits
                  programCounts.set(pid, existing)
                }
              }
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
          } catch (error) {
            if (error instanceof RequestCancelledError) throw error
            response.top_programs = { status: 'unavailable', error: 'Failed to fetch instruction data' }
          }
        }

        const notices =
          requestedSlots > slotsAnalyzed
            ? [
                `Analyzed ${slotsAnalyzed} of ${requestedSlots} requested slots because the requested window exceeds the current Solana analytics scan budget.`,
              ]
            : mode === 'fast' && !timeframe
              ? ['Bounded preview requests default to a 5-minute Solana window.']
              : []
        if (response.top_programs?.status === 'unavailable') {
          notices.push(
            'Top-program results are unavailable because the instruction sample could not be completed. Partial instruction counts were discarded.',
          )
        }
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

      const canDedupe = !cursor && !include_programs
      const requestSignal = getPortalRequestSignal()
      const pendingEntry = canDedupe ? pendingAnalyticsResults.get(cacheKey) : undefined
      let freshAnalytics: FreshAnalyticsResult
      if (canDedupe) {
        const analyticsWork = pendingEntry?.work ?? runAsSharedPortalWork(loadFreshAnalytics)
        if (!pendingEntry) {
          pendingAnalyticsResults.set(cacheKey, { work: analyticsWork })
          const clearPending = () => {
            if (pendingAnalyticsResults.get(cacheKey)?.work === analyticsWork) {
              pendingAnalyticsResults.delete(cacheKey)
            }
          }
          analyticsWork.promise.then(clearPending, clearPending)
        }
        freshAnalytics = await waitForSharedPortalWork(analyticsWork, requestSignal)
      } else {
        freshAnalytics = await loadFreshAnalytics()
      }

      const presentation = decorateSolanaAnalyticsPresentation(freshAnalytics.formattedResponse)
      return formatResult(
        presentation.response,
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
              include_compute_units
                ? 'Compute-unit sampling was enabled.'
                : 'Compute-unit sampling stayed lightweight.',
            ],
          }),
          ui: presentation.ui,
          llm: {
            compact: true,
            primary_path: freshAnalytics.response.top_programs?.programs?.length
              ? 'top_programs.programs'
              : 'presentation_summary',
            answer_sequence: [
              'presentation_summary',
              'network',
              'throughput',
              'fees',
              'activity',
              'top_programs.programs',
            ],
            parser_notes: [
              'Fee totals are exact decimal strings; ranked program rows appear only when include_programs is requested.',
            ],
          },
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
