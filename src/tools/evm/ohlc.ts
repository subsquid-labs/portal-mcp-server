import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { keccak_256 } from '@noble/hashes/sha3'
import { z } from 'zod'

import { resolveDataset, validateBlockRange } from '../../cache/datasets.js'
import { EVENT_SIGNATURES, PORTAL_URL } from '../../constants/index.js'
import {
  buildTableDescriptor,
  buildCandlestickChart,
  buildOhlcTable,
  type ChartTooltipDescriptor,
  type TableValueFormat,
} from '../../helpers/chart-metadata.js'
import { createCache, estimateSize } from '../../helpers/cache-manager.js'
import { detectChainType } from '../../helpers/chain.js'
import { getKnownTokenDecimals, getKnownTokenSymbol } from '../../helpers/conversions.js'
import { createUnsupportedChainError } from '../../helpers/errors.js'
import { portalFetchRecentRecords, portalFetchStreamRangeVisit } from '../../helpers/fetch.js'
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
  | 'uniswap_v2_swap'
  | 'uniswap_v3_swap'
  | 'uniswap_v4_swap'
  | 'aerodrome_slipstream_swap'
  | 'uniswap_v2_sync'
type BaseTokenSide = 'token0' | 'token1'
type PriceDisplayMode = 'auto' | 'token0' | 'token1'
type OhlcMode = 'fast' | 'deep'

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
    mode: OhlcMode
    base_token?: BaseTokenSide
    price_in?: PriceDisplayMode
    include_recent_trades?: boolean
    recent_trades_limit?: number
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

type DecodedPriceSample = {
  kind: 'swap' | 'reserve'
  priceToken1PerToken0: number
  token0Volume: number
  token1Volume: number
  token0Delta?: bigint
  token1Delta?: bigint
}

type RecentTradeCandidate = {
  timestamp: number
  timestamp_human: string
  tx_hash?: string
  log_index?: number
  sender?: string
  recipient?: string
  priceToken1PerToken0: number
  token0Volume: number
  token1Volume: number
  token0Delta?: bigint
  token1Delta?: bigint
}

type ResolvedPriceOrientation = {
  baseTokenSide: BaseTokenSide
  quoteTokenSide: BaseTokenSide
  priceInRequested: PriceDisplayMode
  reason: string
}

type UniswapV4PoolMetadata = {
  currency0_address: string
  currency1_address: string
  fee: number
  tick_spacing: number
  hooks_address: string
  initialized_block?: number
  initialized_timestamp?: number
}

type GuidanceQuerySuggestion = {
  label: string
  reason: string
  input: Record<string, unknown>
}

