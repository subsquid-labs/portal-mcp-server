// Timeframe parsing for ergonomic queries
// Converts "24h", "7d" etc. into block numbers using Portal's /timestamps/ API

import { getBlockHead } from '../cache/datasets.js'
import { PORTAL_URL } from '../constants/index.js'
import { detectChainType } from './chain.js'
import { portalFetch, portalFetchStream } from './fetch.js'

export type Timeframe = '1h' | '6h' | '12h' | '24h' | '3d' | '7d' | '14d' | '30d'

/**
 * Block time estimates — ONLY used for Hyperliquid (which lacks /timestamps/ endpoint)
 */
const HYPERLIQUID_BLOCK_TIME = 1 // ~1s per block

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

/**
 * Convert a Unix timestamp to a block number using Portal's /timestamps/ endpoint.
 * Works for all EVM, Solana, and Bitcoin chains. NOT supported for Hyperliquid.
 */
export async function timestampToBlock(dataset: string, timestamp: number): Promise<number> {
  const result = await portalFetch<{ block_number: number }>(
    `${PORTAL_URL}/datasets/${dataset}/timestamps/${Math.floor(timestamp)}/block`,
  )
  return result.block_number
}

/**
 * Get the head block's timestamp by querying Portal for the actual block data.
 */
async function getHeadTimestamp(dataset: string, headBlock: number): Promise<number> {
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

  const response = await portalFetchStream(`${PORTAL_URL}/datasets/${dataset}/stream`, query)

  if (!response || response.length === 0) {
    throw new Error(`Could not get timestamp for head block ${headBlock}`)
  }

  const block = (response[0] as any).header || response[0]
  return block.timestamp
}

/**
 * Resolve timeframe to from_block/to_block using Portal's /timestamps/ API.
 *
 * For EVM, Solana, and Bitcoin chains: uses the accurate /timestamps/{ts}/block endpoint.
 * For Hyperliquid: falls back to block time estimation (no /timestamps/ support).
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
    const isHyperliquid = chainType === 'hyperliquidFills' || chainType === 'hyperliquidReplicaCmds'

    if (isHyperliquid) {
      // Hyperliquid: no /timestamps/ endpoint, use estimation
      const seconds = parseTimeframeToSeconds(timeframe)
      const blockCount = Math.floor(seconds / HYPERLIQUID_BLOCK_TIME)
      return {
        from_block: Math.max(0, latestBlock - blockCount + 1),
        to_block: latestBlock,
      }
    }

    // EVM, Solana, Bitcoin: use Portal's /timestamps/ endpoint for accurate conversion
    const seconds = parseTimeframeToSeconds(timeframe)
    const headTimestamp = await getHeadTimestamp(dataset, latestBlock)
    const targetTimestamp = headTimestamp - seconds
    const fromBlock = await timestampToBlock(dataset, targetTimestamp)

    return {
      from_block: fromBlock,
      to_block: latestBlock,
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
 * Convert timeframe to approximate block count — ONLY for Hyperliquid.
 * All other chains should use resolveTimeframeOrBlocks() which uses the /timestamps/ API.
 *
 * @deprecated Use resolveTimeframeOrBlocks() instead for accurate conversion.
 */
export function timeframeToBlocks(timeframe: string, dataset: string): number {
  const seconds = parseTimeframeToSeconds(timeframe)
  return Math.floor(seconds / HYPERLIQUID_BLOCK_TIME)
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
