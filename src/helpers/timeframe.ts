// Timeframe parsing for ergonomic queries
// Converts "24h", "7d" etc. into block numbers using Portal's /timestamps/ API
// Falls back to per-chain block time estimation when the endpoint is unavailable.

import { getBlockHead, getDatasetMetadata } from '../cache/datasets.js'
import { PORTAL_URL } from '../constants/index.js'
import { detectChainType } from './chain.js'
import { ActionableError } from './errors.js'
import { portalFetch, portalFetchStream } from './fetch.js'
import { formatTimestamp } from './format.js'
import { assertWindowWithinGuardrail } from './guardrails.js'

export type Timeframe = '1h' | '6h' | '12h' | '24h' | '3d' | '7d' | '14d' | '30d'
export type TimestampInput = string | number

// ---------------------------------------------------------------------------
// Block time estimates
// ---------------------------------------------------------------------------

/**
 * Block time estimates (seconds) by chain type — used as fallback when
 * the /timestamps/ endpoint fails or is known to be down.
 */
const BLOCK_TIME_ESTIMATES: Record<string, number> = {
  evm: 12, // Ethereum mainnet default (~12s)
  tron: 3, // Tron blocks (~3s)
  solana: 0.4, // Solana slots (~400ms)
  bitcoin: 600, // Bitcoin (~10 min)
  substrate: 6, // Polkadot-family default (~6s)
  hyperliquidFills: 0.083, // ~12 blocks/second
  hyperliquidReplicaCmds: 0.083,
}

/**
 * More specific block time estimates for known fast chains.
 * Checked by dataset name prefix before falling back to chain-type defaults.
 */
const DATASET_BLOCK_TIMES: Record<string, number> = {
  'base-mainnet': 0.2, // Current canonical block cadence since Denim.
  'base-sepolia': 0.2,
  'base-': 2,
  'monad-': 0.4,
  'optimism-': 2,
  'arbitrum-': 0.25,
  'polygon-': 2,
  'bsc-': 3,
  'avalanche-': 2,
  'fantom-': 1,
  'gnosis-': 5,
  'zksync-': 1,
  'linea-': 2,
  'scroll-': 3,
  'blast-': 2,
  'mantle-': 2,
  'mode-': 2,
  'zora-': 2,
  'celo-': 5,
  polkadot: 6,
  kusama: 6,
  westend: 6,
  rococo: 6,
  'asset-hub-polkadot': 6,
  'asset-hub-kusama': 6,
  'people-chain': 6,
  'moonbeam-substrate': 12,
  'moonriver-substrate': 12,
  'moonbase-substrate': 12,
  'astar-substrate': 12,
  'shiden-substrate': 12,
  'shibuya-substrate': 12,
}

// Activation times: https://github.com/base/base/pull/6124 and https://github.com/base/base/pull/5694.
const BASE_DENIM_TIMESTAMPS: Record<string, number> = {
  'base-mainnet': 1_793_901_600,
  'base-sepolia': 1_792_605_600,
}

function assertBaseEstimateWithinCadence(dataset: string, headTimestamp?: number, fromTimestamp?: number): void {
  const activation = BASE_DENIM_TIMESTAMPS[dataset.toLowerCase()]
  if (activation === undefined) return

  if (headTimestamp === undefined || !Number.isFinite(headTimestamp)) {
    throw new ActionableError(
      'SQD cannot estimate a Base time window without the indexed head timestamp.',
      [
        'Retry after the indexed head timestamp becomes available.',
        'Use exact from_block/to_block values if you know the intended block window.',
      ],
      { dataset },
      { code: 'incomplete_result', origin: 'upstream', retryable: true },
    )
  }

  if (fromTimestamp !== undefined && fromTimestamp < activation) {
    throw new ActionableError(
      'SQD cannot estimate a Base time window that reaches before the Denim cadence change.',
      [
        'Retry the same request when timestamp boundaries can be verified.',
        'Use exact from_block/to_block values for historical windows.',
      ],
      { dataset, requested_from_timestamp: fromTimestamp, denim_activation_timestamp: activation },
      { code: 'incomplete_result', origin: 'upstream', retryable: true },
    )
  }
}

export type ParsedTimestampInput = {
  timestamp: number
  source: 'unix_seconds' | 'unix_milliseconds' | 'iso_datetime' | 'relative' | 'keyword'
  normalized_input: string
}

export interface BlockAtTimestampResult extends ParsedTimestampInput {
  block_number: number
  block_timestamp?: number
  block_timestamp_human?: string
  boundary?: 'from' | 'to' | 'nearest'
  dataset: string
  resolution: 'verified_boundary' | 'estimated'
  timestamp_delta_seconds?: number
  timestamp_human: string
  head_block_number?: number
  head_timestamp?: number
  head_timestamp_human?: string
  estimated_block_time_seconds?: number
}

export type EstimatedTimeframeResolution = {
  resolution: 'estimated'
  dataset: string
  from_block: number
  to_block: number
  estimated_block_time_seconds: number
  reason:
    | 'timestamp_endpoint_unsupported'
    | 'timestamp_endpoint_down'
    | 'timestamp_endpoint_unavailable'
    | 'interactive_fast_path'
}

export interface ResolvedBlockWindow {
  from_block: number
  to_block: number
  range_kind: 'timeframe' | 'block_range' | 'timestamp_range'
  from_lookup?: BlockAtTimestampResult
  to_lookup?: BlockAtTimestampResult
  estimated_timeframe?: EstimatedTimeframeResolution
}

