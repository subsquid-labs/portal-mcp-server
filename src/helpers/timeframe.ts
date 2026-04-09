// Timeframe parsing for ergonomic queries
// Converts "24h", "7d" etc. into block numbers using Portal's /timestamps/ API
// Falls back to per-chain block time estimation when the endpoint is unavailable.

import { getBlockHead } from '../cache/datasets.js'
import { PORTAL_URL } from '../constants/index.js'
import { detectChainType } from './chain.js'
import { formatTimestamp } from './formatting.js'
import { portalFetch, portalFetchStream } from './fetch.js'

export type Timeframe = '1h' | '6h' | '12h' | '24h' | '3d' | '7d' | '14d' | '30d'

// ---------------------------------------------------------------------------
// Block time estimates
// ---------------------------------------------------------------------------

/**
 * Block time estimates (seconds) by chain type — used as fallback when
 * the /timestamps/ endpoint fails or is known to be down.
 */
const BLOCK_TIME_ESTIMATES: Record<string, number> = {
  evm: 12, // Ethereum mainnet default (~12s)
  solana: 0.4, // Solana slots (~400ms)
  bitcoin: 600, // Bitcoin (~10 min)
  hyperliquidFills: 0.083, // ~12 blocks/second
  hyperliquidReplicaCmds: 0.083,
}

/**
 * More specific block time estimates for known fast chains.
 * Checked by dataset name prefix before falling back to chain-type defaults.
 */
const DATASET_BLOCK_TIMES: Record<string, number> = {
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
}

export type ParsedTimestampInput = {
  timestamp: number
  source: 'unix_seconds' | 'unix_milliseconds' | 'iso_datetime' | 'relative' | 'keyword'
  normalized_input: string
}

export interface BlockAtTimestampResult extends ParsedTimestampInput {
  block_number: number
  dataset: string
  resolution: 'exact' | 'estimated'
  timestamp_human: string
  head_block_number?: number
  head_timestamp?: number
  head_timestamp_human?: string
  estimated_block_time_seconds?: number
}

export function estimateBlockTime(dataset: string, chainType: string): number {
  const lower = dataset.toLowerCase()
  for (const [prefix, blockTime] of Object.entries(DATASET_BLOCK_TIMES)) {
    if (lower.startsWith(prefix)) return blockTime
  }
  return BLOCK_TIME_ESTIMATES[chainType] ?? 12
}

function estimateFromBlock(latestBlock: number, seconds: number, dataset: string, chainType: string) {
  const blockTime = estimateBlockTime(dataset, chainType)
  const blockCount = Math.floor(seconds / blockTime)
  return {
    from_block: Math.max(0, latestBlock - blockCount + 1),
    to_block: latestBlock,
  }
}

// ---------------------------------------------------------------------------
// Timestamp endpoint failure cache
// ---------------------------------------------------------------------------
// The Portal /timestamps/ endpoint can lag ~1-2h behind the chain head.
// When it fails for a dataset, we cache that failure to skip the attempt
// entirely on subsequent calls (avoiding wasted retries + timeout).

const TIMESTAMP_FAILURE_TTL = 5 * 60 * 1000 // 5 minutes
const timestampFailures = new Map<string, number>() // dataset → failure timestamp

function isTimestampEndpointDown(dataset: string): boolean {
  const failedAt = timestampFailures.get(dataset)
  if (!failedAt) return false
  if (Date.now() - failedAt > TIMESTAMP_FAILURE_TTL) {
    timestampFailures.delete(dataset)
    return false
  }
  return true
}

function markTimestampEndpointDown(dataset: string): void {
  timestampFailures.set(dataset, Date.now())
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
  const match = timeframe.match(/^(\d+)([mhd])$/)
  if (!match) {
    throw new Error(`Invalid timeframe format: ${timeframe}. Use format like "1h", "24h", "7d"`)
  }

  const value = parseInt(match[1])
  const unit = match[2]

  switch (unit) {
    case 'm':
      return value * 60
    case 'h':
      return value * 3600
    case 'd':
      return value * 86400
    default:
      throw new Error(`Invalid timeframe unit: ${unit}`)
  }
}

// ---------------------------------------------------------------------------
// Timestamp-to-block conversion
// ---------------------------------------------------------------------------

/** Timeout for the /timestamps/ endpoint — fast-fail since we have a fallback. */
const TIMESTAMP_TIMEOUT = 3000

/**
 * The Portal /timestamps/ endpoint can't resolve timestamps within ~2h of the
 * chain head (the indexer lags behind). Skip the attempt entirely for
 * timeframes shorter than this threshold — go straight to estimation.
 */
const TIMESTAMP_INDEXER_LAG = 2 * 3600 // 2 hours in seconds

/**
 * Convert a Unix timestamp to a block number using Portal's /timestamps/ endpoint.
 * Works for all EVM, Solana, and Bitcoin chains. NOT supported for Hyperliquid.
 *
 * Uses a short timeout and zero retries — the caller should fall back to
 * block time estimation on failure.
 */
export async function timestampToBlock(dataset: string, timestamp: number): Promise<number> {
  const result = await portalFetch<{ block_number: number }>(
    `${PORTAL_URL}/datasets/${dataset}/timestamps/${Math.floor(timestamp)}/block`,
    { timeout: TIMESTAMP_TIMEOUT, retries: 0 },
  )
  return result.block_number
}

/**
 * Get the head block's timestamp by querying Portal for the actual block data.
 */
