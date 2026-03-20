// Timeframe parsing for ergonomic queries
// Converts "24h", "7d" etc. into block numbers

import { getBlockHead } from '../cache/datasets.js'

export type Timeframe = '1h' | '6h' | '12h' | '24h' | '3d' | '7d' | '14d' | '30d'

/**
 * Block time estimates (in seconds) for common chains
 */
const BLOCK_TIMES: Record<string, number> = {
  // Ethereum & L2s
  'ethereum-mainnet': 12,
  'base-mainnet': 2,
  'arbitrum-one': 0.25,
  'optimism-mainnet': 2,
  'polygon-mainnet': 2,
  'avalanche-mainnet': 2,
  'bsc-mainnet': 3,
  'scroll-mainnet': 3,
  'linea-mainnet': 2,
  'zksync-mainnet': 1,
  'mantle-mainnet': 2,
  // Solana (~400ms per slot)
  'solana-mainnet': 0.4,
  // Hyperliquid (~1s per block)
  'hyperliquid-fills': 1,
  'hyperliquid-replica-cmds': 1,
  // Default fallback
  default: 12,
}

/**
 * Get block time for a dataset
 */
function getBlockTime(dataset: string): number {
  return BLOCK_TIMES[dataset] || BLOCK_TIMES.default
}

/**
 * Parse timeframe string to seconds
 */
function parseTimeframeToSeconds(timeframe: string): number {
  const match = timeframe.match(/^(\d+)([hd])$/)
  if (!match) {
    throw new Error(`Invalid timeframe format: ${timeframe}. Use format like "24h" or "7d"`)
  }

  const value = parseInt(match[1])
  const unit = match[2]

  if (unit === 'h') {
    return value * 3600 // hours to seconds
  } else if (unit === 'd') {
    return value * 86400 // days to seconds
  }

  throw new Error(`Invalid timeframe unit: ${unit}`)
}

/**
 * Convert timeframe to block count for a specific dataset
 */
export function timeframeToBlocks(timeframe: string, dataset: string): number {
  const seconds = parseTimeframeToSeconds(timeframe)
  const blockTime = getBlockTime(dataset)
  const blockCount = Math.floor(seconds / blockTime)

  return blockCount
}

/**
 * Resolve timeframe or block range
 * If timeframe is provided, calculates from_block/to_block
 * Otherwise uses provided block numbers
 */
export async function resolveTimeframeOrBlocks(params: {
  dataset: string
  timeframe?: string
  from_block?: number
  to_block?: number
}): Promise<{ from_block: number; to_block: number }> {
  const { dataset, timeframe, from_block, to_block } = params

  if (timeframe) {
    // Calculate from timeframe
    const head = await getBlockHead(dataset)
    const latestBlock = head.number
    const blockCount = timeframeToBlocks(timeframe, dataset)
    const calculatedFromBlock = Math.max(0, latestBlock - blockCount + 1)

    return {
      from_block: calculatedFromBlock,
      to_block: latestBlock,
    }
  } else if (from_block !== undefined) {
    // Use provided block range
    return {
      from_block,
      to_block: to_block || from_block + 1000, // Default range if to_block not provided
    }
  }

  throw new Error("Either 'timeframe' or 'from_block' must be provided")
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