export function estimateBlockTime(dataset: string, chainType: string): number {
  const lower = dataset.toLowerCase()
  for (const [prefix, blockTime] of Object.entries(DATASET_BLOCK_TIMES)) {
    if (lower.startsWith(prefix)) return blockTime
  }
  return BLOCK_TIME_ESTIMATES[chainType] ?? 12
}

function estimateFromBlock(
  latestBlock: number,
  seconds: number,
  dataset: string,
  chainType: string,
  reason: EstimatedTimeframeResolution['reason'],
  headTimestamp?: number,
) {
  assertBaseEstimateWithinCadence(
    dataset,
    headTimestamp,
    headTimestamp === undefined ? undefined : headTimestamp - seconds,
  )
  const blockTime = estimateBlockTime(dataset, chainType)
  const blockCount = Math.floor(seconds / blockTime)
  const fromBlock = Math.max(0, latestBlock - blockCount + 1)
  return {
    from_block: fromBlock,
    to_block: latestBlock,
    estimated_timeframe: {
      resolution: 'estimated' as const,
      dataset,
      from_block: fromBlock,
      to_block: latestBlock,
      estimated_block_time_seconds: blockTime,
      reason,
    },
  }
}

// ---------------------------------------------------------------------------
// Timestamp endpoint failure cache
// ---------------------------------------------------------------------------
// The Portal /timestamps/ endpoint can lag ~1-2h behind the chain head.
// Repeated failures are cached so one transient response does not force every
// caller onto estimated windows for the next five minutes.

const TIMESTAMP_FAILURE_TTL = 5 * 60 * 1000 // 5 minutes
const TIMESTAMP_FAILURE_THRESHOLD = 3
const timestampFailures = new Map<string, { failedAt: number; count: number }>()

function isTimestampEndpointDown(dataset: string): boolean {
  const failure = timestampFailures.get(dataset)
  if (!failure) return false
  if (Date.now() - failure.failedAt > TIMESTAMP_FAILURE_TTL) {
    timestampFailures.delete(dataset)
    return false
  }
  return failure.count >= TIMESTAMP_FAILURE_THRESHOLD
}

function markTimestampEndpointDown(dataset: string): void {
  const now = Date.now()
  const previous = timestampFailures.get(dataset)
  timestampFailures.set(dataset, {
    failedAt: now,
    count: previous && now - previous.failedAt <= TIMESTAMP_FAILURE_TTL ? previous.count + 1 : 1,
  })
}

function markTimestampEndpointUp(dataset: string): void {
  timestampFailures.delete(dataset)
}

// ---------------------------------------------------------------------------
// Timeframe parsing
// ---------------------------------------------------------------------------

/**
 * Parse timeframe string to seconds
 */
export function parseTimeframeToSeconds(timeframe: string): number {
  const parsed = parseNaturalDuration(timeframe)
  if (!parsed) {
    throw new Error(
      `Invalid timeframe format: ${timeframe}. Use compact durations like "30m", "1h", "24h", or natural phrases like "past 30 minutes", "in the past 1h", or "in last 38 mins".`,
    )
  }

  return parsed.seconds
}

type ParsedDuration = {
  seconds: number
  canonical: string
}

type DurationUnitInfo = {
  seconds: number
  canonical: 's' | 'm' | 'h' | 'd' | 'w' | 'mo' | 'y'
}

const DURATION_UNITS: Record<string, DurationUnitInfo> = {
  s: { seconds: 1, canonical: 's' },
  sec: { seconds: 1, canonical: 's' },
  secs: { seconds: 1, canonical: 's' },
  second: { seconds: 1, canonical: 's' },
  seconds: { seconds: 1, canonical: 's' },
  m: { seconds: 60, canonical: 'm' },
  min: { seconds: 60, canonical: 'm' },
  mins: { seconds: 60, canonical: 'm' },
  minute: { seconds: 60, canonical: 'm' },
  minutes: { seconds: 60, canonical: 'm' },
  h: { seconds: 3600, canonical: 'h' },
  hr: { seconds: 3600, canonical: 'h' },
  hrs: { seconds: 3600, canonical: 'h' },
  hour: { seconds: 3600, canonical: 'h' },
  hours: { seconds: 3600, canonical: 'h' },
  d: { seconds: 86400, canonical: 'd' },
  day: { seconds: 86400, canonical: 'd' },
  days: { seconds: 86400, canonical: 'd' },
  w: { seconds: 604800, canonical: 'w' },
  wk: { seconds: 604800, canonical: 'w' },
  wks: { seconds: 604800, canonical: 'w' },
  week: { seconds: 604800, canonical: 'w' },
  weeks: { seconds: 604800, canonical: 'w' },
  mo: { seconds: 2592000, canonical: 'mo' },
  mos: { seconds: 2592000, canonical: 'mo' },
  month: { seconds: 2592000, canonical: 'mo' },
  months: { seconds: 2592000, canonical: 'mo' },
  y: { seconds: 31536000, canonical: 'y' },
  yr: { seconds: 31536000, canonical: 'y' },
  yrs: { seconds: 31536000, canonical: 'y' },
  year: { seconds: 31536000, canonical: 'y' },
  years: { seconds: 31536000, canonical: 'y' },
}

