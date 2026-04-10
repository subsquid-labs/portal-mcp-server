import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { keccak_256 } from '@noble/hashes/sha3'
import { z } from 'zod'

import { resolveDataset, validateBlockRange } from '../../cache/datasets.js'
import { EVENT_SIGNATURES, PORTAL_URL } from '../../constants/index.js'
import {
  buildCandlestickChart,
  buildOhlcTable,
  type ChartTooltipDescriptor,
  type TableValueFormat,
} from '../../helpers/chart-metadata.js'
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
import { buildChartPanel, buildMetricCard, buildPortalUi, buildTablePanel } from '../../helpers/ui-metadata.js'
import { normalizeEvmAddress } from '../../helpers/validation.js'

type OhlcDuration = '1h' | '6h' | '12h' | '24h' | '7d' | '30d'
type OhlcInterval = '1m' | '5m' | '15m' | '30m' | '1h' | '4h' | '6h' | '1d'
type OhlcIntervalInput = OhlcInterval | 'auto'
type EvmOhlcSource =
  | 'uniswap_v3_swap'
  | 'uniswap_v4_swap'
  | 'aerodrome_slipstream_swap'
  | 'uniswap_v2_sync'
type BaseTokenSide = 'token0' | 'token1'

type EvmOhlcCursor = {
  tool: 'portal_evm_get_ohlc'
  dataset: string
  request: {
    pool_address?: string
    pool_id?: string
    pool_manager_address?: string
    source: EvmOhlcSource
    interval: OhlcIntervalInput
    duration: OhlcDuration
    base_token: BaseTokenSide
    currency0_address?: string
    currency1_address?: string
    fee?: number
    tick_spacing?: number
    hooks_address?: string
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

type OhlcRow = {
  bucket_index: number
  timestamp: number
  timestamp_human: string
  open: number | null
  high: number | null
  low: number | null
  close: number | null
  base_volume: number
  quote_volume: number
  sample_count: number
  direction: 'up' | 'down' | 'flat' | 'none'
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
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
const UNISWAP_V4_POOL_MANAGER_BY_DATASET: Record<string, string> = {
  'ethereum-mainnet': '0x000000000004444c5dc75cb358380d2e3de08a90',
  'optimism-mainnet': '0x9a13f98cb987694c9f086b1f5eb990eea8264ec3',
  'base-mainnet': '0x498581ff718922c3f8e6a244956af099b2652b2b',
  'arbitrum-one': '0x360e68faccca8ca495c1b759fd9eee466db9fb32',
}

function isConcentratedLiquiditySwapSource(source: EvmOhlcSource) {
  return source === 'uniswap_v3_swap' || source === 'uniswap_v4_swap' || source === 'aerodrome_slipstream_swap'
}

function isUniswapV4SwapSource(source: EvmOhlcSource) {
  return source === 'uniswap_v4_swap'
}

function isReserveSyncSource(source: EvmOhlcSource) {
  return source === 'uniswap_v2_sync'
}

function getSourceEventSignature(source: EvmOhlcSource) {
  if (source === 'uniswap_v4_swap') return EVENT_SIGNATURES.UNISWAP_V4_SWAP
  return isConcentratedLiquiditySwapSource(source) ? EVENT_SIGNATURES.UNISWAP_V3_SWAP : EVENT_SIGNATURES.SYNC
}

function getSourceFamily(source: EvmOhlcSource) {
  switch (source) {
    case 'uniswap_v3_swap':
      return 'uniswap_v3'
    case 'uniswap_v4_swap':
      return 'uniswap_v4'
    case 'aerodrome_slipstream_swap':
      return 'aerodrome_slipstream'
    case 'uniswap_v2_sync':
      return 'uniswap_v2_style_cpmm'
  }
}

function getPriceMethod(source: EvmOhlcSource) {
  return isConcentratedLiquiditySwapSource(source) ? 'sqrt_price_x96' : 'reserve_ratio'
}

function normalizePoolId(poolId: string): string {
  const normalized = poolId.toLowerCase()
  if (!/^0x[0-9a-f]{64}$/.test(normalized)) {
    throw new Error('pool_id must be a 32-byte hex string like 0xabc123... for uniswap_v4_swap')
  }
  return normalized
}

function compareHexAddresses(left: string, right: string) {
  return BigInt(left) < BigInt(right) ? -1 : BigInt(left) > BigInt(right) ? 1 : 0
}

function encodeUnsignedWordHex(value: bigint) {
  if (value < 0n) {
    throw new Error('Unsigned ABI values cannot be negative')
  }
  return value.toString(16).padStart(64, '0')
}

function encodeSignedWordHex(value: bigint, bitWidth: number) {
  const max = 1n << BigInt(bitWidth - 1)
  if (value < -max || value >= max) {
    throw new Error(`Signed ABI value ${value} exceeds int${bitWidth} bounds`)
  }
  const encoded = value < 0n ? (1n << 256n) + value : value
  return encoded.toString(16).padStart(64, '0')
}

function encodeAddressWordHex(address: string) {
  return address.toLowerCase().replace(/^0x/, '').padStart(64, '0')
}

function computeUniswapV4PoolId(params: {
  currency0_address: string
  currency1_address: string
  fee: number
  tick_spacing: number
  hooks_address: string
}) {
  const encodedPoolKey = [
    encodeAddressWordHex(params.currency0_address),
    encodeAddressWordHex(params.currency1_address),
    encodeUnsignedWordHex(BigInt(params.fee)),
    encodeSignedWordHex(BigInt(params.tick_spacing), 24),
    encodeAddressWordHex(params.hooks_address),
  ].join('')

  return `0x${Buffer.from(keccak_256(Buffer.from(encodedPoolKey, 'hex'))).toString('hex')}`
}

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

function formatPriceForOutput(value: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null
  const magnitude = Math.abs(value)
  if (magnitude === 0) return 0
  if (magnitude >= 1) return Number(value.toFixed(8))
  if (magnitude >= 0.0001) return Number(value.toFixed(12))
  return Number(value.toPrecision(8))
}

function inferPriceValueFormat(values: number[]): TableValueFormat {
  const nonZero = values.map((value) => Math.abs(value)).filter((value) => value > 0)
  if (nonZero.length === 0) return 'decimal'
  const median = nonZero.sort((left, right) => left - right)[Math.floor(nonZero.length / 2)]
  if (median >= 100_000) return 'compact_number'
  if (median < 0.0001) return 'scientific'
  return 'decimal'
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

  if (isConcentratedLiquiditySwapSource(params.source)) {
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
      pool_address: z.string().optional().describe('Pool/pair contract address for address-keyed sources like Uniswap v3, Slipstream, or Sync-derived CPMM pools.'),
      pool_id: z.string().optional().describe('Uniswap v4 pool id (bytes32). Optional when you provide the full v4 pool key instead.'),
      pool_manager_address: z
        .string()
        .optional()
        .describe('Uniswap v4 PoolManager address. Optional on networks with a built-in official Uniswap deployment mapping.'),
      source: z
        .enum(['uniswap_v3_swap', 'uniswap_v4_swap', 'aerodrome_slipstream_swap', 'uniswap_v2_sync'])
        .optional()
        .default('uniswap_v3_swap')
        .describe('Which event source to build candles from. Uniswap v4 uses PoolManager Swap events filtered by pool_id, not a per-pool contract address.'),
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
      currency0_address: z.string().optional().describe('Optional Uniswap v4 currency0 address. Use with currency1_address, fee, and tick_spacing to derive pool_id factually.'),
      currency1_address: z.string().optional().describe('Optional Uniswap v4 currency1 address. Use with currency0_address, fee, and tick_spacing to derive pool_id factually.'),
      fee: z.number().int().optional().describe('Optional Uniswap v4 LP fee in hundredths of a bip, e.g. 3000 for 0.30%.'),
      tick_spacing: z.number().int().optional().describe('Optional Uniswap v4 tick spacing. Required with the rest of the pool key when deriving pool_id.'),
      hooks_address: z.string().optional().describe('Optional Uniswap v4 hooks contract address. Defaults to the zero address when omitted.'),
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
      pool_id,
      pool_manager_address,
      source,
      interval,
      duration,
      base_token,
      currency0_address,
      currency1_address,
      fee,
      tick_spacing,
      hooks_address,
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
      pool_id = paginationCursor?.request.pool_id ?? pool_id
      pool_manager_address = paginationCursor?.request.pool_manager_address ?? pool_manager_address
      source = paginationCursor?.request.source ?? source
      interval = paginationCursor?.request.interval ?? interval
      duration = paginationCursor?.request.duration ?? duration
      base_token = paginationCursor?.request.base_token ?? base_token
      currency0_address = paginationCursor?.request.currency0_address ?? currency0_address
      currency1_address = paginationCursor?.request.currency1_address ?? currency1_address
      fee = paginationCursor?.request.fee ?? fee
      tick_spacing = paginationCursor?.request.tick_spacing ?? tick_spacing
      hooks_address = paginationCursor?.request.hooks_address ?? hooks_address
      token0_symbol = paginationCursor?.request.token0_symbol ?? token0_symbol
      token1_symbol = paginationCursor?.request.token1_symbol ?? token1_symbol
      token0_decimals = paginationCursor?.request.token0_decimals ?? token0_decimals
      token1_decimals = paginationCursor?.request.token1_decimals ?? token1_decimals
      token0_address = paginationCursor?.request.token0_address ?? token0_address
      token1_address = paginationCursor?.request.token1_address ?? token1_address

      if (!isUniswapV4SwapSource(source as EvmOhlcSource) && !pool_address) {
        throw new Error('pool_address is required for address-keyed sources unless you are continuing with cursor')
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

      const normalizedPoolAddress = pool_address ? normalizeEvmAddress(pool_address) : undefined
      const normalizedCurrency0Address = currency0_address ? normalizeEvmAddress(currency0_address) : undefined
      const normalizedCurrency1Address = currency1_address ? normalizeEvmAddress(currency1_address) : undefined
      const normalizedHooksAddress = hooks_address ? normalizeEvmAddress(hooks_address) : ZERO_ADDRESS

      let normalizedPoolId = pool_id ? normalizePoolId(pool_id) : undefined
      let normalizedPoolManagerAddress = pool_manager_address ? normalizeEvmAddress(pool_manager_address) : undefined
      let derivedPoolIdFromKey = false

      if (isUniswapV4SwapSource(source as EvmOhlcSource)) {
        if (!normalizedPoolManagerAddress) {
          normalizedPoolManagerAddress = UNISWAP_V4_POOL_MANAGER_BY_DATASET[dataset]
        }
        if (!normalizedPoolManagerAddress) {
          throw new Error('pool_manager_address is required for uniswap_v4_swap on this network because there is no built-in official Uniswap deployment mapping yet')
        }

        if (normalizedPoolId === undefined) {
          if (!normalizedCurrency0Address || !normalizedCurrency1Address || fee === undefined || tick_spacing === undefined) {
            throw new Error('uniswap_v4_swap requires pool_id, or the full pool key: currency0_address, currency1_address, fee, and tick_spacing')
          }
          if (compareHexAddresses(normalizedCurrency0Address, normalizedCurrency1Address) >= 0) {
            throw new Error('Uniswap v4 requires currency0_address to be lower than currency1_address in the pool key')
          }
          if (fee < 0) {
            throw new Error('fee must be a non-negative integer for uniswap_v4_swap')
          }
          if (tick_spacing <= 0) {
            throw new Error('tick_spacing must be a positive integer for uniswap_v4_swap')
          }

          normalizedPoolId = computeUniswapV4PoolId({
            currency0_address: normalizedCurrency0Address,
            currency1_address: normalizedCurrency1Address,
            fee,
            tick_spacing,
            hooks_address: normalizedHooksAddress,
          })
          derivedPoolIdFromKey = true
        } else if (normalizedCurrency0Address && normalizedCurrency1Address && fee !== undefined && tick_spacing !== undefined) {
          const computedPoolId = computeUniswapV4PoolId({
            currency0_address: normalizedCurrency0Address,
            currency1_address: normalizedCurrency1Address,
            fee,
            tick_spacing,
            hooks_address: normalizedHooksAddress,
          })
          if (computedPoolId !== normalizedPoolId) {
            throw new Error('pool_id does not match the provided Uniswap v4 pool key inputs')
          }
        }
      }

      const effectiveToken0Address = token0_address
        ? normalizeEvmAddress(token0_address)
        : normalizedCurrency0Address
      const effectiveToken1Address = token1_address
        ? normalizeEvmAddress(token1_address)
        : normalizedCurrency1Address
      const resolvedToken0Decimals = token0_decimals ?? (effectiveToken0Address ? getKnownTokenDecimals(effectiveToken0Address) : undefined)
      const resolvedToken1Decimals = token1_decimals ?? (effectiveToken1Address ? getKnownTokenDecimals(effectiveToken1Address) : undefined)

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
          isUniswapV4SwapSource(source as EvmOhlcSource)
            ? {
                address: [normalizedPoolManagerAddress],
                topic0: [getSourceEventSignature(source as EvmOhlcSource)],
                topic1: [normalizedPoolId],
              }
            : {
                address: [normalizedPoolAddress],
                topic0: [getSourceEventSignature(source as EvmOhlcSource)],
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
        const queryTarget = isUniswapV4SwapSource(source as EvmOhlcSource)
          ? `${normalizedPoolManagerAddress}:${normalizedPoolId}`
          : normalizedPoolAddress
        throw new Error(`No ${source} events found for ${queryTarget} in the requested window`)
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
      const volumePanel = isConcentratedLiquiditySwapSource(source as EvmOhlcSource)
      const sourceFamily = getSourceFamily(source as EvmOhlcSource)
      const priceMethod = getPriceMethod(source as EvmOhlcSource)

      const ohlc: OhlcRow[] = Array.from({ length: expectedBuckets }, (_, bucketIndex) => {
        const bucketTimestamp = seriesStartTimestamp + bucketIndex * intervalSeconds
        const bucket = buckets.get(bucketTimestamp)
        const open = formatPriceForOutput(bucket?.open)
        const high = formatPriceForOutput(bucket?.high)
        const low = formatPriceForOutput(bucket?.low)
        const close = formatPriceForOutput(bucket?.close)
        const direction =
          open === null || close === null
            ? 'none'
            : close > open
              ? 'up'
              : close < open
                ? 'down'
                : 'flat'

        return {
          bucket_index: bucketIndex,
          timestamp: bucketTimestamp,
          timestamp_human: formatTimestamp(bucketTimestamp),
          open,
          high,
          low,
          close,
          base_volume: bucket ? parseFloat(bucket.base_volume.toFixed(6)) : 0,
          quote_volume: bucket ? parseFloat(bucket.quote_volume.toFixed(6)) : 0,
          sample_count: bucket?.sample_count ?? 0,
          direction,
        }
      })

      const priceValues = ohlc.flatMap((bucket) => [bucket.open, bucket.high, bucket.low, bucket.close]).filter((value): value is number => value !== null)
      const priceValueFormat = inferPriceValueFormat(priceValues)
      const maxObservedVolume = Math.max(Math.abs(totalBaseVolume), Math.abs(totalQuoteVolume))
      const volumeValueFormat: TableValueFormat =
        maxObservedVolume >= 1e15 ? 'scientific' : maxObservedVolume >= 100_000 ? 'compact_number' : 'decimal'
      const volumeBars = ohlc.map((bucket) => ({
        timestamp: bucket.timestamp,
        timestamp_human: bucket.timestamp_human,
        volume: bucket.base_volume,
        direction: bucket.direction,
        color_hint:
          bucket.direction === 'up'
            ? 'green'
            : bucket.direction === 'down'
              ? 'red'
              : bucket.direction === 'flat'
                ? 'neutral'
                : 'muted',
        sample_count: bucket.sample_count,
      }))

      const filledBuckets = ohlc.filter((bucket) => bucket.sample_count > 0).length
      const firstFilled = ohlc.find((bucket) => bucket.sample_count > 0)
      const lastFilled = [...ohlc].reverse().find((bucket) => bucket.sample_count > 0)
      const latestFilled = lastFilled
      const seriesHigh = priceValues.length > 0 ? Math.max(...priceValues) : undefined
      const seriesLow = priceValues.length > 0 ? Math.min(...priceValues) : undefined
      const absoluteChange =
        firstFilled?.open !== null && firstFilled?.open !== undefined && latestFilled?.close !== null && latestFilled?.close !== undefined
          ? latestFilled.close - firstFilled.open
          : undefined
      const percentChange =
        absoluteChange !== undefined && firstFilled?.open && firstFilled.open !== 0
          ? (absoluteChange / firstFilled.open) * 100
          : undefined
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
                ...(normalizedPoolId ? { pool_id: normalizedPoolId } : {}),
                ...(normalizedPoolManagerAddress ? { pool_manager_address: normalizedPoolManagerAddress } : {}),
                source: source as EvmOhlcSource,
                interval: interval as OhlcIntervalInput,
                duration: duration as OhlcDuration,
                base_token: base_token as BaseTokenSide,
                ...(normalizedCurrency0Address ? { currency0_address: normalizedCurrency0Address } : {}),
                ...(normalizedCurrency1Address ? { currency1_address: normalizedCurrency1Address } : {}),
                ...(fee !== undefined ? { fee } : {}),
                ...(tick_spacing !== undefined ? { tick_spacing } : {}),
                ...(normalizedHooksAddress !== ZERO_ADDRESS ? { hooks_address: normalizedHooksAddress } : {}),
                ...(token0_symbol ? { token0_symbol } : {}),
                ...(token1_symbol ? { token1_symbol } : {}),
                ...(resolvedToken0Decimals !== undefined ? { token0_decimals: resolvedToken0Decimals } : {}),
                ...(resolvedToken1Decimals !== undefined ? { token1_decimals: resolvedToken1Decimals } : {}),
                ...(effectiveToken0Address ? { token0_address: effectiveToken0Address } : {}),
                ...(effectiveToken1Address ? { token1_address: effectiveToken1Address } : {}),
              },
              window_start_timestamp: Math.max(0, seriesStartTimestamp - durationSeconds),
              window_end_exclusive: seriesStartTimestamp,
            })
          : undefined

      const notices: string[] = []
      if (priceScale === 'raw_ratio') {
        notices.push('Prices use raw pool ratios because token decimals were not fully provided. Pass token0_decimals and token1_decimals for human-readable prices.')
      }
      if (isReserveSyncSource(source as EvmOhlcSource)) {
        notices.push('Sync-derived candles provide reserve-ratio prices only. base_volume and quote_volume stay 0 because Sync events do not expose traded amounts.')
      }
      if (source === 'aerodrome_slipstream_swap') {
        notices.push('Aerodrome Slipstream candles are decoded from its concentrated-liquidity Swap event shape, which is adapted from Uniswap V3.')
      }
      if (source === 'uniswap_v4_swap') {
        notices.push('Uniswap v4 candles are filtered on the PoolManager Swap event by pool_id rather than a per-pool contract address.')
        if (!normalizedCurrency0Address || !normalizedCurrency1Address) {
          notices.push('pool_id is a one-way hash. Pass currency0_address/currency1_address or token symbols if you want clearer token labeling.')
        }
        if (derivedPoolIdFromKey) {
          notices.push('pool_id was derived from the provided Uniswap v4 pool key.')
        }
      }
      if (nextCursor) {
        notices.push('Older candles are available via _pagination.next_cursor.')
      }

      const summary = {
        source,
        ...(normalizedPoolAddress ? { contract_address: normalizedPoolAddress } : {}),
        ...(normalizedPoolManagerAddress ? { pool_manager_address: normalizedPoolManagerAddress } : {}),
        ...(normalizedPoolId ? { pool_id: normalizedPoolId } : {}),
        ...(normalizedCurrency0Address ? { currency0_address: normalizedCurrency0Address } : {}),
        ...(normalizedCurrency1Address ? { currency1_address: normalizedCurrency1Address } : {}),
        ...(fee !== undefined ? { fee } : {}),
        ...(tick_spacing !== undefined ? { tick_spacing } : {}),
        ...(normalizedHooksAddress !== ZERO_ADDRESS ? { hooks_address: normalizedHooksAddress } : {}),
        interval: resolvedInterval,
        interval_requested: interval,
        duration,
        base_token: baseLabel,
        quote_token: quoteLabel,
        pair_label: `${baseLabel}/${quoteLabel}`,
        venue_label:
          source === 'uniswap_v4_swap'
            ? 'Uniswap v4'
            : source === 'uniswap_v3_swap'
              ? 'Uniswap v3'
              : source === 'aerodrome_slipstream_swap'
                ? 'Aerodrome Slipstream'
                : 'Sync-derived CPMM',
        base_token_side: base_token,
        source_family: sourceFamily,
        price_method: priceMethod,
        price_unit: `${quoteLabel}/${baseLabel}${priceScale === 'raw_ratio' ? ' (raw ratio)' : ''}`,
        price_scale: priceScale,
        price_value_format: priceValueFormat,
        volume_value_format: volumeValueFormat,
        volume_available: volumePanel,
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
        ...(latestFilled?.open !== null && latestFilled?.open !== undefined ? { latest_open: latestFilled.open } : {}),
        ...(latestFilled?.high !== null && latestFilled?.high !== undefined ? { latest_high: latestFilled.high } : {}),
        ...(latestFilled?.low !== null && latestFilled?.low !== undefined ? { latest_low: latestFilled.low } : {}),
        ...(latestFilled?.close !== null && latestFilled?.close !== undefined ? { latest_close: latestFilled.close } : {}),
        ...(seriesHigh !== undefined ? { series_high: seriesHigh } : {}),
        ...(seriesLow !== undefined ? { series_low: seriesLow } : {}),
        ...(absoluteChange !== undefined ? { price_change_abs: absoluteChange } : {}),
        ...(percentChange !== undefined ? { price_change_pct: percentChange } : {}),
        ...(latestFilled ? { latest_bucket_volume: latestFilled.base_volume } : {}),
        ...(chunksFetched > 1 ? { chunks_fetched: chunksFetched } : {}),
        ...(backfillAttempts > 0 ? { backfill_attempts: backfillAttempts } : {}),
      }

      const chartTooltip: ChartTooltipDescriptor = {
        mode: 'axis',
        title_field: 'timestamp_human',
        title_label: 'Time',
        title_format: 'timestamp_human',
        fields: [
          { key: 'open', label: 'Open', format: priceValueFormat, unit: summary.price_unit, emphasis: 'primary' },
          { key: 'high', label: 'High', format: priceValueFormat, unit: summary.price_unit },
          { key: 'low', label: 'Low', format: priceValueFormat, unit: summary.price_unit },
          { key: 'close', label: 'Close', format: priceValueFormat, unit: summary.price_unit, emphasis: 'primary' },
          ...(volumePanel
            ? [
                { key: 'base_volume', label: `${baseLabel} volume`, format: volumeValueFormat, unit: baseLabel } as const,
                { key: 'sample_count', label: 'Samples', format: 'integer' } as const,
              ]
            : [{ key: 'sample_count', label: 'Samples', format: 'integer' } as const]),
        ],
      }

      const ui = buildPortalUi({
        version: 'portal_ui_v1',
        layout: 'chart_focus',
        density: 'compact',
        design_intent: 'market_terminal',
        headline: {
          title: `${baseLabel}/${quoteLabel} candles`,
          subtitle: `${summary.venue_label} • ${resolvedInterval} candles over ${duration}`,
        },
        metric_cards: [
          buildMetricCard({ id: 'last_close', label: 'Last close', value_path: 'summary.latest_close', format: priceValueFormat, unit: summary.price_unit, emphasis: 'primary' }),
          buildMetricCard({ id: 'change_pct', label: 'Change', value_path: 'summary.price_change_pct', format: 'percent', emphasis: 'primary' }),
          buildMetricCard({ id: 'series_high', label: 'High', value_path: 'summary.series_high', format: priceValueFormat, unit: summary.price_unit }),
          buildMetricCard({ id: 'series_low', label: 'Low', value_path: 'summary.series_low', format: priceValueFormat, unit: summary.price_unit }),
          buildMetricCard({
            id: 'base_volume',
            label: 'Volume',
            value_path: 'summary.total_base_volume',
            format: volumeValueFormat,
            unit: baseLabel,
          }),
        ],
        panels: [
          buildChartPanel({
            id: 'candles',
            kind: 'chart_panel',
            title: `${summary.pair_label} price action`,
            subtitle: 'Candles plus color-matched volume bars. Hover for O/H/L/C and volume; drag to zoom narrower windows.',
            chart_key: 'chart',
            emphasis: 'primary',
          }),
          buildTablePanel({
            id: 'ohlc-table',
            kind: 'table_panel',
            title: 'Candle table',
            subtitle: 'Exact bucket-level values for export or inspection.',
            table_id: 'ohlc',
          }),
        ],
        follow_up_actions: [
          ...(nextCursor ? [{ label: 'Load older candles', intent: 'continue' as const, target: '_pagination.next_cursor' }] : []),
          { label: 'Show raw candle rows', intent: 'show_raw', target: 'ohlc' },
          { label: 'Zoom into the latest move', intent: 'zoom_in', target: 'chart' },
        ],
      })

      return formatResult(
        {
          summary,
          chart: buildCandlestickChart({
            dataKey: 'ohlc',
            interval: resolvedInterval,
            totalCandles: ohlc.length,
            title: `${summary.pair_label} ${summary.venue_label} candles`,
            subtitle: `Price chart with volume histogram over ${duration} using ${resolvedInterval} buckets`,
            volumePanel,
            ...(volumePanel
              ? { volumeField: 'volume', volumeDataKey: 'volume_bars', volumeColorField: 'color_hint', volumeUnit: baseLabel }
              : {}),
            priceUnit: summary.price_unit,
            priceFormat: priceValueFormat,
            tooltip: chartTooltip,
          }),
          tables: [
            buildOhlcTable({
              id: 'ohlc',
              rowCount: ohlc.length,
              title: `${summary.pair_label} candle table`,
              subtitle: 'Bucket-aligned OHLC values for each interval',
              ...(volumePanel ? { volumeField: 'base_volume', volumeLabel: `${baseLabel} volume`, volumeUnit: baseLabel } : {}),
              priceUnit: summary.price_unit,
              priceFormat: priceValueFormat,
            }),
          ],
          gap_diagnostics: gapDiagnostics,
          ohlc,
          volume_bars: volumeBars,
        },
        `Built ${resolvedInterval} ${summary.pair_label} candles over ${duration}. ${filledBuckets}/${ohlc.length} buckets contain price updates.`,
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
            notes: [
              `Price source: ${source}.`,
              ...(normalizedPoolId ? [`Pool id: ${normalizedPoolId}.`] : []),
              `Source family: ${sourceFamily}; price method: ${priceMethod}.`,
              ...(volumePanel
                ? ['Volume fields come from swap-level token amounts emitted in each event.']
                : ['Volume fields are unavailable for this source because reserve Sync events do not expose per-trade amounts.']),
            ],
          }),
          ui,
          llm: {
            answer_sequence: ['summary.series_close', 'summary.total_base_volume', 'summary.total_quote_volume', 'summary.filled_buckets', 'ohlc'],
            parser_notes: [
              'Use summary.series_close as the headline price and primary_preview as the latest candle instead of scanning the whole ohlc array.',
              'Check _coverage and gap_diagnostics before claiming the candle window is fully filled.',
            ],
          },
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
