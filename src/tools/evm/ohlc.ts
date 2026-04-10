import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { resolveDataset, validateBlockRange } from '../../cache/datasets.js'
import { EVENT_SIGNATURES, PORTAL_URL } from '../../constants/index.js'
import { buildCandlestickChart, buildOhlcTable } from '../../helpers/chart-metadata.js'
import { detectChainType } from '../../helpers/chain.js'
import { getKnownTokenDecimals } from '../../helpers/conversions.js'
import { createUnsupportedChainError } from '../../helpers/errors.js'
import { portalFetchStreamRangeVisit } from '../../helpers/fetch.js'
import { buildEvmLogFields } from '../../helpers/fields.js'
import { formatResult } from '../../helpers/format.js'
import { formatTimestamp } from '../../helpers/formatting.js'
import { buildBucketCoverage, buildBucketGapDiagnostics, buildChronologicalPageOrdering, buildQueryFreshness } from '../../helpers/result-metadata.js'
import { buildPaginationInfo, decodeCursor, encodeCursor } from '../../helpers/pagination.js'
import { estimateBlockTime, parseTimeframeToSeconds, resolveTimeframeOrBlocks } from '../../helpers/timeframe.js'
import { buildExecutionMetadata, buildToolDescription } from '../../helpers/tool-ux.js'
import { normalizeEvmAddress } from '../../helpers/validation.js'

type OhlcDuration = '1h' | '6h' | '12h' | '24h' | '7d' | '30d'
type OhlcInterval = '1m' | '5m' | '15m' | '30m' | '1h' | '4h' | '6h' | '1d'
type OhlcIntervalInput = OhlcInterval | 'auto'
type EvmOhlcSource = 'uniswap_v3_swap' | 'uniswap_v2_sync'
type BaseTokenSide = 'token0' | 'token1'

type EvmOhlcCursor = {
  tool: 'portal_evm_get_ohlc'
  dataset: string
  request: {
    pool_address: string
    source: EvmOhlcSource
    interval: OhlcIntervalInput
    duration: OhlcDuration
    base_token: BaseTokenSide
    token0_symbol?: string
    token1_symbol?: string
    token0_decimals?: number
    token1_decimals?: number
    token0_address?: string
    token1_address?: string
  }
  window_start_timestamp: number
  window_end_exclusive: number
}

type CandleAccumulator = {
  open: number | null
  high: number | null
  low: number | null
  close: number | null
  base_volume: number
  quote_volume: number
  sample_count: number
}

type EvmLogRecord = {
  address?: string
  topics?: string[]
  data?: string
  transactionHash?: string
  logIndex?: number
}

const AUTO_INTERVAL_BY_DURATION: Record<OhlcDuration, OhlcInterval> = {
  '1h': '5m',
  '6h': '15m',
  '12h': '30m',
  '24h': '1h',
  '7d': '6h',
  '30d': '1d',
}

const INITIAL_LOG_CHUNK_SIZE = 5_000
const MIN_LOG_CHUNK_SIZE = 250
const EVM_OHLC_MAX_BYTES = 100 * 1024 * 1024

function resolveInterval(duration: OhlcDuration, requestedInterval: OhlcIntervalInput): OhlcInterval {
  if (requestedInterval === 'auto') return AUTO_INTERVAL_BY_DURATION[duration]
  return requestedInterval
}

function getOrCreateBucket(buckets: Map<number, CandleAccumulator>, timestamp: number): CandleAccumulator {
  let bucket = buckets.get(timestamp)
  if (!bucket) {
    bucket = {
      open: null,
      high: null,
      low: null,
      close: null,
      base_volume: 0,
      quote_volume: 0,
      sample_count: 0,
    }
    buckets.set(timestamp, bucket)
  }
  return bucket
}

function sortLogs(logs: EvmLogRecord[]): EvmLogRecord[] {
  return logs.slice().sort((left, right) => (left.logIndex ?? 0) - (right.logIndex ?? 0))
}

function splitDataWords(data: string | undefined): string[] {
  if (!data || data === '0x') return []
  const clean = data.startsWith('0x') ? data.slice(2) : data
  return clean.match(/.{64}/g) || []
}