function normalizeDurationText(input: string): string {
  return input.trim().toLowerCase().replace(/[,_]/g, ' ').replace(/[–—]/g, '-').replace(/\s+/g, ' ').replace(/\.$/, '')
}

function getDurationExpression(input: string): string {
  let normalized = normalizeDurationText(input)

  const rangeMatch = normalized.match(
    /\b(?:past|last|previous)\s+((?:\d+(?:\.\d+)?|a|an|one|half)(?:\s+an?)?\s*[a-z.]+|[a-z.]+)\b/,
  )
  if (rangeMatch) {
    return rangeMatch[1]
  }

  normalized = normalized
    .replace(/\s+ago$/, '')
    .replace(/^(?:for|over|during|within)\s+(?:the\s+)?/, '')
    .replace(/^the\s+/, '')

  return normalized
}

function parseDurationValue(valueText: string): number {
  switch (valueText) {
    case 'a':
    case 'an':
    case 'one':
      return 1
    case 'half':
      return 0.5
    default:
      return Number(valueText)
  }
}

function formatCanonicalDuration(seconds: number, fallbackUnit: DurationUnitInfo['canonical']): string {
  const units: [DurationUnitInfo['canonical'], number][] = [
    ['y', 31536000],
    ['mo', 2592000],
    ['w', 604800],
    ['d', 86400],
    ['h', 3600],
    ['m', 60],
    ['s', 1],
  ]

  const exact = units.find(([, unitSeconds]) => seconds % unitSeconds === 0)
  if (exact) return `${seconds / exact[1]}${exact[0]}`

  const fallbackSeconds = Object.values(DURATION_UNITS).find((unit) => unit.canonical === fallbackUnit)?.seconds ?? 1
  const value = seconds / fallbackSeconds
  return `${Number.isInteger(value) ? value : Number(value.toFixed(2))}${fallbackUnit}`
}

function parseNaturalDuration(input: string): ParsedDuration | undefined {
  const expression = getDurationExpression(input)
  const durationMatch = expression.match(
    /^(?:(\d+(?:\.\d+)?)|(a|an|one|half))?(?:\s+an?)?\s*(s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?|d|days?|w|wks?|weeks?|mo|mos|months?|y|yrs?|years?)\.?$/,
  )
  if (!durationMatch) {
    return undefined
  }

  const value = parseDurationValue(durationMatch[1] ?? durationMatch[2] ?? '1')
  const unit = DURATION_UNITS[durationMatch[3]]
  if (!Number.isFinite(value) || value <= 0 || !unit) {
    return undefined
  }

  const seconds = Math.max(1, Math.round(value * unit.seconds))
  return {
    seconds,
    canonical: formatCanonicalDuration(seconds, unit.canonical),
  }
}

// ---------------------------------------------------------------------------
// Timestamp-to-block conversion
// ---------------------------------------------------------------------------

/** Timeout for the /timestamps/ endpoint — fast-fail since we have a fallback. */
const TIMESTAMP_TIMEOUT = 2500

/**
 * Convert a Unix timestamp to a block number using Portal's /timestamps/ endpoint.
 * Works for supported Portal datasets, including real-time datasets that expose
 * timestamp lookups.
 *
 * Uses a short timeout and one bounded retry before the caller falls back to
 * block time estimation. The fallback remains explicit in the result
 * provenance while a single retry absorbs normal worker rotation.
 */
function portalTimestampValue(dataset: string, timestamp: number): number {
  const chainType = detectChainType(dataset)
  return chainType === 'hyperliquidFills' || chainType === 'tron' ? Math.floor(timestamp * 1000) : Math.floor(timestamp)
}

export async function timestampToBlock(dataset: string, timestamp: number): Promise<number> {
  const portalTimestamp = portalTimestampValue(dataset, timestamp)
  const result = await portalFetch<{ block_number: number }>(
    `${PORTAL_URL}/datasets/${dataset}/timestamps/${portalTimestamp}/block`,
    { timeout: TIMESTAMP_TIMEOUT, retries: 1 },
  )
  return result.block_number
}

/**
 * Read and normalize the timestamp on one indexed block. This is deliberately
 * used to verify /timestamps/ responses before they are described as exact.
 */
export async function getBlockTimestamp(
  dataset: string,
  blockNumber: number,
  options: { retries?: number } = {},
): Promise<number> {
  const chainType = detectChainType(dataset)
  const response = await portalFetchStream(
    `${PORTAL_URL}/datasets/${dataset}/stream`,
    {
      type: chainType,
      fromBlock: blockNumber,
      toBlock: blockNumber,
      includeAllBlocks: true,
      fields: { block: { number: true, timestamp: true } },
    },
    { timeout: TIMESTAMP_TIMEOUT, retries: options.retries ?? 2 },
  )

  if (!response || response.length === 0) {
    throw new Error(`Could not get timestamp for block ${blockNumber}`)
  }

  const block = (response[0] as any).header || response[0]
  const timestamp = Number(block.timestamp)
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    throw new Error(`Could not parse timestamp for block ${blockNumber}`)
  }
  return timestamp > 1_000_000_000_000 ? Math.floor(timestamp / 1000) : Math.floor(timestamp)
}

/**
 * Get the head block's timestamp by querying Portal for the actual block data.
 */
export async function getHeadTimestamp(dataset: string, headBlock: number, retries = 2): Promise<number> {
  return getBlockTimestamp(dataset, headBlock, { retries })
}