type CachedOhlcResponse = {
  key: string
  response: { content: Array<{ type: 'text'; text: string }> }
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
const FAST_LOG_CHUNK_SIZE = 2_500
const MIN_LOG_CHUNK_SIZE = 250
const EVM_OHLC_MAX_BYTES = 100 * 1024 * 1024
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
const UNISWAP_V4_POOL_MANAGER_BY_DATASET: Record<string, string> = {
  'ethereum-mainnet': '0x000000000004444c5dc75cb358380d2e3de08a90',
  'optimism-mainnet': '0x9a13f98cb987694c9f086b1f5eb990eea8264ec3',
  'base-mainnet': '0x498581ff718922c3f8e6a244956af099b2652b2b',
  'arbitrum-one': '0x360e68faccca8ca495c1b759fd9eee466db9fb32',
}
const UNISWAP_V4_METADATA_LOOKBACK_STEPS = [250_000, 1_000_000, 2_000_000]
const UNISWAP_V4_METADATA_TIMEOUT_MS = 4_000
const UNISWAP_V4_METADATA_CHUNK_SIZE = 50_000
const UNISWAP_V4_METADATA_MAX_CHUNKS_BY_MODE: Record<OhlcMode, number> = {
  fast: 1,
  deep: 3,
}
const EVM_OHLC_METADATA_CACHE_TTL_MS = 15 * 60_000
const EVM_OHLC_RESPONSE_CACHE_TTL_MS = 20_000
const evmOhlcMetadataCache = createCache<UniswapV4PoolMetadata | null>(EVM_OHLC_METADATA_CACHE_TTL_MS, 128)
const evmOhlcResponseCache = createCache<CachedOhlcResponse>(EVM_OHLC_RESPONSE_CACHE_TTL_MS, 32)
const pendingUniswapV4Metadata = new Map<string, Promise<UniswapV4PoolMetadata | undefined>>()

function isConcentratedLiquiditySwapSource(source: EvmOhlcSource) {
  return source === 'uniswap_v3_swap' || source === 'uniswap_v4_swap' || source === 'aerodrome_slipstream_swap'
}

function isConstantProductSwapSource(source: EvmOhlcSource) {
  return source === 'uniswap_v2_swap'
}

function isUniswapV4SwapSource(source: EvmOhlcSource) {
  return source === 'uniswap_v4_swap'
}

function isReserveSyncSource(source: EvmOhlcSource) {
  return source === 'uniswap_v2_sync'
}

function getSourceEventSignature(source: EvmOhlcSource) {
  if (source === 'uniswap_v4_swap') return EVENT_SIGNATURES.UNISWAP_V4_SWAP
  if (isConcentratedLiquiditySwapSource(source)) return EVENT_SIGNATURES.UNISWAP_V3_SWAP
  if (isConstantProductSwapSource(source)) return EVENT_SIGNATURES.UNISWAP_V2_SWAP
  return EVENT_SIGNATURES.SYNC
}

function getSourceFamily(source: EvmOhlcSource) {
  switch (source) {
    case 'uniswap_v2_swap':
      return 'uniswap_v2_style_swap'
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
  if (isConcentratedLiquiditySwapSource(source)) return 'sqrt_price_x96'
  if (isConstantProductSwapSource(source)) return 'execution_ratio'
  return 'reserve_ratio'
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

function decodeTopicAddress(topic: string | undefined): string | undefined {
  if (!topic || !/^0x[0-9a-fA-F]{64}$/.test(topic)) return undefined
  return `0x${topic.slice(-40).toLowerCase()}`
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

function decodeSignedInt24(word: string | undefined): number | undefined {
  const value = decodeSignedWord(word)
  if (value === undefined) return undefined
  return Number(BigInt.asIntN(24, value))
}

function toScaledNumber(value: bigint, decimals?: number): number {
  const divisor = decimals !== undefined ? 10 ** decimals : 1
  return Number(value) / divisor
}

function shortenAddressLabel(address: string) {
  return `${address.slice(0, 6)}...${address.slice(-4)}`
}

function resolveTokenLabel(side: BaseTokenSide, symbol?: string, address?: string) {
  return symbol || (address ? getKnownTokenSymbol(address) || shortenAddressLabel(address) : side)
}

function isStableLikeLabel(label: string) {
  return /^(usd|usdc|usdt|dai|fdusd|usde|usds)$/i.test(label)
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
  token0Decimals?: number
  token1Decimals?: number
}): DecodedPriceSample | undefined {
  const words = splitDataWords(params.log.data)

  if (isConcentratedLiquiditySwapSource(params.source)) {
    const amount0 = decodeSignedWord(words[0])
    const amount1 = decodeSignedWord(words[1])
    const sqrtPriceX96 = decodeUnsignedWord(words[2])
    if (amount0 === undefined || amount1 === undefined || sqrtPriceX96 === undefined) return undefined

    const priceToken1PerToken0 = getPriceFromV3SqrtPrice(sqrtPriceX96, 'token0', params.token0Decimals, params.token1Decimals)
    if (priceToken1PerToken0 === undefined) return undefined

    return {
      kind: 'swap',
      priceToken1PerToken0,
      token0Volume: toScaledNumber(amount0 < 0n ? -amount0 : amount0, params.token0Decimals),
      token1Volume: toScaledNumber(amount1 < 0n ? -amount1 : amount1, params.token1Decimals),
      token0Delta: amount0,
      token1Delta: amount1,
    }
  }

  if (isConstantProductSwapSource(params.source)) {
    const amount0In = decodeUnsignedWord(words[0])
    const amount1In = decodeUnsignedWord(words[1])
    const amount0Out = decodeUnsignedWord(words[2])
    const amount1Out = decodeUnsignedWord(words[3])
    if (amount0In === undefined || amount1In === undefined || amount0Out === undefined || amount1Out === undefined) return undefined

    const token0Delta = amount0In - amount0Out
    const token1Delta = amount1In - amount1Out
    const token0Volume = toScaledNumber(token0Delta < 0n ? -token0Delta : token0Delta, params.token0Decimals)
    const token1Volume = toScaledNumber(token1Delta < 0n ? -token1Delta : token1Delta, params.token1Decimals)

    if (!Number.isFinite(token0Volume) || !Number.isFinite(token1Volume) || token0Volume <= 0 || token1Volume <= 0) {
      return undefined
    }

    return {
      kind: 'swap',
      priceToken1PerToken0: token1Volume / token0Volume,
      token0Volume,
      token1Volume,
      token0Delta,
      token1Delta,
    }
  }

  const reserve0 = decodeUnsignedWord(words[0])
  const reserve1 = decodeUnsignedWord(words[1])
  if (reserve0 === undefined || reserve1 === undefined) return undefined

  const priceToken1PerToken0 = getPriceFromV2Reserves(reserve0, reserve1, 'token0', params.token0Decimals, params.token1Decimals)
  if (priceToken1PerToken0 === undefined) return undefined

  return {
    kind: 'reserve',
    priceToken1PerToken0,
    token0Volume: 0,
    token1Volume: 0,
  }
}

function projectPriceSample(sample: DecodedPriceSample, baseToken: BaseTokenSide): { price: number; baseVolume: number; quoteVolume: number } | undefined {
  const price = baseToken === 'token0' ? sample.priceToken1PerToken0 : 1 / sample.priceToken1PerToken0
  if (price === undefined) return undefined

  return {
    price,
    baseVolume: baseToken === 'token0' ? sample.token0Volume : sample.token1Volume,
    quoteVolume: baseToken === 'token0' ? sample.token1Volume : sample.token0Volume,
  }
}

function getTradeCounterparties(source: EvmOhlcSource, log: EvmLogRecord): { sender?: string; recipient?: string } {
  if (source === 'uniswap_v4_swap') {
    return {
      sender: decodeTopicAddress(log.topics?.[2]),
    }
  }

  if (source === 'uniswap_v2_swap') {
    return {
      sender: decodeTopicAddress(log.topics?.[1]),
      recipient: decodeTopicAddress(log.topics?.[2]),
    }
  }

  if (isConcentratedLiquiditySwapSource(source)) {
    return {
      sender: decodeTopicAddress(log.topics?.[1]),
      recipient: decodeTopicAddress(log.topics?.[2]),
    }
  }

  return {}
}

function buildRecentTradeRow(
  trade: RecentTradeCandidate,
  baseTokenSide: BaseTokenSide,
  baseLabel: string,
  quoteLabel: string,
): Record<string, unknown> {
  const baseAmount = baseTokenSide === 'token0' ? trade.token0Volume : trade.token1Volume
  const quoteAmount = baseTokenSide === 'token0' ? trade.token1Volume : trade.token0Volume
  const baseDelta = baseTokenSide === 'token0' ? trade.token0Delta : trade.token1Delta
  const price = formatPriceForOutput(baseTokenSide === 'token0' ? trade.priceToken1PerToken0 : 1 / trade.priceToken1PerToken0)
  const side =
    baseDelta === undefined
      ? 'unknown'
      : baseDelta < 0n
        ? 'buy'
        : baseDelta > 0n
          ? 'sell'
          : 'flat'

  return {
    timestamp: trade.timestamp,
    timestamp_human: trade.timestamp_human,
    side,
    color_hint: side === 'buy' ? 'green' : side === 'sell' ? 'red' : 'neutral',
    price,
    base_amount: Number(baseAmount.toFixed(6)),
    quote_amount: Number(quoteAmount.toFixed(6)),
    tx_hash: trade.tx_hash,
    sender: trade.sender,
  }
}

function scorePriceOrientation(values: number[], quoteLabel: string): number {
  const magnitudes = values.map((value) => Math.abs(value)).filter((value) => value > 0)
  if (magnitudes.length === 0) return Number.NEGATIVE_INFINITY

  const sorted = magnitudes.sort((left, right) => left - right)
  const median = sorted[Math.floor(sorted.length / 2)]
  const logDistance = Math.abs(Math.log10(median))
  let score = -logDistance

  if (median >= 0.01 && median <= 100_000) score += 3
  else if (median >= 0.0001 && median <= 1_000_000) score += 1

  if (median < 1e-6 || median > 1e8) score -= 3
  else if (median < 1e-4 || median > 1e6) score -= 1

  if (isStableLikeLabel(quoteLabel)) score += 0.75

  return score
}

function resolvePriceOrientation(params: {
  requestedPriceIn?: PriceDisplayMode
  legacyBaseToken?: BaseTokenSide
  token0Label: string
  token1Label: string
  token0Values: number[]
  token1Values: number[]
}): ResolvedPriceOrientation {
  if (params.legacyBaseToken) {
    return {
      baseTokenSide: params.legacyBaseToken,
      quoteTokenSide: params.legacyBaseToken === 'token0' ? 'token1' : 'token0',
      priceInRequested: params.requestedPriceIn ?? (params.legacyBaseToken === 'token0' ? 'token1' : 'token0'),
      reason: 'Preserved the explicitly requested legacy base_token orientation.',
    }
  }

  if (params.requestedPriceIn === 'token0') {
    return {
      baseTokenSide: 'token1',
      quoteTokenSide: 'token0',
      priceInRequested: 'token0',
      reason: `Expressing price in ${params.token0Label}.`,
    }
  }

  if (params.requestedPriceIn === 'token1') {
    return {
      baseTokenSide: 'token0',
      quoteTokenSide: 'token1',
      priceInRequested: 'token1',
      reason: `Expressing price in ${params.token1Label}.`,
    }
  }

  const token1Score = scorePriceOrientation(params.token0Values, params.token1Label)
  const token0Score = scorePriceOrientation(params.token1Values, params.token0Label)

  if (token1Score >= token0Score) {
    return {
      baseTokenSide: 'token0',
      quoteTokenSide: 'token1',
      priceInRequested: 'auto',
      reason: `Auto-selected ${params.token1Label} as the quote side because it produces the more readable price scale.`,
    }
  }

  return {
    baseTokenSide: 'token1',
    quoteTokenSide: 'token0',
    priceInRequested: 'auto',
    reason: `Auto-selected ${params.token0Label} as the quote side because it produces the more readable price scale.`,
  }
}

async function resolveUniswapV4PoolMetadata(params: {
  dataset: string
  poolManagerAddress: string
  poolId: string
  toBlock: number
  mode: OhlcMode
  lookbackSteps?: number[]
}): Promise<UniswapV4PoolMetadata | undefined> {
  const lookbackSteps = params.lookbackSteps ?? UNISWAP_V4_METADATA_LOOKBACK_STEPS

  for (const lookbackBlocks of lookbackSteps) {
    const fromBlock = Math.max(0, params.toBlock - lookbackBlocks)
    const results = await portalFetchRecentRecords(
      `${PORTAL_URL}/datasets/${params.dataset}/stream`,
      {
        type: 'evm',
        fromBlock,
        toBlock: params.toBlock,
        fields: {
          block: { number: true, timestamp: true },
          log: buildEvmLogFields(),
        },
        logs: [
          {
            address: [params.poolManagerAddress],
            topic0: [EVENT_SIGNATURES.UNISWAP_V4_INITIALIZE],
            topic1: [params.poolId],
          },
        ],
      },
      {
        itemKeys: ['logs'],
        limit: 1,
        chunkSize: UNISWAP_V4_METADATA_CHUNK_SIZE,
        maxChunks: UNISWAP_V4_METADATA_MAX_CHUNKS_BY_MODE[params.mode],
        timeout: UNISWAP_V4_METADATA_TIMEOUT_MS,
        retries: 0,
      },
    )

    for (const result of results) {
      const block = result as {
        number?: number
        timestamp?: number
        header?: { number?: number; timestamp?: number }
        logs?: EvmLogRecord[]
      }
      for (const log of sortLogs(block.logs || [])) {
        if (String(log.topics?.[1] || '').toLowerCase() !== params.poolId) continue

        const words = splitDataWords(log.data)
        const fee = decodeUnsignedWord(words[0])
        const tickSpacing = decodeSignedInt24(words[1])
        const hooksAddress = decodeTopicAddress(`0x${words[2] ?? ''}`)
        const currency0 = decodeTopicAddress(log.topics?.[2])
        const currency1 = decodeTopicAddress(log.topics?.[3])

        if (!currency0 || !currency1 || fee === undefined || tickSpacing === undefined || !hooksAddress) continue

        return {
          currency0_address: currency0,
          currency1_address: currency1,
          fee: Number(fee),
          tick_spacing: tickSpacing,
          hooks_address: hooksAddress,
          initialized_block: block.number ?? block.header?.number,
          initialized_timestamp: block.timestamp ?? block.header?.timestamp,
        }
      }
    }
  }

  return undefined
}

function cloneResponse<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function buildOhlcResponseCacheKey(params: {
  dataset: string
  source: EvmOhlcSource
  interval: OhlcInterval
  duration: OhlcDuration
  mode: OhlcMode
  endBlock: number
  poolAddress?: string
  poolId?: string
  poolManagerAddress?: string
  priceIn?: PriceDisplayMode
  includeRecentTrades?: boolean
  recentTradesLimit?: number
  currency0Address?: string
  currency1Address?: string
  fee?: number
  tickSpacing?: number
  hooksAddress?: string
  token0Symbol?: string
  token1Symbol?: string
  token0Decimals?: number
  token1Decimals?: number
  token0Address?: string
  token1Address?: string
}): string {
  return [
    params.dataset,
    params.source,
    params.interval,
    params.duration,
    params.mode,
    params.endBlock,
    params.poolAddress ?? '',
    params.poolId ?? '',
    params.poolManagerAddress ?? '',
    params.priceIn ?? '',
    String(Boolean(params.includeRecentTrades)),
    String(params.recentTradesLimit ?? ''),
    params.currency0Address ?? '',
    params.currency1Address ?? '',
    String(params.fee ?? ''),
    String(params.tickSpacing ?? ''),
    params.hooksAddress ?? '',
    params.token0Symbol ?? '',
    params.token1Symbol ?? '',
    String(params.token0Decimals ?? ''),
    String(params.token1Decimals ?? ''),
    params.token0Address ?? '',
    params.token1Address ?? '',
  ].join(':')
}

async function getCachedOrResolveUniswapV4PoolMetadata(params: {
  dataset: string
  poolManagerAddress: string
  poolId: string
  toBlock: number
  mode: OhlcMode
}): Promise<UniswapV4PoolMetadata | undefined> {
  const cacheKey = `${params.dataset}:${params.poolManagerAddress}:${params.poolId}`
  const cached = evmOhlcMetadataCache.get(cacheKey)
  if (cached !== undefined) {
    return cached ?? undefined
  }

  const pending = pendingUniswapV4Metadata.get(cacheKey)
  if (pending) {
    return pending
  }

  const lookupPromise = resolveUniswapV4PoolMetadata({
    dataset: params.dataset,
    poolManagerAddress: params.poolManagerAddress,
    poolId: params.poolId,
    toBlock: params.toBlock,
    mode: params.mode,
    lookbackSteps:
      params.mode === 'fast'
        ? UNISWAP_V4_METADATA_LOOKBACK_STEPS.slice(0, 1)
        : UNISWAP_V4_METADATA_LOOKBACK_STEPS,
  })

  pendingUniswapV4Metadata.set(cacheKey, lookupPromise)

  try {
    const resolved = await lookupPromise
    evmOhlcMetadataCache.set(cacheKey, resolved ?? null)
    return resolved
  } finally {
    pendingUniswapV4Metadata.delete(cacheKey)
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

function isTimeoutLikeMessage(message: string) {
  return /\btimeout\b|\btimed out\b|\brequest timeout\b/i.test(message)
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
        .enum(['uniswap_v2_swap', 'uniswap_v3_swap', 'uniswap_v4_swap', 'aerodrome_slipstream_swap', 'uniswap_v2_sync'])
        .optional()
        .default('uniswap_v3_swap')
        .describe('Which event source to build candles from. Prefer swap-derived sources for factual trade prices and volumes. Uniswap v4 uses PoolManager Swap events filtered by pool_id, not a per-pool contract address.'),
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
      mode: z.enum(['fast', 'deep']).optional().default('deep').describe('Execution mode. fast favors a quicker preview with lighter backfill; deep works harder to fill the full requested window.'),
      price_in: z.enum(['auto', 'token0', 'token1']).optional().default('auto').describe('Choose which token the displayed price should be expressed in. auto picks the more human-readable quote side.'),
      base_token: z.enum(['token0', 'token1']).optional().describe('Legacy orientation input. Prefer price_in instead.'),
      include_recent_trades: z.boolean().optional().default(true).describe('Include a recent trade tape for swap-derived sources when factual per-trade amounts are available.'),
      recent_trades_limit: z.number().int().min(1).max(50).optional().default(5).describe('Maximum number of recent trades to return in the trade tape.'),
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
      mode,
      price_in,
      base_token,
      include_recent_trades,
      recent_trades_limit,
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
      mode = paginationCursor?.request.mode ?? mode
      price_in = paginationCursor?.request.price_in ?? price_in
      base_token = paginationCursor?.request.base_token ?? base_token
      include_recent_trades = paginationCursor?.request.include_recent_trades ?? include_recent_trades
      recent_trades_limit = paginationCursor?.request.recent_trades_limit ?? recent_trades_limit
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
      let normalizedCurrency0Address = currency0_address ? normalizeEvmAddress(currency0_address) : undefined
      let normalizedCurrency1Address = currency1_address ? normalizeEvmAddress(currency1_address) : undefined
      let normalizedHooksAddress = hooks_address ? normalizeEvmAddress(hooks_address) : ZERO_ADDRESS
      const hooksAddressProvided = hooks_address !== undefined

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

      const resolvedInterval = resolveInterval(duration as OhlcDuration, interval as OhlcIntervalInput)
      const intervalSeconds = parseTimeframeToSeconds(resolvedInterval)
      const durationSeconds = parseTimeframeToSeconds(duration)
      const expectedBuckets = Math.max(1, Math.ceil(durationSeconds / intervalSeconds))
      const bucketsByBase: Record<BaseTokenSide, Map<number, CandleAccumulator>> = {
        token0: new Map<number, CandleAccumulator>(),
        token1: new Map<number, CandleAccumulator>(),
      }
      let latestTimestamp = 0
      let earliestObservedTimestamp = Number.MAX_SAFE_INTEGER
      let earliestObservedBelowPageEnd = Number.MAX_SAFE_INTEGER
      let earliestObservedBlock = Number.MAX_SAFE_INTEGER
      let totalSamples = 0
      const totalVolumesByBase: Record<BaseTokenSide, { base: number; quote: number }> = {
        token0: { base: 0, quote: 0 },
        token1: { base: 0, quote: 0 },
      }
      let chunksFetched = 0
      let scannedFromBlock = 0
      let seriesStartTimestamp = 0
      let seriesEndExclusive = 0
      let resolvedWindow
      let endBlock = 0
      let head

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
      }

      let resolvedV4Metadata: UniswapV4PoolMetadata | undefined
      let v4MetadataResolutionStatus: 'not_requested' | 'resolved' | 'not_found' | 'timeout' | 'failed' = 'not_requested'
      if (
        isUniswapV4SwapSource(source as EvmOhlcSource)
        && normalizedPoolId
        && (
          !normalizedCurrency0Address
          || !normalizedCurrency1Address
          || fee === undefined
          || tick_spacing === undefined
          || !hooksAddressProvided
        )
      ) {
        try {
          resolvedV4Metadata = await getCachedOrResolveUniswapV4PoolMetadata({
            dataset,
            poolManagerAddress: normalizedPoolManagerAddress!,
            poolId: normalizedPoolId,
            toBlock: endBlock,
            mode: mode as OhlcMode,
          })
          v4MetadataResolutionStatus = resolvedV4Metadata ? 'resolved' : 'not_found'

          if (resolvedV4Metadata) {
            normalizedCurrency0Address = normalizedCurrency0Address ?? resolvedV4Metadata.currency0_address
            normalizedCurrency1Address = normalizedCurrency1Address ?? resolvedV4Metadata.currency1_address
            fee = fee ?? resolvedV4Metadata.fee
            tick_spacing = tick_spacing ?? resolvedV4Metadata.tick_spacing
            if (!hooksAddressProvided) {
              normalizedHooksAddress = resolvedV4Metadata.hooks_address
            }
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          v4MetadataResolutionStatus = isTimeoutLikeMessage(message) ? 'timeout' : 'failed'
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
      const resolvedToken0Symbol = token0_symbol ?? (effectiveToken0Address ? getKnownTokenSymbol(effectiveToken0Address) : undefined)
      const resolvedToken1Symbol = token1_symbol ?? (effectiveToken1Address ? getKnownTokenSymbol(effectiveToken1Address) : undefined)
      const token0Label = resolveTokenLabel('token0', resolvedToken0Symbol, effectiveToken0Address)
      const token1Label = resolveTokenLabel('token1', resolvedToken1Symbol, effectiveToken1Address)
      const responseCacheKey = !paginationCursor
        ? buildOhlcResponseCacheKey({
            dataset,
            source: source as EvmOhlcSource,
            interval: resolvedInterval,
            duration: duration as OhlcDuration,
            mode: mode as OhlcMode,
            endBlock,
            poolAddress: normalizedPoolAddress,
            poolId: normalizedPoolId,
            poolManagerAddress: normalizedPoolManagerAddress,
            priceIn: price_in as PriceDisplayMode,
            includeRecentTrades: include_recent_trades,
            recentTradesLimit: recent_trades_limit,
            currency0Address: normalizedCurrency0Address,
            currency1Address: normalizedCurrency1Address,
            fee,
            tickSpacing: tick_spacing,
            hooksAddress: normalizedHooksAddress,
            token0Symbol: resolvedToken0Symbol,
            token1Symbol: resolvedToken1Symbol,
            token0Decimals: resolvedToken0Decimals,
            token1Decimals: resolvedToken1Decimals,
            token0Address: effectiveToken0Address,
            token1Address: effectiveToken1Address,
          })
        : undefined

      if (responseCacheKey) {
        const cached = evmOhlcResponseCache.get(responseCacheKey)
        if (cached) {
          return cloneResponse(cached.response)
        }
      }

      const volumePanel = !isReserveSyncSource(source as EvmOhlcSource)
      const sourceFamily = getSourceFamily(source as EvmOhlcSource)
      const priceMethod = getPriceMethod(source as EvmOhlcSource)
      const tradeLimit = recent_trades_limit ?? 5
      const recentTradeCandidates: RecentTradeCandidate[] = []
      const backfillChunkFloor = mode === 'fast' ? FAST_LOG_CHUNK_SIZE : INITIAL_LOG_CHUNK_SIZE
      const maxBackfillAttempts = mode === 'fast' ? 3 : 8

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

      const pushRecentTradeCandidate = (trade: RecentTradeCandidate) => {
        if (!include_recent_trades || !volumePanel) return
        recentTradeCandidates.push(trade)
        if (recentTradeCandidates.length > tradeLimit * 4) {
          recentTradeCandidates.sort((left, right) =>
            right.timestamp - left.timestamp
            || (right.log_index ?? 0) - (left.log_index ?? 0),
          )
          recentTradeCandidates.length = Math.min(recentTradeCandidates.length, tradeLimit * 2)
        }
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
              token0Decimals: resolvedToken0Decimals,
              token1Decimals: resolvedToken1Decimals,
            })
            if (!sample) continue

            latestTimestamp = Math.max(latestTimestamp, timestamp)
            earliestObservedTimestamp = Math.min(earliestObservedTimestamp, timestamp)
            totalSamples += 1

            const bucketTimestamp = Math.floor(timestamp / intervalSeconds) * intervalSeconds

            for (const baseSide of ['token0', 'token1'] as BaseTokenSide[]) {
              const projected = projectPriceSample(sample, baseSide)
              if (!projected) continue

              const bucket = getOrCreateBucket(bucketsByBase[baseSide], bucketTimestamp)
              if (bucket.open === null) bucket.open = projected.price
              bucket.high = bucket.high === null ? projected.price : Math.max(bucket.high, projected.price)
              bucket.low = bucket.low === null ? projected.price : Math.min(bucket.low, projected.price)
              bucket.close = projected.price
              bucket.base_volume += projected.baseVolume
              bucket.quote_volume += projected.quoteVolume
              bucket.sample_count += 1

              totalVolumesByBase[baseSide].base += projected.baseVolume
              totalVolumesByBase[baseSide].quote += projected.quoteVolume
            }

            if (sample.kind === 'swap') {
              const counterparties = getTradeCounterparties(source as EvmOhlcSource, log)
              pushRecentTradeCandidate({
                timestamp,
                timestamp_human: formatTimestamp(timestamp),
                tx_hash: log.transactionHash,
                log_index: log.logIndex,
                sender: counterparties.sender,
                recipient: counterparties.recipient,
                priceToken1PerToken0: sample.priceToken1PerToken0,
                token0Volume: sample.token0Volume,
                token1Volume: sample.token1Volume,
                token0Delta: sample.token0Delta,
                token1Delta: sample.token1Delta,
              })
            }
          }
        })

        if (rangeProcessed > 0) chunksFetched += 1
      }

      if (paginationCursor) {
        await accumulateRange(scannedFromBlock, endBlock, {
          pageStartTimestamp: seriesStartTimestamp,
          pageEndExclusive: seriesEndExclusive,
        })
      } else {
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
      while (earliestObservedBelowPageEnd > seriesStartTimestamp && scannedFromBlock > 0 && backfillAttempts < maxBackfillAttempts) {
        const observedSeconds = Math.max(1, Math.max(latestTimestamp, seriesEndExclusive - intervalSeconds) - earliestObservedBelowPageEnd)
        const observedBlocks = Math.max(1, endBlock - earliestObservedBlock + 1)
        const missingSeconds = earliestObservedBelowPageEnd - seriesStartTimestamp
        const estimatedBlocksNeeded = Math.ceil((observedBlocks / observedSeconds) * missingSeconds * 2)
        const extensionSize = Math.max(backfillChunkFloor, estimatedBlocksNeeded)
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

      const buildOhlcSeries = (baseSide: BaseTokenSide): OhlcRow[] => Array.from({ length: expectedBuckets }, (_, bucketIndex) => {
        const bucketTimestamp = seriesStartTimestamp + bucketIndex * intervalSeconds
        const bucket = bucketsByBase[baseSide].get(bucketTimestamp)
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

      const ohlcByBase = {
        token0: buildOhlcSeries('token0'),
        token1: buildOhlcSeries('token1'),
      } satisfies Record<BaseTokenSide, OhlcRow[]>

      const token0Values = ohlcByBase.token0
        .flatMap((bucket) => [bucket.open, bucket.high, bucket.low, bucket.close])
        .filter((value): value is number => value !== null)
      const token1Values = ohlcByBase.token1
        .flatMap((bucket) => [bucket.open, bucket.high, bucket.low, bucket.close])
        .filter((value): value is number => value !== null)
      const orientation = resolvePriceOrientation({
        requestedPriceIn: price_in,
        legacyBaseToken: base_token,
        token0Label,
        token1Label,
        token0Values,
        token1Values,
      })
      const baseTokenSide = orientation.baseTokenSide
      const quoteTokenSide = orientation.quoteTokenSide
      const baseLabel = baseTokenSide === 'token0' ? token0Label : token1Label
      const quoteLabel = quoteTokenSide === 'token0' ? token0Label : token1Label
      const ohlc = ohlcByBase[baseTokenSide]
      const priceScale = resolvedToken0Decimals !== undefined && resolvedToken1Decimals !== undefined ? 'adjusted' : 'raw_ratio'
      const totalBaseVolume = totalVolumesByBase[baseTokenSide].base
      const totalQuoteVolume = totalVolumesByBase[baseTokenSide].quote
      const priceValues = baseTokenSide === 'token0' ? token0Values : token1Values
      const priceValueFormat = inferPriceValueFormat(priceValues)
      const maxObservedVolume = Math.max(Math.abs(totalBaseVolume), Math.abs(totalQuoteVolume))
      const volumeValueFormat: TableValueFormat =
        maxObservedVolume >= 1e15 ? 'scientific' : maxObservedVolume >= 100_000 ? 'compact_number' : 'decimal'
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
      const recentTrades = volumePanel && include_recent_trades
        ? recentTradeCandidates
          .sort((left, right) =>
            right.timestamp - left.timestamp
            || (right.log_index ?? 0) - (left.log_index ?? 0),
          )
          .slice(0, tradeLimit)
          .map((trade) => buildRecentTradeRow(trade, baseTokenSide, baseLabel, quoteLabel))
        : []
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
                mode: mode as OhlcMode,
                price_in: price_in as PriceDisplayMode,
                base_token: baseTokenSide,
                include_recent_trades,
                recent_trades_limit: tradeLimit,
                ...(normalizedCurrency0Address ? { currency0_address: normalizedCurrency0Address } : {}),
                ...(normalizedCurrency1Address ? { currency1_address: normalizedCurrency1Address } : {}),
                ...(fee !== undefined ? { fee } : {}),
                ...(tick_spacing !== undefined ? { tick_spacing } : {}),
                ...(normalizedHooksAddress !== ZERO_ADDRESS ? { hooks_address: normalizedHooksAddress } : {}),
                ...(resolvedToken0Symbol ? { token0_symbol: resolvedToken0Symbol } : {}),
                ...(resolvedToken1Symbol ? { token1_symbol: resolvedToken1Symbol } : {}),
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
      if (mode === 'fast') {
        notices.push('fast mode prioritizes a quicker preview with lighter historical backfill. Switch to deep if you want the tool to work harder on filling the full window.')
      }
      if (isReserveSyncSource(source as EvmOhlcSource)) {
        notices.push('Sync-derived candles provide reserve-ratio prices only. base_volume and quote_volume stay 0 because Sync events do not expose traded amounts.')
        notices.push('If the pool also emits Swap events, prefer uniswap_v2_swap for factual trade prices, volumes, and a recent trade tape.')
      }
      if (source === 'uniswap_v2_swap') {
        notices.push('Uniswap v2-style swap candles use actual Swap event amounts, so the chart and recent trade tape reflect executed trades rather than reserve snapshots.')
      }
      if (source === 'aerodrome_slipstream_swap') {
        notices.push('Aerodrome Slipstream candles are decoded from its concentrated-liquidity Swap event shape, which is adapted from Uniswap V3.')
      }
      if (source === 'uniswap_v4_swap') {
        notices.push('Uniswap v4 candles are filtered on the PoolManager Swap event by pool_id rather than a per-pool contract address.')
        if (!normalizedCurrency0Address || !normalizedCurrency1Address) {
          notices.push('pool_id is a one-way hash. Pass currency0_address/currency1_address or token symbols if you want clearer token labeling.')
        }
        if (v4MetadataResolutionStatus === 'timeout') {
          notices.push('Skipped the optional Initialize-event metadata lookup after a short timeout. Candles still come from factual Swap events, but labels may stay generic unless you pass the pool key or token metadata.')
        } else if (v4MetadataResolutionStatus === 'failed') {
          notices.push('Skipped the optional Initialize-event metadata enrichment after an upstream lookup error. Candles still come from factual Swap events.')
        } else if (v4MetadataResolutionStatus === 'not_found') {
          notices.push('Did not resolve Initialize-event metadata within the bounded recent lookup budget. Pass the pool key or token metadata if you want richer labels.')
        }
        if (derivedPoolIdFromKey) {
          notices.push('pool_id was derived from the provided Uniswap v4 pool key.')
        }
        if (resolvedV4Metadata) {
          notices.push('Resolved missing Uniswap v4 pool metadata from the on-chain Initialize event so labels and pricing stay factual.')
        }
      }
      if (price_in === 'auto') {
        notices.push(orientation.reason)
      }
      if (include_recent_trades && !volumePanel) {
        notices.push('Recent trade tape is unavailable for Sync-derived reserve snapshots because those events do not carry per-trade amounts.')
      }
      if (nextCursor) {
        notices.push('Older candles are available via _pagination.next_cursor.')
      }

      const recommendedNextSteps: string[] = []
      const querySuggestions: GuidanceQuerySuggestion[] = []

      if (priceScale === 'raw_ratio') {
        recommendedNextSteps.push('Pass token0_decimals and token1_decimals, or token addresses that map to known metadata, so prices render in human units.')
      }

      if (source === 'uniswap_v2_sync') {
        recommendedNextSteps.push('Use swap-derived candles when available if you want actual traded amounts, trade tape rows, and executed-price candles instead of reserve snapshots.')
        querySuggestions.push({
          label: 'Retry with swap-derived candles',
          reason: 'Swap events carry traded token amounts and produce a more chart-friendly tape than Sync events.',
          input: {
            source: 'uniswap_v2_swap',
            include_recent_trades: true,
          },
        })
      }

      if (mode === 'deep' && (chunksFetched >= 3 || backfillAttempts > 0)) {
        recommendedNextSteps.push('If you mainly need a fast preview chart, rerun with mode=fast to reduce extra backfill work.')
        querySuggestions.push({
          label: 'Retry in fast mode',
          reason: 'Fast mode uses lighter backfill and shallower v4 metadata lookups for quicker previews.',
          input: {
            mode: 'fast',
          },
        })
      }

      if (mode === 'fast' && (!gapDiagnostics.window_complete || gapDiagnostics.coverage_gap_likely_bucket_count > 0 || backfillAttempts > 0)) {
        recommendedNextSteps.push('Rerun in deep mode if you want the tool to spend more effort filling likely gaps near the start of the requested window.')
        querySuggestions.push({
          label: 'Retry in deep mode',
          reason: 'Deep mode expands backfill further when the quick preview still looks partial.',
          input: {
            mode: 'deep',
          },
        })
      }

      if (source === 'uniswap_v4_swap' && (!resolvedToken0Symbol || !resolvedToken1Symbol)) {
        recommendedNextSteps.push('Pass explicit token0_symbol and token1_symbol if you want cleaner labels than raw addresses on a Uniswap v4 pool.')
      }

      const guidance = {
        recommended_mode:
          !gapDiagnostics.window_complete || gapDiagnostics.coverage_gap_likely_bucket_count > 0
            ? 'deep'
            : chunksFetched >= 3 || backfillAttempts > 0
              ? 'fast'
              : mode,
        recommended_next_steps: recommendedNextSteps,
        query_suggestions: querySuggestions,
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
        mode,
        price_in_requested: price_in,
        price_in_resolved: quoteTokenSide,
        price_orientation_reason: orientation.reason,
        token0_label: token0Label,
        token1_label: token1Label,
        base_token: baseLabel,
        quote_token: quoteLabel,
        pair_label: `${baseLabel}/${quoteLabel}`,
        venue_label:
          source === 'uniswap_v4_swap'
            ? 'Uniswap v4'
            : source === 'uniswap_v3_swap'
              ? 'Uniswap v3'
              : source === 'uniswap_v2_swap'
                ? 'Uniswap v2-style CPMM'
              : source === 'aerodrome_slipstream_swap'
                ? 'Aerodrome Slipstream'
                : 'Sync-derived CPMM',
        base_token_side: baseTokenSide,
        quote_token_side: quoteTokenSide,
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
        recent_trades_count: recentTrades.length,
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
        ...(resolvedV4Metadata?.initialized_block !== undefined ? { pool_initialized_block: resolvedV4Metadata.initialized_block } : {}),
        ...(resolvedV4Metadata?.initialized_timestamp !== undefined ? { pool_initialized_timestamp: resolvedV4Metadata.initialized_timestamp } : {}),
        ...(chunksFetched > 1 ? { chunks_fetched: chunksFetched } : {}),
        ...(backfillAttempts > 0 ? { backfill_attempts: backfillAttempts } : {}),
      }

      const marketContext = {
        pair: {
          label: summary.pair_label,
          base_token: baseLabel,
          quote_token: quoteLabel,
          base_token_side: baseTokenSide,
          quote_token_side: quoteTokenSide,
          token0_label: token0Label,
          token1_label: token1Label,
          ...(effectiveToken0Address ? { token0_address: effectiveToken0Address } : {}),
          ...(effectiveToken1Address ? { token1_address: effectiveToken1Address } : {}),
          ...(resolvedToken0Decimals !== undefined ? { token0_decimals: resolvedToken0Decimals } : {}),
          ...(resolvedToken1Decimals !== undefined ? { token1_decimals: resolvedToken1Decimals } : {}),
        },
        venue: {
          label: summary.venue_label,
          source,
          source_family: sourceFamily,
          price_method: priceMethod,
        },
        query: {
          mode,
          recommended_mode: guidance.recommended_mode,
        },
        price: {
          unit: summary.price_unit,
          value_format: priceValueFormat,
          requested_quote_side: price_in,
          resolved_quote_side: quoteTokenSide,
          orientation_reason: orientation.reason,
          ...(summary.series_open !== undefined ? { series_open: summary.series_open } : {}),
          ...(summary.series_close !== undefined ? { series_close: summary.series_close } : {}),
          ...(summary.latest_open !== undefined ? { latest_open: summary.latest_open } : {}),
          ...(summary.latest_high !== undefined ? { latest_high: summary.latest_high } : {}),
          ...(summary.latest_low !== undefined ? { latest_low: summary.latest_low } : {}),
          ...(summary.latest_close !== undefined ? { latest_close: summary.latest_close } : {}),
          ...(summary.series_high !== undefined ? { series_high: summary.series_high } : {}),
          ...(summary.series_low !== undefined ? { series_low: summary.series_low } : {}),
          ...(summary.price_change_abs !== undefined ? { change_abs: summary.price_change_abs } : {}),
          ...(summary.price_change_pct !== undefined ? { change_pct: summary.price_change_pct } : {}),
        },
        volume: {
          available: volumePanel,
          value_format: volumeValueFormat,
          base_unit: baseLabel,
          quote_unit: quoteLabel,
          total_base_volume: summary.total_base_volume,
          total_quote_volume: summary.total_quote_volume,
          ...(summary.latest_bucket_volume !== undefined ? { latest_bucket_volume: summary.latest_bucket_volume } : {}),
        },
        pool: {
          ...(normalizedPoolAddress ? { contract_address: normalizedPoolAddress } : {}),
          ...(normalizedPoolManagerAddress ? { pool_manager_address: normalizedPoolManagerAddress } : {}),
          ...(normalizedPoolId ? { pool_id: normalizedPoolId } : {}),
          ...(normalizedCurrency0Address ? { currency0_address: normalizedCurrency0Address } : {}),
          ...(normalizedCurrency1Address ? { currency1_address: normalizedCurrency1Address } : {}),
          ...(fee !== undefined ? { fee } : {}),
          ...(tick_spacing !== undefined ? { tick_spacing } : {}),
          ...(normalizedHooksAddress !== ZERO_ADDRESS ? { hooks_address: normalizedHooksAddress } : {}),
          metadata_resolution_status: v4MetadataResolutionStatus,
          metadata_resolved_from_initialize: Boolean(resolvedV4Metadata),
          ...(resolvedV4Metadata?.initialized_block !== undefined ? { initialized_block: resolvedV4Metadata.initialized_block } : {}),
          ...(resolvedV4Metadata?.initialized_timestamp !== undefined ? { initialized_timestamp: resolvedV4Metadata.initialized_timestamp } : {}),
        },
        trade_tape: {
          included: include_recent_trades && volumePanel,
          returned_trades: recentTrades.length,
          limit: tradeLimit,
        },
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
          ...(recentTrades.length > 0
            ? [buildTablePanel({
                id: 'recent-trades-table',
                kind: 'table_panel',
                title: 'Recent trades',
                subtitle: 'Newest swap events in descending time order for a Dexscreener-style tape.',
                table_id: 'recent_trades',
              })]
            : []),
        ],
        follow_up_actions: [
          ...(nextCursor ? [{ label: 'Load older candles', intent: 'continue' as const, target: '_pagination.next_cursor' }] : []),
          { label: 'Show raw candle rows', intent: 'show_raw', target: 'ohlc' },
          ...(recentTrades.length > 0 ? [{ label: 'Show recent trades', intent: 'show_raw' as const, target: 'recent_trades' }] : []),
          { label: 'Zoom into the latest move', intent: 'zoom_in', target: 'chart' },
        ],
      })

      const result = formatResult(
        {
          summary,
          market_context: marketContext,
          guidance,
          chart: buildCandlestickChart({
            dataKey: 'ohlc',
            interval: resolvedInterval,
            totalCandles: ohlc.length,
            title: `${summary.pair_label} ${summary.venue_label} candles`,
            subtitle: `Price chart with volume histogram over ${duration} using ${resolvedInterval} buckets`,
            volumePanel,
            ...(volumePanel ? { volumeField: 'base_volume', volumeUnit: baseLabel } : {}),
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
            ...(recentTrades.length > 0
              ? [buildTableDescriptor({
                  id: 'recent_trades',
                  dataKey: 'recent_trades',
                  rowCount: recentTrades.length,
                  title: `${summary.pair_label} recent trades`,
                  subtitle: 'Newest trades first, ready for a lower trade tape panel.',
                  keyField: 'tx_hash',
                  defaultSort: { key: 'timestamp', direction: 'desc' },
                  dense: true,
                  columns: [
                    { key: 'timestamp_human', label: 'Time', kind: 'time', format: 'timestamp_human' },
                    { key: 'side', label: 'Side', kind: 'dimension' },
                    { key: 'price', label: 'Price', kind: 'metric', format: priceValueFormat, unit: summary.price_unit, align: 'right' },
                    { key: 'base_amount', label: `${baseLabel} amount`, kind: 'metric', format: volumeValueFormat, unit: baseLabel, align: 'right' },
                    { key: 'quote_amount', label: `${quoteLabel} amount`, kind: 'metric', format: volumeValueFormat, unit: quoteLabel, align: 'right' },
                    { key: 'sender', label: 'Sender', kind: 'dimension', format: 'address' },
                    { key: 'tx_hash', label: 'Tx hash', kind: 'dimension', format: 'address' },
                  ],
                })]
              : []),
          ],
          gap_diagnostics: gapDiagnostics,
          ohlc,
          recent_trades: recentTrades,
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
            mode,
            interval: resolvedInterval,
            duration,
            from_block: scannedFromBlock,
            to_block: endBlock,
            range_kind: resolvedWindow.range_kind,
            notes: [
              `Execution mode: ${mode}.`,
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
            answer_sequence: ['market_context.price.latest_close', 'summary.total_base_volume', 'summary.total_quote_volume', 'summary.filled_buckets', 'ohlc', 'recent_trades'],
            parser_notes: [
              'Use _llm.metric_cards and primary_preview for the headline price before scanning rows.',
              'Check _coverage and gap_diagnostics before claiming the window is complete.',
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

      if (responseCacheKey) {
        evmOhlcResponseCache.set(responseCacheKey, { key: responseCacheKey, response: result }, estimateSize(result))
      }

      return result
    },
  )
}