function decodeUnsignedWord(word: string | undefined): bigint | undefined {
  if (!word) return undefined
  try {
    return BigInt(`0x${word}`)
  } catch {
    return undefined
  }
}

function decodeSignedWord(word: string | undefined): bigint | undefined {
  const unsigned = decodeUnsignedWord(word)
  if (unsigned === undefined) return undefined
  const signBit = 1n << 255n
  const max = 1n << 256n
  return unsigned >= signBit ? unsigned - max : unsigned
}

function toScaledNumber(value: bigint, decimals?: number): number {
  const divisor = decimals !== undefined ? 10 ** decimals : 1
  return Number(value) / divisor
}

function getPriceFromV3SqrtPrice(
  sqrtPriceX96: bigint,
  baseToken: BaseTokenSide,
  token0Decimals?: number,
  token1Decimals?: number,
): number | undefined {
  const sqrtRatio = Number(sqrtPriceX96) / 2 ** 96
  if (!Number.isFinite(sqrtRatio) || sqrtRatio <= 0) return undefined

  const rawToken1PerToken0 = sqrtRatio * sqrtRatio
  const adjustedToken1PerToken0 =
    token0Decimals !== undefined && token1Decimals !== undefined
      ? rawToken1PerToken0 * 10 ** (token0Decimals - token1Decimals)
      : rawToken1PerToken0

  const price = baseToken === 'token0' ? adjustedToken1PerToken0 : 1 / adjustedToken1PerToken0
  return Number.isFinite(price) && price > 0 ? price : undefined
}

function getPriceFromV2Reserves(
  reserve0: bigint,
  reserve1: bigint,
  baseToken: BaseTokenSide,
  token0Decimals?: number,
  token1Decimals?: number,
): number | undefined {
  if (reserve0 <= 0n || reserve1 <= 0n) return undefined

  const token0 = token0Decimals !== undefined ? Number(reserve0) / 10 ** token0Decimals : Number(reserve0)
  const token1 = token1Decimals !== undefined ? Number(reserve1) / 10 ** token1Decimals : Number(reserve1)
  if (!Number.isFinite(token0) || !Number.isFinite(token1) || token0 <= 0 || token1 <= 0) return undefined

  const price = baseToken === 'token0' ? token1 / token0 : token0 / token1
  return Number.isFinite(price) && price > 0 ? price : undefined
}

function decodePriceSample(params: {
  source: EvmOhlcSource
  log: EvmLogRecord
  baseToken: BaseTokenSide
  token0Decimals?: number
  token1Decimals?: number
}): { price: number; baseVolume: number; quoteVolume: number } | undefined {
  const words = splitDataWords(params.log.data)

  if (params.source === 'uniswap_v3_swap') {
    const amount0 = decodeSignedWord(words[0])
    const amount1 = decodeSignedWord(words[1])
    const sqrtPriceX96 = decodeUnsignedWord(words[2])
    if (amount0 === undefined || amount1 === undefined || sqrtPriceX96 === undefined) return undefined

    const price = getPriceFromV3SqrtPrice(sqrtPriceX96, params.baseToken, params.token0Decimals, params.token1Decimals)
    if (price === undefined) return undefined

    const baseRaw = params.baseToken === 'token0' ? (amount0 < 0n ? -amount0 : amount0) : (amount1 < 0n ? -amount1 : amount1)
    const quoteRaw = params.baseToken === 'token0' ? (amount1 < 0n ? -amount1 : amount1) : (amount0 < 0n ? -amount0 : amount0)
    const baseDecimals = params.baseToken === 'token0' ? params.token0Decimals : params.token1Decimals
    const quoteDecimals = params.baseToken === 'token0' ? params.token1Decimals : params.token0Decimals

    return {
      price,
      baseVolume: toScaledNumber(baseRaw, baseDecimals),
      quoteVolume: toScaledNumber(quoteRaw, quoteDecimals),
    }
  }

  const reserve0 = decodeUnsignedWord(words[0])
  const reserve1 = decodeUnsignedWord(words[1])
  if (reserve0 === undefined || reserve1 === undefined) return undefined

  const price = getPriceFromV2Reserves(reserve0, reserve1, params.baseToken, params.token0Decimals, params.token1Decimals)
  if (price === undefined) return undefined

  return {
    price,
    baseVolume: 0,
    quoteVolume: 0,
  }
}