function parseRelativeTimestamp(input: string, nowUnix: number): ParsedTimestampInput | undefined {
  const normalized = input.trim().toLowerCase()

  if (normalized === 'now') {
    return {
      timestamp: nowUnix,
      source: 'keyword',
      normalized_input: 'now',
    }
  }

  if (normalized === 'today') {
    const now = new Date(nowUnix * 1000)
    const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) / 1000
    return {
      timestamp: today,
      source: 'keyword',
      normalized_input: 'today',
    }
  }

  if (normalized === 'yesterday') {
    const now = new Date(nowUnix * 1000)
    const yesterday = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) / 1000 - 86400
    return {
      timestamp: yesterday,
      source: 'keyword',
      normalized_input: 'yesterday',
    }
  }

  const dayTimeMatch = normalized.match(/^(today|yesterday)\s+(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?$/)
  if (dayTimeMatch) {
    const [, keyword, hourText, minuteText = '0', secondText = '0'] = dayTimeMatch
    const hour = parseInt(hourText, 10)
    const minute = parseInt(minuteText, 10)
    const second = parseInt(secondText, 10)

    if (hour > 23 || minute > 59 || second > 59) {
      throw new Error(`Invalid time in timestamp input: ${input}. Use HH:MM or HH:MM:SS in 24-hour format.`)
    }

    const now = new Date(nowUnix * 1000)
    const dayOffset = keyword === 'yesterday' ? 86400 : 0
    const dayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) / 1000 - dayOffset

    return {
      timestamp: dayStart + hour * 3600 + minute * 60 + second,
      source: 'keyword',
      normalized_input: `${keyword} ${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}:${second.toString().padStart(2, '0')}`,
    }
  }

  const duration = parseNaturalDuration(normalized)
  if (!duration) {
    return undefined
  }

  return {
    timestamp: Math.max(0, nowUnix - duration.seconds),
    source: 'relative',
    normalized_input: `${duration.canonical} ago`,
  }
}

export function parseTimestampInput(
  input: string | number,
  nowUnix: number = Math.floor(Date.now() / 1000),
): ParsedTimestampInput {
  if (typeof input === 'number' && Number.isFinite(input)) {
    const timestamp = input > 1_000_000_000_000 ? Math.floor(input / 1000) : Math.floor(input)
    return {
      timestamp,
      source: input > 1_000_000_000_000 ? 'unix_milliseconds' : 'unix_seconds',
      normalized_input: String(input),
    }
  }

  const trimmed = String(input).trim()
  if (!trimmed) {
    throw new Error('Timestamp cannot be empty. Use a Unix timestamp, ISO datetime, or relative input like "1h ago".')
  }

  if (/^\d+$/.test(trimmed)) {
    const numericValue = Number(trimmed)
    if (!Number.isFinite(numericValue)) {
      throw new Error(`Invalid numeric timestamp: ${trimmed}`)
    }
    const timestamp = numericValue > 1_000_000_000_000 ? Math.floor(numericValue / 1000) : Math.floor(numericValue)
    return {
      timestamp,
      source: numericValue > 1_000_000_000_000 ? 'unix_milliseconds' : 'unix_seconds',
      normalized_input: trimmed,
    }
  }

  const relative = parseRelativeTimestamp(trimmed, nowUnix)
  if (relative) {
    return relative
  }

  const parsedDate = Date.parse(trimmed)
  if (!Number.isNaN(parsedDate)) {
    return {
      timestamp: Math.floor(parsedDate / 1000),
      source: 'iso_datetime',
      normalized_input: new Date(parsedDate).toISOString(),
    }
  }

  throw new Error(
    `Invalid timestamp input: ${trimmed}. Use Unix seconds, Unix milliseconds, ISO datetime, or relative input like "1h ago", "past 30 minutes", "in the past 1h", or "in last 38 mins".`,
  )
}

export function describeTimeWindowInput(input: string): string {
  const trimmed = input.trim()
  const normalized = trimmed.toLowerCase().replace(/\s+/g, ' ')

  const inPastMatch = normalized.match(/^in\s+(?:the\s+)?past\s+(.+)$/)
  if (inPastMatch) return `the past ${inPastMatch[1]}`

  const inLastMatch = normalized.match(/^in\s+last\s+(.+)$/)
  if (inLastMatch) return `the last ${inLastMatch[1]}`

  const inPreviousMatch = normalized.match(/^in\s+(?:the\s+)?previous\s+(.+)$/)
  if (inPreviousMatch) return `the previous ${inPreviousMatch[1]}`

  if (/^(?:past|last|previous)\s+/.test(normalized)) return `the ${trimmed}`

  return `last ${trimmed}`
}

type TimestampBoundary = 'from' | 'to' | 'nearest'

function boundarySatisfied(boundary: TimestampBoundary, actual: number, target: number): boolean {
  if (boundary === 'from') return actual >= target
  if (boundary === 'to') return actual <= target
  return true
}