export async function getHeadTimestamp(dataset: string, headBlock: number): Promise<number> {
  const chainType = detectChainType(dataset)

  // Determine the query type and field key based on chain type
  let type: string
  let fieldKey: string
  switch (chainType) {
    case 'solana':
      type = 'solana'
      fieldKey = 'slot'
      break
    case 'bitcoin':
      type = 'bitcoin'
      fieldKey = 'block'
      break
    default:
      type = 'evm'
      fieldKey = 'block'
  }

  const query = {
    type,
    fromBlock: headBlock,
    toBlock: headBlock,
    includeAllBlocks: true,
    fields: {
      [fieldKey]: {
        number: true,
        timestamp: true,
      },
    },
  }

  const response = await portalFetchStream(
    `${PORTAL_URL}/datasets/${dataset}/stream`,
    query,
    TIMESTAMP_TIMEOUT,
  )

  if (!response || response.length === 0) {
    throw new Error(`Could not get timestamp for head block ${headBlock}`)
  }

  const block = (response[0] as any).header || response[0]
  return block.timestamp
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

  const relativeMatch = normalized.match(/^(\d+)\s*([smhdw])(?:\s+ago)?$/)
  if (!relativeMatch) {
    return undefined
  }

  const value = parseInt(relativeMatch[1], 10)
  const unit = relativeMatch[2]
  const secondsPerUnit: Record<string, number> = {
    s: 1,
    m: 60,
    h: 3600,
    d: 86400,
    w: 604800,
  }

  return {
    timestamp: Math.max(0, nowUnix - value * secondsPerUnit[unit]),
    source: 'relative',
    normalized_input: `${value}${unit} ago`,
  }
}

export function parseTimestampInput(input: string | number, nowUnix: number = Math.floor(Date.now() / 1000)): ParsedTimestampInput {
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
    `Invalid timestamp input: ${trimmed}. Use Unix seconds, Unix milliseconds, ISO datetime, or relative input like "1h ago".`,
  )
}

export async function resolveBlockAtTimestamp(dataset: string, input: string | number): Promise<BlockAtTimestampResult> {
  const parsed = parseTimestampInput(input)

  try {
    const blockNumber = await timestampToBlock(dataset, parsed.timestamp)
    return {
      ...parsed,
      block_number: blockNumber,
      dataset,
      resolution: 'exact',
      timestamp_human: formatTimestamp(parsed.timestamp),
    }
  } catch {
    const head = await getBlockHead(dataset)
    const headTimestamp = await getHeadTimestamp(dataset, head.number)
    const chainType = detectChainType(dataset)
    const estimatedBlockTimeSeconds = estimateBlockTime(dataset, chainType)
    const deltaSeconds = Math.max(0, headTimestamp - parsed.timestamp)
    const estimatedOffset = Math.round(deltaSeconds / estimatedBlockTimeSeconds)
    const estimatedBlockNumber = parsed.timestamp >= headTimestamp ? head.number : Math.max(0, head.number - estimatedOffset)

    return {
      ...parsed,
      block_number: estimatedBlockNumber,
      dataset,
      resolution: 'estimated',
      timestamp_human: formatTimestamp(parsed.timestamp),
      head_block_number: head.number,
      head_timestamp: headTimestamp,
      head_timestamp_human: formatTimestamp(headTimestamp),
      estimated_block_time_seconds: estimatedBlockTimeSeconds,
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
 * 1. Hyperliquid → always estimate (no /timestamps/ support)
 * 2. Short timeframes (≤ 2h) → always estimate (indexer can't resolve recent timestamps)
 * 3. Cached failure for this dataset → estimate (avoid known-broken endpoint)
 * 4. Otherwise → try /timestamps/ with fast timeout (3s, 0 retries)
 *    - On success → return accurate block range
 *    - On failure → cache failure for 5 min, return estimated range
 */
export async function resolveTimeframeOrBlocks(params: {
  dataset: string
  timeframe?: string
  from_block?: number
  to_block?: number
}): Promise<{ from_block: number; to_block: number }> {
  const { dataset, timeframe, from_block, to_block } = params

  if (timeframe) {
    const head = await getBlockHead(dataset)
    const latestBlock = head.number
    const chainType = detectChainType(dataset)
    const seconds = parseTimeframeToSeconds(timeframe)

    const useEstimation =
      chainType === 'hyperliquidFills' ||
      chainType === 'hyperliquidReplicaCmds' ||
      seconds <= TIMESTAMP_INDEXER_LAG ||
      isTimestampEndpointDown(dataset)

    if (useEstimation) {
      return estimateFromBlock(latestBlock, seconds, dataset, chainType)
    }

    // Timeframe is long enough that the target timestamp should be indexed.
    // Try the accurate /timestamps/ path with fast-fail.
    try {
      const headTimestamp = await getHeadTimestamp(dataset, latestBlock)
      const targetTimestamp = headTimestamp - seconds
      const fromBlock = await timestampToBlock(dataset, targetTimestamp)
      markTimestampEndpointUp(dataset)
      return {
        from_block: fromBlock,
        to_block: latestBlock,
      }
    } catch {
      // Cache the failure so subsequent calls skip straight to estimation
      markTimestampEndpointDown(dataset)
      return estimateFromBlock(latestBlock, seconds, dataset, chainType)
    }
  } else if (from_block !== undefined) {
    return {
      from_block,
      to_block: to_block || from_block + 1000,
    }
  }

  throw new Error("Either 'timeframe' or 'from_block' must be provided")
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

Supported: 1h, 6h, 12h, 24h, 3d, 7d, 14d, 30d`
}