async function visitAdaptiveEvmLogRange(
  dataset: string,
  body: Record<string, unknown>,
  rangeFrom: number,
  rangeTo: number,
  onRecord: (record: unknown) => void | Promise<void>,
): Promise<number> {
  try {
    return await portalFetchStreamRangeVisit(
      `${PORTAL_URL}/datasets/${dataset}/stream`,
      {
        ...body,
        fromBlock: rangeFrom,
        toBlock: rangeTo,
      },
      {
        maxBytes: EVM_OHLC_MAX_BYTES,
        onRecord,
      },
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes('Response too large') && rangeTo > rangeFrom && rangeTo - rangeFrom + 1 > MIN_LOG_CHUNK_SIZE) {
      const mid = rangeFrom + Math.floor((rangeTo - rangeFrom) / 2)
      const [left, right] = await Promise.all([
        visitAdaptiveEvmLogRange(dataset, body, rangeFrom, mid, onRecord),
        visitAdaptiveEvmLogRange(dataset, body, mid + 1, rangeTo, onRecord),
      ])
      return left + right
    }

    throw error
  }
}

export function registerEvmOhlcTool(server: McpServer) {
  server.tool(
    'portal_evm_get_ohlc',
    buildToolDescription('portal_evm_get_ohlc'),
    {
      network: z.string().optional().default('base-mainnet').describe('EVM network name (default: base-mainnet)'),
      pool_address: z.string().optional().describe('Pool/pair contract address. Optional when continuing with cursor.'),
      source: z.enum(['uniswap_v3_swap', 'uniswap_v2_sync']).optional().default('uniswap_v3_swap').describe('Which event source to build candles from'),
      interval: z
        .enum(['auto', '1m', '5m', '15m', '30m', '1h', '4h', '6h', '1d'])
        .optional()
        .default('auto')
        .describe('Candle interval. auto uses chart-friendly defaults like 1h→5m and 24h→1h.'),
      duration: z
        .enum(['1h', '6h', '12h', '24h', '7d', '30d'])
        .optional()
        .default('1h')
        .describe('How much recent history to cover'),
      base_token: z.enum(['token0', 'token1']).optional().default('token0').describe('Express price as quote-per-base for token0 or token1'),
      token0_symbol: z.string().optional().describe('Optional token0 symbol label for summaries'),
      token1_symbol: z.string().optional().describe('Optional token1 symbol label for summaries'),
      token0_decimals: z.number().optional().describe('Optional token0 decimals for human-readable prices'),
      token1_decimals: z.number().optional().describe('Optional token1 decimals for human-readable prices'),
      token0_address: z.string().optional().describe('Optional token0 address to infer known decimals'),
      token1_address: z.string().optional().describe('Optional token1 address to infer known decimals'),
      cursor: z.string().optional().describe('Continuation cursor from a previous candle page'),
    },
    async ({
      network,
      pool_address,
      source,
      interval,
      duration,
      base_token,
      token0_symbol,
      token1_symbol,
      token0_decimals,
      token1_decimals,
      token0_address,
      token1_address,
      cursor,
    }) => {
      const queryStartTime = Date.now()
      const paginationCursor = cursor ? decodeCursor<EvmOhlcCursor>(cursor, 'portal_evm_get_ohlc') : undefined
      const requestedDataset = cursor ? (network ? await resolveDataset(network) : undefined) : await resolveDataset(network)
      let dataset = paginationCursor?.dataset ?? requestedDataset ?? 'base-mainnet'

      if (paginationCursor && requestedDataset && requestedDataset !== paginationCursor.dataset) {
        throw new Error('This cursor belongs to a different network. Reuse the same network or omit cursor to start a fresh candle window.')
      }

      pool_address = paginationCursor?.request.pool_address ?? pool_address
      source = paginationCursor?.request.source ?? source
      interval = paginationCursor?.request.interval ?? interval
      duration = paginationCursor?.request.duration ?? duration
      base_token = paginationCursor?.request.base_token ?? base_token
      token0_symbol = paginationCursor?.request.token0_symbol ?? token0_symbol
      token1_symbol = paginationCursor?.request.token1_symbol ?? token1_symbol
      token0_decimals = paginationCursor?.request.token0_decimals ?? token0_decimals
      token1_decimals = paginationCursor?.request.token1_decimals ?? token1_decimals
      token0_address = paginationCursor?.request.token0_address ?? token0_address
      token1_address = paginationCursor?.request.token1_address ?? token1_address

      if (!pool_address) {
        throw new Error('pool_address is required unless you are continuing with cursor')
      }

      const chainType = detectChainType(dataset)
      if (chainType !== 'evm') {
        throw createUnsupportedChainError({
          toolName: 'portal_evm_get_ohlc',
          dataset,
          actualChainType: chainType,
          supportedChains: ['evm'],
          suggestions: [
            'Use portal_hyperliquid_get_ohlc for Hyperliquid trade candles.',
            'Use portal_get_time_series for generic Solana or Bitcoin charting.',
          ],
        })
      }

      const normalizedPoolAddress = normalizeEvmAddress(pool_address)
      const normalizedToken0Address = token0_address ? normalizeEvmAddress(token0_address) : undefined
      const normalizedToken1Address = token1_address ? normalizeEvmAddress(token1_address) : undefined
      const resolvedToken0Decimals = token0_decimals ?? (normalizedToken0Address ? getKnownTokenDecimals(normalizedToken0Address) : undefined)
      const resolvedToken1Decimals = token1_decimals ?? (normalizedToken1Address ? getKnownTokenDecimals(normalizedToken1Address) : undefined)

      const resolvedInterval = resolveInterval(duration as OhlcDuration, interval as OhlcIntervalInput)
      const intervalSeconds = parseTimeframeToSeconds(resolvedInterval)
      const durationSeconds = parseTimeframeToSeconds(duration)
      const expectedBuckets = Math.max(1, Math.ceil(durationSeconds / intervalSeconds))
      const buckets = new Map<number, CandleAccumulator>()
      let latestTimestamp = 0
      let earliestObservedTimestamp = Number.MAX_SAFE_INTEGER
      let earliestObservedBelowPageEnd = Number.MAX_SAFE_INTEGER
      let earliestObservedBlock = Number.MAX_SAFE_INTEGER
      let totalSamples = 0
      let totalBaseVolume = 0
      let totalQuoteVolume = 0
      let chunksFetched = 0
      let scannedFromBlock = 0
      let seriesStartTimestamp = 0
      let seriesEndExclusive = 0
      let resolvedWindow
      let endBlock = 0
      let head

      const logBody = {
        type: 'evm',
        fields: {
          block: {
            number: true,
            timestamp: true,
          },
          log: buildEvmLogFields(),
        },
        logs: [
          {
            address: [normalizedPoolAddress],
            topic0: [source === 'uniswap_v3_swap' ? EVENT_SIGNATURES.UNISWAP_V3_SWAP : EVENT_SIGNATURES.SYNC],
          },
        ],
      }

      const accumulateRange = async (rangeFrom: number, rangeTo: number, options?: { pageStartTimestamp?: number; pageEndExclusive?: number }) => {
        const rangeProcessed = await visitAdaptiveEvmLogRange(dataset, logBody, rangeFrom, rangeTo, async (record) => {
          const block = record as {
            number?: number
            timestamp?: number
            header?: { number?: number; timestamp?: number }
            logs?: EvmLogRecord[]
          }
          const blockNumber = block.number ?? block.header?.number
          const timestamp = block.timestamp ?? block.header?.timestamp
          if (typeof timestamp !== 'number' || timestamp <= 0) return

          for (const log of sortLogs(block.logs || [])) {
            if (options?.pageEndExclusive !== undefined && timestamp >= options.pageEndExclusive) continue

            earliestObservedBelowPageEnd = Math.min(earliestObservedBelowPageEnd, timestamp)
            if (typeof blockNumber === 'number') {
              earliestObservedBlock = Math.min(earliestObservedBlock, blockNumber)
            }

            if (options?.pageStartTimestamp !== undefined && timestamp < options.pageStartTimestamp) continue

            const sample = decodePriceSample({
              source: source as EvmOhlcSource,
              log,
              baseToken: base_token as BaseTokenSide,
              token0Decimals: resolvedToken0Decimals,
              token1Decimals: resolvedToken1Decimals,
            })
            if (!sample) continue

            latestTimestamp = Math.max(latestTimestamp, timestamp)
            earliestObservedTimestamp = Math.min(earliestObservedTimestamp, timestamp)
            totalSamples += 1

            const bucketTimestamp = Math.floor(timestamp / intervalSeconds) * intervalSeconds
            const bucket = getOrCreateBucket(buckets, bucketTimestamp)
            if (bucket.open === null) bucket.open = sample.price
            bucket.high = bucket.high === null ? sample.price : Math.max(bucket.high, sample.price)
            bucket.low = bucket.low === null ? sample.price : Math.min(bucket.low, sample.price)
            bucket.close = sample.price
            bucket.base_volume += sample.baseVolume
            bucket.quote_volume += sample.quoteVolume
            bucket.sample_count += 1

            totalBaseVolume += sample.baseVolume
            totalQuoteVolume += sample.quoteVolume
          }
        })

        if (rangeProcessed > 0) chunksFetched += 1
      }

      if (paginationCursor) {
        seriesStartTimestamp = paginationCursor.window_start_timestamp
        seriesEndExclusive = paginationCursor.window_end_exclusive
        resolvedWindow = await resolveTimeframeOrBlocks({
          dataset,
          from_timestamp: seriesStartTimestamp,
          to_timestamp: Math.max(0, seriesEndExclusive - 1),
        })

        const estimatedBlocksPerSecond = 1 / estimateBlockTime(dataset, 'evm')
        const cushionBlocks = Math.max(2_000, Math.ceil(durationSeconds * estimatedBlocksPerSecond * 0.2))
        const rangeFrom = Math.max(0, resolvedWindow.from_block - cushionBlocks)
        const rangeTo = resolvedWindow.to_block + cushionBlocks
        const validated = await validateBlockRange(dataset, rangeFrom, rangeTo ?? Number.MAX_SAFE_INTEGER, false)
        head = validated.head
        endBlock = validated.validatedToBlock
        scannedFromBlock = rangeFrom

        await accumulateRange(rangeFrom, endBlock, {
          pageStartTimestamp: seriesStartTimestamp,
          pageEndExclusive: seriesEndExclusive,
        })
      } else {
        resolvedWindow = await resolveTimeframeOrBlocks({
          dataset,
          timeframe: duration,
        })
        const validated = await validateBlockRange(
          dataset,
          resolvedWindow.from_block,
          resolvedWindow.to_block ?? Number.MAX_SAFE_INTEGER,
          false,
        )
        head = validated.head
        endBlock = validated.validatedToBlock
        scannedFromBlock = resolvedWindow.from_block
        await accumulateRange(scannedFromBlock, endBlock)
      }

      if (latestTimestamp === 0 || totalSamples === 0) {
        throw new Error(`No ${source} events found for pool ${normalizedPoolAddress} in the requested window`)
      }

      if (!paginationCursor) {
        seriesEndExclusive = Math.floor(latestTimestamp / intervalSeconds) * intervalSeconds + intervalSeconds
        seriesStartTimestamp = seriesEndExclusive - durationSeconds
      }

      let backfillAttempts = 0
      while (earliestObservedBelowPageEnd > seriesStartTimestamp && scannedFromBlock > 0 && backfillAttempts < 8) {
        const observedSeconds = Math.max(1, Math.max(latestTimestamp, seriesEndExclusive - intervalSeconds) - earliestObservedBelowPageEnd)
        const observedBlocks = Math.max(1, endBlock - earliestObservedBlock + 1)
        const missingSeconds = earliestObservedBelowPageEnd - seriesStartTimestamp
        const estimatedBlocksNeeded = Math.ceil((observedBlocks / observedSeconds) * missingSeconds * 2)
        const extensionSize = Math.max(INITIAL_LOG_CHUNK_SIZE, estimatedBlocksNeeded)
        const extensionFromBlock = Math.max(0, scannedFromBlock - extensionSize)

        if (extensionFromBlock >= scannedFromBlock) break

        await accumulateRange(extensionFromBlock, scannedFromBlock - 1, {
          ...(paginationCursor
            ? {
                pageStartTimestamp: seriesStartTimestamp,
                pageEndExclusive: seriesEndExclusive,
              }
            : {}),
        })
        scannedFromBlock = extensionFromBlock
        backfillAttempts += 1
      }

      const baseLabel = base_token === 'token0' ? (token0_symbol || 'token0') : (token1_symbol || 'token1')
      const quoteLabel = base_token === 'token0' ? (token1_symbol || 'token1') : (token0_symbol || 'token0')
      const priceScale = resolvedToken0Decimals !== undefined && resolvedToken1Decimals !== undefined ? 'adjusted' : 'raw_ratio'
      const volumePanel = source === 'uniswap_v3_swap'

      const ohlc = Array.from({ length: expectedBuckets }, (_, bucketIndex) => {
        const bucketTimestamp = seriesStartTimestamp + bucketIndex * intervalSeconds
        const bucket = buckets.get(bucketTimestamp)

        return {
          bucket_index: bucketIndex,
          timestamp: bucketTimestamp,
          timestamp_human: formatTimestamp(bucketTimestamp),
          open: bucket?.open === null || bucket?.open === undefined ? null : parseFloat(bucket.open.toFixed(8)),
          high: bucket?.high === null || bucket?.high === undefined ? null : parseFloat(bucket.high.toFixed(8)),
          low: bucket?.low === null || bucket?.low === undefined ? null : parseFloat(bucket.low.toFixed(8)),
          close: bucket?.close === null || bucket?.close === undefined ? null : parseFloat(bucket.close.toFixed(8)),
          base_volume: bucket ? parseFloat(bucket.base_volume.toFixed(6)) : 0,
          quote_volume: bucket ? parseFloat(bucket.quote_volume.toFixed(6)) : 0,
          sample_count: bucket?.sample_count ?? 0,
        }
      })

      const filledBuckets = ohlc.filter((bucket) => bucket.sample_count > 0).length
      const firstFilled = ohlc.find((bucket) => bucket.sample_count > 0)
      const lastFilled = [...ohlc].reverse().find((bucket) => bucket.sample_count > 0)
      const gapDiagnostics = buildBucketGapDiagnostics({
        buckets: ohlc,
        intervalSeconds,
        isFilled: (bucket) => bucket.sample_count > 0,
        anchor: 'latest_event',
        windowComplete: earliestObservedBelowPageEnd <= seriesStartTimestamp,
        ...(earliestObservedTimestamp !== Number.MAX_SAFE_INTEGER ? { firstObservedTimestamp: earliestObservedTimestamp } : {}),
        ...(latestTimestamp > 0 ? { lastObservedTimestamp: latestTimestamp } : {}),
      })
      const nextCursor =
        seriesStartTimestamp > 0
          ? encodeCursor({
              tool: 'portal_evm_get_ohlc',
              dataset,
              request: {
                pool_address: normalizedPoolAddress,
                source: source as EvmOhlcSource,
                interval: interval as OhlcIntervalInput,
                duration: duration as OhlcDuration,
                base_token: base_token as BaseTokenSide,
                ...(token0_symbol ? { token0_symbol } : {}),
                ...(token1_symbol ? { token1_symbol } : {}),
                ...(resolvedToken0Decimals !== undefined ? { token0_decimals: resolvedToken0Decimals } : {}),
                ...(resolvedToken1Decimals !== undefined ? { token1_decimals: resolvedToken1Decimals } : {}),
                ...(normalizedToken0Address ? { token0_address: normalizedToken0Address } : {}),
                ...(normalizedToken1Address ? { token1_address: normalizedToken1Address } : {}),
              },
              window_start_timestamp: Math.max(0, seriesStartTimestamp - durationSeconds),
              window_end_exclusive: seriesStartTimestamp,
            })
          : undefined

      const notices: string[] = []
      if (priceScale === 'raw_ratio') {
        notices.push('Prices use raw pool ratios because token decimals were not fully provided. Pass token0_decimals and token1_decimals for human-readable prices.')
      }
      if (nextCursor) {
        notices.push('Older candles are available via _pagination.next_cursor.')
      }

      const summary = {
        source,
        contract_address: normalizedPoolAddress,
        interval: resolvedInterval,
        interval_requested: interval,
        duration,
        base_token: baseLabel,
        quote_token: quoteLabel,
        base_token_side: base_token,
        price_unit: `${quoteLabel}/${baseLabel}${priceScale === 'raw_ratio' ? ' (raw ratio)' : ''}`,
        price_scale: priceScale,
        total_buckets: ohlc.length,
        filled_buckets: filledBuckets,
        empty_buckets: ohlc.length - filledBuckets,
        total_samples: totalSamples,
        total_base_volume: parseFloat(totalBaseVolume.toFixed(6)),
        total_quote_volume: parseFloat(totalQuoteVolume.toFixed(6)),
        from_block: scannedFromBlock,
        to_block: endBlock,
        latest_event_timestamp: latestTimestamp,
        latest_event_timestamp_human: formatTimestamp(latestTimestamp),
        window_start_timestamp: seriesStartTimestamp,
        window_start_timestamp_human: formatTimestamp(seriesStartTimestamp),
        window_end_exclusive: seriesEndExclusive,
        window_end_exclusive_human: formatTimestamp(Math.max(seriesStartTimestamp, seriesEndExclusive - 1)),
        ...(firstFilled ? { series_open: firstFilled.open } : {}),
        ...(lastFilled ? { series_close: lastFilled.close } : {}),
        ...(chunksFetched > 1 ? { chunks_fetched: chunksFetched } : {}),
        ...(backfillAttempts > 0 ? { backfill_attempts: backfillAttempts } : {}),
      }

      return formatResult(
        {
          summary,
          chart: buildCandlestickChart({
            dataKey: 'ohlc',
            interval: resolvedInterval,
            totalCandles: ohlc.length,
            title: `${baseLabel}/${quoteLabel} ${source} candles`,
            volumePanel,
            ...(volumePanel ? { volumeField: 'base_volume', volumeUnit: baseLabel } : {}),
            priceUnit: quoteLabel,
          }),
          tables: [
            buildOhlcTable({
              rowCount: ohlc.length,
              title: `${baseLabel}/${quoteLabel} candle table`,
              ...(volumePanel ? { volumeField: 'base_volume', volumeLabel: `${baseLabel} volume`, volumeUnit: baseLabel } : {}),
              priceUnit: quoteLabel,
            }),
          ],
          gap_diagnostics: gapDiagnostics,
          ohlc,
        },
        `Built ${resolvedInterval} ${baseLabel}/${quoteLabel} ${source} candles over ${duration}. ${filledBuckets}/${ohlc.length} buckets contain price updates.`,
        {
          toolName: 'portal_evm_get_ohlc',
          ...(notices.length > 0 ? { notices } : {}),
          pagination: buildPaginationInfo(expectedBuckets, ohlc.length, nextCursor),
          ordering: buildChronologicalPageOrdering({
            sortedBy: 'timestamp',
            continuation: nextCursor ? 'older' : 'none',
          }),
          freshness: buildQueryFreshness({
            finality: 'latest',
            headBlockNumber: head.number,
            windowToBlock: endBlock,
            resolvedWindow,
          }),
          execution: buildExecutionMetadata({
            interval: resolvedInterval,
            duration,
            from_block: scannedFromBlock,
            to_block: endBlock,
            range_kind: resolvedWindow.range_kind,
            notes: [`Price source: ${source}.`],
          }),
          coverage: buildBucketCoverage({
            expectedBuckets,
            returnedBuckets: ohlc.length,
            filledBuckets,
            anchor: 'latest_event',
            windowComplete: earliestObservedBelowPageEnd <= seriesStartTimestamp,
          }),
          metadata: {
            dataset,
            from_block: scannedFromBlock,
            to_block: endBlock,
            query_start_time: queryStartTime,
          },
        },
      )
    },
  )
}