async function refineTimestampBoundary(params: {
  dataset: string
  targetTimestamp: number
  initialBlock: number
  startBlock: number
  headBlock: number
  boundary: TimestampBoundary
  retries: number
}): Promise<{ blockNumber: number; blockTimestamp: number }> {
  const { dataset, targetTimestamp, startBlock, headBlock, boundary, retries } = params
  const chainType = detectChainType(dataset)
  const blockTime = estimateBlockTime(dataset, chainType)
  const verificationTolerance = Math.max(2, Math.ceil(blockTime * 2))
  const timestampCache = new Map<number, number>()

  const readTimestamp = async (blockNumber: number) => {
    const cached = timestampCache.get(blockNumber)
    if (cached !== undefined) return cached
    const timestamp = await getBlockTimestamp(dataset, blockNumber, { retries })
    timestampCache.set(blockNumber, timestamp)
    return timestamp
  }

  const readTimestampRange = async (fromBlock: number, toBlock: number) => {
    const response = await portalFetchStream(
      `${PORTAL_URL}/datasets/${dataset}/stream`,
      {
        type: chainType,
        fromBlock,
        toBlock,
        includeAllBlocks: true,
        fields: { block: { number: true, timestamp: true } },
      },
      {
        timeout: TIMESTAMP_TIMEOUT,
        retries,
        maxBlocks: Math.max(1, toBlock - fromBlock + 1),
        maxBytes: 2 * 1024 * 1024,
      },
    )

    return response
      .map((record: any) => record?.header ?? record)
      .map((block: any) => ({
        blockNumber: Number(block?.number),
        blockTimestamp: Number(block?.timestamp),
      }))
      .filter(
        (block) =>
          Number.isFinite(block.blockNumber) && Number.isFinite(block.blockTimestamp) && block.blockTimestamp > 0,
      )
      .map((block) => ({
        blockNumber: Math.floor(block.blockNumber),
        blockTimestamp:
          block.blockTimestamp > 1_000_000_000_000
            ? Math.floor(block.blockTimestamp / 1000)
            : Math.floor(block.blockTimestamp),
      }))
      .sort((left, right) => left.blockNumber - right.blockNumber)
  }

  const findTransition = async (currentBlock: number): Promise<{ blockNumber: number; blockTimestamp: number }> => {
    let span = Math.max(4, Math.ceil(verificationTolerance / blockTime) * 2)

    const rangeFrom = Math.max(startBlock, currentBlock - span)
    const rangeTo = Math.min(headBlock, currentBlock + span)
    try {
      const samples = await readTimestampRange(rangeFrom, rangeTo)
      if (boundary === 'from') {
        const candidateIndex = samples.findIndex((sample) => sample.blockTimestamp >= targetTimestamp)
        if (candidateIndex >= 0) {
          const candidate = samples[candidateIndex]!
          const previous = samples[candidateIndex - 1]
          if ((previous && previous.blockTimestamp < targetTimestamp) || (!previous && rangeFrom === startBlock)) {
            return candidate
          }
        }
      } else {
        let candidateIndex = -1
        for (let index = 0; index < samples.length; index += 1) {
          if (samples[index]!.blockTimestamp <= targetTimestamp) candidateIndex = index
        }
        if (candidateIndex >= 0) {
          const candidate = samples[candidateIndex]!
          const next = samples[candidateIndex + 1]
          if ((next && next.blockTimestamp > targetTimestamp) || (!next && rangeTo === headBlock)) {
            return candidate
          }
        }
      }
    } catch {
      // Fall through to the exact single-block search when the bounded range
      // probe is temporarily unavailable.
    }

    if (boundary === 'from') {
      let high = currentBlock
      let low = Math.max(startBlock, high - span)
      while (low > startBlock && (await readTimestamp(low)) >= targetTimestamp) {
        high = low
        span *= 2
        low = Math.max(startBlock, high - span)
      }
      if ((await readTimestamp(low)) >= targetTimestamp) {
        return { blockNumber: low, blockTimestamp: await readTimestamp(low) }
      }
      while (high - low > 1) {
        const middle = Math.floor((low + high) / 2)
        if ((await readTimestamp(middle)) >= targetTimestamp) high = middle
        else low = middle
      }
      return { blockNumber: high, blockTimestamp: await readTimestamp(high) }
    }

    let low = currentBlock
    let high = Math.min(headBlock, low + span)
    while (high < headBlock && (await readTimestamp(high)) <= targetTimestamp) {
      low = high
      span *= 2
      high = Math.min(headBlock, low + span)
    }
    if ((await readTimestamp(high)) <= targetTimestamp) {
      return { blockNumber: high, blockTimestamp: await readTimestamp(high) }
    }
    while (high - low > 1) {
      const middle = Math.floor((low + high) / 2)
      if ((await readTimestamp(middle)) <= targetTimestamp) low = middle
      else high = middle
    }
    return { blockNumber: low, blockTimestamp: await readTimestamp(low) }
  }

  let blockNumber = Math.max(startBlock, Math.min(headBlock, Math.floor(params.initialBlock)))

  for (let attempt = 0; attempt < 12; attempt += 1) {
    const blockTimestamp = await readTimestamp(blockNumber)
    const deltaSeconds = targetTimestamp - blockTimestamp
    const closeEnough = Math.abs(deltaSeconds) <= verificationTolerance

    if (boundarySatisfied(boundary, blockTimestamp, targetTimestamp) && closeEnough) {
      if (boundary === 'nearest') {
        const candidates = [{ blockNumber, blockTimestamp }]
        for (const neighbor of [blockNumber - 1, blockNumber + 1]) {
          if (neighbor < startBlock || neighbor > headBlock) continue
          try {
            candidates.push({ blockNumber: neighbor, blockTimestamp: await readTimestamp(neighbor) })
          } catch {
            // The verified current block remains a safe fallback when an
            // adjacent block is temporarily unavailable.
          }
        }
        return candidates.sort((left, right) => {
          const leftDelta = Math.abs(left.blockTimestamp - targetTimestamp)
          const rightDelta = Math.abs(right.blockTimestamp - targetTimestamp)
          return leftDelta - rightDelta || left.blockNumber - right.blockNumber
        })[0]
      }

      return findTransition(blockNumber)
    }

    const estimatedStep = Math.round(deltaSeconds / blockTime)
    const signedMinimumStep = deltaSeconds > 0 ? 1 : -1
    const step = estimatedStep === 0 ? signedMinimumStep : estimatedStep
    const nextBlock = Math.max(startBlock, Math.min(headBlock, blockNumber + step))
    if (nextBlock === blockNumber) break
    blockNumber = nextBlock
  }

  throw new Error(`Could not verify ${boundary} timestamp boundary for ${dataset}`)
}

