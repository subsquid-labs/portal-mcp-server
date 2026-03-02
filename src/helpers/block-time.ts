/**
 * Dynamic Block Time Calculation
 *
 * Block times are NOT constant - they vary with network conditions and upgrades.
 * This module calculates actual block production rate from recent blocks.
 */

import { PORTAL_URL } from '../constants/index.js'
import { portalFetch } from './fetch.js'

interface BlockTimeMeasurement {
  avgBlockTime: number
  sampledBlocks: number
  timestamp: number
}

// Cache block time measurements (5 minute TTL)
const blockTimeCache = new Map<string, BlockTimeMeasurement>()
const CACHE_TTL = 5 * 60 * 1000

/**
 * Measure actual block production rate by sampling recent blocks
 */
export async function measureBlockTime(dataset: string, sampleSize: number = 100): Promise<number> {
  // Check cache first
  const cached = blockTimeCache.get(dataset)
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.avgBlockTime
  }

  try {
    // Get head block
    const head = await portalFetch<{ number: number; timestamp: number }>(`${PORTAL_URL}/datasets/${dataset}/head`)

    const toBlock = head.number
    const fromBlock = Math.max(0, toBlock - sampleSize)

    // Query recent blocks to measure time
    const query = {
      type: 'evm',
      fromBlock,
      toBlock,
      includeAllBlocks: true,
      fields: {
        block: {
          number: true,
          timestamp: true,
        },
      },
    }

    const results = await portalFetch<any>(`${PORTAL_URL}/datasets/${dataset}/stream`, { method: 'POST', body: query })

    if (!results || results.length < 2) {
      console.warn(`Not enough blocks sampled for ${dataset}, using estimate`)
      return getEstimatedBlockTime(dataset)
    }

    // Calculate average block time from samples
    let totalBlockTime = 0
    let validSamples = 0

    for (let i = 1; i < results.length; i++) {
      const curr = results[i].header || results[i]
      const prev = results[i - 1].header || results[i - 1]

      if (curr.timestamp && prev.timestamp && curr.number && prev.number) {
        const timeDiff = curr.timestamp - prev.timestamp
        const blockDiff = curr.number - prev.number

        if (blockDiff > 0 && timeDiff > 0) {
          totalBlockTime += timeDiff / blockDiff
          validSamples++
        }
      }
    }

    if (validSamples === 0) {
      console.warn(`No valid samples for ${dataset}, using estimate`)
      return getEstimatedBlockTime(dataset)
    }

    const avgBlockTime = totalBlockTime / validSamples

    // Cache the result
    blockTimeCache.set(dataset, {
      avgBlockTime,
      sampledBlocks: validSamples,
      timestamp: Date.now(),
    })

    console.log(`Measured block time for ${dataset}: ${avgBlockTime.toFixed(2)}s (${validSamples} samples)`)

    return avgBlockTime
  } catch (error) {
    console.warn(`Failed to measure block time for ${dataset}:`, error)
    return getEstimatedBlockTime(dataset)
  }
}

/**
 * Fallback estimates when measurement fails
 */
function getEstimatedBlockTime(dataset: string): number {
  const estimates: Record<string, number> = {
    'hyperliquid-mainnet': 1,
    ethereum: 12,
    'ethereum-mainnet': 12,
    'base-mainnet': 2,
    'optimism-mainnet': 2,
    'arbitrum-one': 0.25,
    polygon: 2,
    'polygon-mainnet': 2,
    bsc: 3,
    avalanche: 2,
    'avalanche-mainnet': 2,
  }

  return estimates[dataset.toLowerCase()] || 12 // Default to Ethereum
}

/**
 * Calculate blocks for a time duration using measured block time
 */
export async function durationToBlocks(dataset: string, duration: string): Promise<number> {
  const durations: Record<string, number> = {
    '1m': 60,
    '5m': 300,
    '15m': 900,
    '1h': 3600,
    '6h': 21600,
    '24h': 86400,
    '7d': 604800,
    '30d': 2592000,
  }

  const seconds = durations[duration]
  if (!seconds) {
    throw new Error(`Unknown duration: ${duration}. Use: 1m, 5m, 15m, 1h, 6h, 24h, 7d, 30d`)
  }

  const blockTime = await measureBlockTime(dataset)
  return Math.floor(seconds / blockTime)
}

/**
 * Clear cache (useful for testing)
 */
export function clearBlockTimeCache() {
  blockTimeCache.clear()
}