export async function resolveBlockAtTimestamp(
  dataset: string,
  input: string | number,
  options: {
    boundary?: TimestampBoundary
    headBlock?: number
    headTimestamp?: number
    verificationRetries?: number
  } = {},
): Promise<BlockAtTimestampResult> {
  const parsed = parseTimestampInput(input)
  const boundary = options.boundary ?? 'nearest'
  const metadata = await getDatasetMetadata(dataset)
  const headBlock = options.headBlock ?? metadata.head.number
  const verificationRetries = options.verificationRetries ?? 2
  const headTimestamp = options.headTimestamp ?? (await getHeadTimestamp(dataset, headBlock, verificationRetries))
  const chainType = detectChainType(dataset)
  const blockTime = estimateBlockTime(dataset, chainType)
  // "now" is wall-clock based while Portal answers from the indexed head.
  // Allow normal indexing/block-production lag, but reject genuinely future
  // windows instead of silently clamping them to current data.
  const futureTolerance = Math.max(60, Math.ceil(blockTime * 2))

  if (parsed.timestamp > headTimestamp + futureTolerance) {
    throw new ActionableError(
      'The requested timestamp is after the latest indexed block.',
      [
        `Use a timestamp at or before ${formatTimestamp(headTimestamp)}.`,
        'Use portal_get_network_info to inspect current indexing freshness.',
      ],
      {
        requested_timestamp: parsed.timestamp,
        requested_timestamp_human: formatTimestamp(parsed.timestamp),
        indexed_head_block: headBlock,
        indexed_head_timestamp: headTimestamp,
        indexed_head_timestamp_human: formatTimestamp(headTimestamp),
      },
    )
  }

  if (boundary === 'from' && parsed.timestamp > headTimestamp) {
    throw new ActionableError(
      'The requested start timestamp is after the latest indexed block.',
      [
        `Use a start timestamp at or before ${formatTimestamp(headTimestamp)}.`,
        'Use portal_get_network_info to inspect current indexing freshness.',
      ],
      {
        requested_timestamp: parsed.timestamp,
        requested_timestamp_human: formatTimestamp(parsed.timestamp),
        indexed_head_block: headBlock,
        indexed_head_timestamp: headTimestamp,
        indexed_head_timestamp_human: formatTimestamp(headTimestamp),
      },
    )
  }

  if (parsed.timestamp >= headTimestamp) {
    return {
      ...parsed,
      block_number: headBlock,
      block_timestamp: headTimestamp,
      block_timestamp_human: formatTimestamp(headTimestamp),
      boundary,
      dataset,
      resolution: 'verified_boundary',
      timestamp_delta_seconds: headTimestamp - parsed.timestamp,
      timestamp_human: formatTimestamp(parsed.timestamp),
      head_block_number: headBlock,
      head_timestamp: headTimestamp,
      head_timestamp_human: formatTimestamp(headTimestamp),
    }
  }

  try {
    let blockNumber: number
    try {
      blockNumber = await timestampToBlock(dataset, parsed.timestamp)
    } catch {
      const estimatedOffset = Math.round((headTimestamp - parsed.timestamp) / blockTime)
      blockNumber = Math.max(metadata.start_block, headBlock - estimatedOffset)
    }

    const verified = await refineTimestampBoundary({
      dataset,
      targetTimestamp: parsed.timestamp,
      initialBlock: blockNumber,
      startBlock: metadata.start_block,
      headBlock,
      boundary,
      retries: verificationRetries,
    })
    return {
      ...parsed,
      block_number: verified.blockNumber,
      block_timestamp: verified.blockTimestamp,
      block_timestamp_human: formatTimestamp(verified.blockTimestamp),
      boundary,
      dataset,
      resolution: 'verified_boundary',
      timestamp_delta_seconds: verified.blockTimestamp - parsed.timestamp,
      timestamp_human: formatTimestamp(parsed.timestamp),
      head_block_number: headBlock,
      head_timestamp: headTimestamp,
      head_timestamp_human: formatTimestamp(headTimestamp),
    }
  } catch {
    assertBaseEstimateWithinCadence(dataset, headTimestamp, parsed.timestamp)
    const deltaSeconds = Math.max(0, headTimestamp - parsed.timestamp)
    const estimatedOffset = Math.round(deltaSeconds / blockTime)
    const estimatedBlockNumber = Math.max(metadata.start_block, headBlock - estimatedOffset)

    return {
      ...parsed,
      block_number: estimatedBlockNumber,
      boundary,
      dataset,
      resolution: 'estimated',
      timestamp_human: formatTimestamp(parsed.timestamp),
      head_block_number: headBlock,
      head_timestamp: headTimestamp,
      head_timestamp_human: formatTimestamp(headTimestamp),
      estimated_block_time_seconds: blockTime,
    }
  }
}

// ---------------------------------------------------------------------------
// Main resolver
// ---------------------------------------------------------------------------

/**
 * Resolve timeframe to from_block/to_block.
 *
 * Strategy:
 * 1. Datasets without /timestamps/ support → estimate
 * 2. Cached failure for this dataset → estimate (avoid known-broken endpoint)
 * 3. Otherwise → fetch the indexed head timestamp, subtract the timeframe,
 *    and resolve that target through /timestamps/.
 *    - On success → return accurate block range
 *    - On failure → cache failure for 5 min, return estimated range
 */
export async function resolveTimeframeOrBlocks(params: {
  dataset: string
  timeframe?: string
  from_block?: number
  to_block?: number
  from_timestamp?: TimestampInput
  to_timestamp?: TimestampInput
}): Promise<ResolvedBlockWindow> {
  const { dataset, timeframe, from_block, to_block, from_timestamp, to_timestamp } = params
  const hasTimestampWindow = from_timestamp !== undefined || to_timestamp !== undefined
  const hasBlockWindow = from_block !== undefined || to_block !== undefined

  if (hasTimestampWindow && (timeframe || hasBlockWindow)) {
    throw new ActionableError(
      'Use either timeframe, block numbers, or timestamps for the query window.',
      [
        "Use timeframe for relative presets like '1h', 'past 30 minutes', or 'in last 38 mins'.",
        'Use from_block/to_block for exact block windows.',
        "Use from_timestamp/to_timestamp for natural time windows like '1h ago', 'past 30 minutes', or ISO datetimes.",
      ],
      {
        timeframe,
        from_block,
        to_block,
        from_timestamp,
        to_timestamp,
      },
    )
  }

  if (timeframe) {
    const head = await getBlockHead(dataset)
    const latestBlock = head.number
    const chainType = detectChainType(dataset)
    const seconds = parseTimeframeToSeconds(timeframe)
    /* Before the head lookup costs anything upstream. */
    assertWindowWithinGuardrail(seconds)

    const estimationReason = isTimestampEndpointDown(dataset) ? 'timestamp_endpoint_down' : undefined
    let headTimestamp: number | undefined

    if (estimationReason) {
      if (BASE_DENIM_TIMESTAMPS[dataset.toLowerCase()] !== undefined) {
        headTimestamp = await getHeadTimestamp(dataset, latestBlock, 1).catch(() => undefined)
      }
      return {
        ...estimateFromBlock(latestBlock, seconds, dataset, chainType, estimationReason, headTimestamp),
        range_kind: 'timeframe',
      }
    }

    // Real-time datasets expose head block timestamps, so anchor relative
    // windows to the latest indexed block instead of wall-clock time.
    try {
      headTimestamp = await getHeadTimestamp(dataset, latestBlock, 1)
      const targetTimestamp = Math.max(0, headTimestamp - seconds)
      const lookup = await resolveBlockAtTimestamp(dataset, targetTimestamp, {
        boundary: 'from',
        headBlock: latestBlock,
        headTimestamp,
        verificationRetries: 1,
      })
      if (lookup.resolution !== 'verified_boundary') {
        throw new Error(`Could not verify the ${timeframe} boundary for ${dataset}`)
      }
      markTimestampEndpointUp(dataset)
      return {
        from_block: Math.min(lookup.block_number, latestBlock),
        to_block: latestBlock,
        range_kind: 'timeframe',
        from_lookup: { ...lookup, normalized_input: `${timeframe} before indexed head` },
        to_lookup: {
          timestamp: headTimestamp,
          source: 'unix_seconds',
          normalized_input: 'indexed head',
          block_number: latestBlock,
          block_timestamp: headTimestamp,
          block_timestamp_human: formatTimestamp(headTimestamp),
          boundary: 'to',
          dataset,
          resolution: 'verified_boundary',
          timestamp_delta_seconds: 0,
          timestamp_human: formatTimestamp(headTimestamp),
          head_block_number: latestBlock,
          head_timestamp: headTimestamp,
          head_timestamp_human: formatTimestamp(headTimestamp),
        },
      }
    } catch {
      // Cache the failure so subsequent calls skip straight to estimation
      markTimestampEndpointDown(dataset)
      return {
        ...estimateFromBlock(latestBlock, seconds, dataset, chainType, 'timestamp_endpoint_unavailable', headTimestamp),
        range_kind: 'timeframe',
      }
    }
  } else if (hasTimestampWindow) {
    const head = await getBlockHead(dataset)
    const headTimestamp = await getHeadTimestamp(dataset, head.number, 2)
    const [resolvedFrom, resolvedTo] = await Promise.all([
      from_timestamp !== undefined
        ? resolveBlockAtTimestamp(dataset, from_timestamp, {
            boundary: 'from',
            headBlock: head.number,
            headTimestamp,
            verificationRetries: 2,
          })
        : Promise.resolve(undefined),
      to_timestamp !== undefined
        ? resolveBlockAtTimestamp(dataset, to_timestamp, {
            boundary: 'to',
            headBlock: head.number,
            headTimestamp,
            verificationRetries: 2,
          })
        : Promise.resolve(undefined),
    ])

    if (resolvedFrom?.resolution === 'estimated' || resolvedTo?.resolution === 'estimated') {
      throw new ActionableError(
        'SQD could not verify the requested timestamp boundaries against indexed block timestamps.',
        [
          'Retry the same request after the timestamp index catches up.',
          'Use portal_debug_resolve_time_to_block to inspect one boundary.',
          'Use exact from_block/to_block values if you already know the intended block window.',
        ],
        {
          from_timestamp: resolvedFrom?.normalized_input ?? from_timestamp,
          to_timestamp: resolvedTo?.normalized_input ?? to_timestamp,
          from_resolution: resolvedFrom?.resolution,
          to_resolution: resolvedTo?.resolution,
        },
        { code: 'incomplete_result', origin: 'upstream', retryable: true },
      )
    }

    const fromSeconds = resolvedFrom?.timestamp
    const toSeconds = resolvedTo?.timestamp ?? headTimestamp
    if (fromSeconds !== undefined && toSeconds >= fromSeconds) {
      assertWindowWithinGuardrail(toSeconds - fromSeconds)
    }

    const resolvedFromBlock = resolvedFrom?.block_number ?? resolvedTo?.block_number
    const resolvedToBlock = resolvedTo?.block_number ?? head.number

    if (resolvedFromBlock === undefined || resolvedToBlock === undefined) {
      throw new Error('Could not resolve timestamp window to block numbers.')
    }

    if (resolvedFromBlock > resolvedToBlock) {
      throw new ActionableError(
        'from_timestamp resolves after to_timestamp.',
        [
          'Swap the timestamps so from_timestamp is earlier than to_timestamp.',
          'Use portal_debug_resolve_time_to_block first if you want to inspect the resolved block numbers.',
        ],
        {
          from_timestamp: resolvedFrom?.normalized_input ?? from_timestamp,
          to_timestamp: resolvedTo?.normalized_input ?? to_timestamp,
          from_block: resolvedFromBlock,
          to_block: resolvedToBlock,
        },
      )
    }

    return {
      from_block: resolvedFromBlock,
      to_block: resolvedToBlock,
      range_kind: 'timestamp_range',
      ...(resolvedFrom ? { from_lookup: resolvedFrom } : {}),
      ...(resolvedTo ? { to_lookup: resolvedTo } : {}),
    }
  } else if (from_block !== undefined) {
    return {
      from_block,
      to_block: to_block || from_block + 1000,
      range_kind: 'block_range',
    }
  }

  throw new Error('Provide timeframe, from_block, or from_timestamp/to_timestamp to define the query window.')
}

export function getTimestampWindowNotices(window: unknown): string[] {
  const notices: string[] = []
  const typedWindow = (window && typeof window === 'object' ? window : {}) as {
    from_lookup?: BlockAtTimestampResult
    to_lookup?: BlockAtTimestampResult
    estimated_timeframe?: EstimatedTimeframeResolution
  }

  if (typedWindow.estimated_timeframe?.resolution === 'estimated') {
    const reason = {
      timestamp_endpoint_unsupported: 'the timestamp endpoint is not supported for this network',
      timestamp_endpoint_down: 'the timestamp endpoint was recently unavailable for this network',
      timestamp_endpoint_unavailable: 'the exact timestamp lookup failed for this network',
      interactive_fast_path: 'the interactive fast path uses a bounded block-time estimate',
    }[typedWindow.estimated_timeframe.reason]
    notices.push(
      `The timeframe block window was estimated as blocks ${typedWindow.estimated_timeframe.from_block}-${typedWindow.estimated_timeframe.to_block} using a ${typedWindow.estimated_timeframe.estimated_block_time_seconds}s block-time estimate because ${reason}.`,
    )
  }

  if (typedWindow.from_lookup?.resolution === 'estimated') {
    notices.push(
      `from_timestamp (${typedWindow.from_lookup.timestamp_human}) was estimated from the latest indexed block because the exact boundary is not indexed yet.`,
    )
  }

  if (typedWindow.to_lookup?.resolution === 'estimated') {
    notices.push(
      `to_timestamp (${typedWindow.to_lookup.timestamp_human}) was estimated from the latest indexed block because the exact boundary is not indexed yet.`,
    )
  }

  return notices
}

/**
 * Convert timeframe to approximate block count using per-chain block time estimates.
 *
 * @deprecated Use resolveTimeframeOrBlocks() instead for accurate conversion.
 */
export function timeframeToBlocks(timeframe: string, dataset: string): number {
  const seconds = parseTimeframeToSeconds(timeframe)
  const chainType = detectChainType(dataset)
  const blockTime = estimateBlockTime(dataset, chainType)
  return Math.floor(seconds / blockTime)
}

/**
 * Get examples for tool descriptions
 */
export function getTimeframeExamples(): string {
  return `
TIMEFRAME EXAMPLES:
  - "24h" = last 24 hours
  - "7d" = last 7 days
  - "1h" = last hour
  - "past 30 minutes" = last 30 minutes
  - "in the past 1h" = last hour
  - "in last 38 mins" = last 38 minutes

Supported: compact forms like 30m/1h/7d and natural phrases like "past 30 minutes", "last hour", and "in last 38 mins"`
}
