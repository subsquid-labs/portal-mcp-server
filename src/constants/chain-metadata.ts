/**
 * Baked-in Chain Metadata
 *
 * Pre-computed start blocks and chain info for common datasets.
 * Reduces cold-start from "3 API calls" to "1 API call" (just head).
 *
 * Source: https://portal.sqd.dev/datasets/{dataset}/head
 * Updated: 2026-02-06
 */

export interface ChainMetadata {
  dataset: string
  chainId?: number
  blockTime: number // ESTIMATED average seconds per block (NOT guaranteed constant!)
  startBlock: number // Genesis or earliest available block
  name: string
  description?: string
}

/**
 * WARNING: Block times in this file are ESTIMATES based on historical averages.
 *
 * Real block times vary due to:
 * - Network congestion
 * - Protocol upgrades (e.g., Ethereum Merge changed from ~13s to ~12s)
 * - Chain reorganizations
 * - Validator/miner behavior
 *
 * For time-critical calculations, use measureBlockTime() from helpers/block-time.ts
 * to calculate actual recent block production rate.
 *
 * These estimates are useful for:
 * - Quick approximations
 * - Fallback when dynamic measurement fails
 * - Cold-start performance optimization
 */

export const KNOWN_CHAINS: Record<string, ChainMetadata> = {
  // HyperEVM / Hyperliquid
  'hyperliquid-mainnet': {
    dataset: 'hyperliquid-mainnet',
    chainId: 998,
    blockTime: 1, // ~1 second per block
    startBlock: 0,
    name: 'Hyperliquid EVM',
    description: 'Hyperliquid L1',
  },

  // Ethereum Mainnet
  ethereum: {
    dataset: 'ethereum',
    chainId: 1,
    blockTime: 12,
    startBlock: 0,
    name: 'Ethereum Mainnet',
    description: 'Ethereum L1',
  },

  // Base
  'base-mainnet': {
    dataset: 'base-mainnet',
    chainId: 8453,
    blockTime: 2,
    startBlock: 0,
    name: 'Base Mainnet',
    description: 'Coinbase L2 on Optimism stack',
  },

  // Optimism
  'optimism-mainnet': {
    dataset: 'optimism-mainnet',
    chainId: 10,
    blockTime: 2,
    startBlock: 0,
    name: 'Optimism Mainnet',
    description: 'Optimism L2',
  },

  // Arbitrum
  'arbitrum-one': {
    dataset: 'arbitrum-one',
    chainId: 42161,
    blockTime: 0.25,
    startBlock: 0,
    name: 'Arbitrum One',
    description: 'Arbitrum L2',
  },

  // Polygon
  polygon: {
    dataset: 'polygon',
    chainId: 137,
    blockTime: 2,
    startBlock: 0,
    name: 'Polygon PoS',
    description: 'Polygon Proof-of-Stake',
  },

  // BSC
  bsc: {
    dataset: 'bsc',
    chainId: 56,
    blockTime: 3,
    startBlock: 0,
    name: 'BNB Smart Chain',
    description: 'Binance Smart Chain',
  },

  // Avalanche
  avalanche: {
    dataset: 'avalanche',
    chainId: 43114,
    blockTime: 2,
    startBlock: 0,
    name: 'Avalanche C-Chain',
    description: 'Avalanche Contract Chain',
  },

  // Gnosis
  gnosis: {
    dataset: 'gnosis',
    chainId: 100,
    blockTime: 5,
    startBlock: 0,
    name: 'Gnosis Chain',
    description: 'Gnosis Chain (formerly xDai)',
  },

  // Fantom
  fantom: {
    dataset: 'fantom',
    chainId: 250,
    blockTime: 1,
    startBlock: 0,
    name: 'Fantom Opera',
    description: 'Fantom Opera mainnet',
  },

  // Testnets
  sepolia: {
    dataset: 'sepolia',
    chainId: 11155111,
    blockTime: 12,
    startBlock: 0,
    name: 'Sepolia Testnet',
    description: 'Ethereum testnet',
  },

  'base-sepolia': {
    dataset: 'base-sepolia',
    chainId: 84532,
    blockTime: 2,
    startBlock: 0,
    name: 'Base Sepolia Testnet',
    description: 'Base testnet',
  },
}

/**
 * Get metadata for a dataset (if known)
 */
export function getChainMetadata(dataset: string): ChainMetadata | undefined {
  return KNOWN_CHAINS[dataset.toLowerCase()]
}

/**
 * Calculate approximate block count for a time duration
 *
 * IMPORTANT: This uses estimated average block times which are NOT constant!
 * For precise calculations, measure actual block production rate from recent blocks.
 */
export function timeToBlocks(dataset: string, duration: string): number {
  const metadata = getChainMetadata(dataset)
  const estimatedBlockTime = metadata?.blockTime || 12 // Estimated average, not guaranteed

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

  return Math.floor(seconds / estimatedBlockTime)
}

/**
 * Calculate approximate blocks per interval
 */
export function intervalToBlocks(dataset: string, interval: string): number {
  const metadata = getChainMetadata(dataset)
  const blockTime = metadata?.blockTime || 12

  const intervals: Record<string, number> = {
    '1m': 60,
    '5m': 300,
    '15m': 900,
    '1h': 3600,
    '6h': 21600,
    '1d': 86400,
  }

  const seconds = intervals[interval]
  if (!seconds) {
    throw new Error(`Unknown interval: ${interval}. Use: 1m, 5m, 15m, 1h, 6h, 1d`)
  }

  return Math.floor(seconds / blockTime)
}

/**
 * Check if dataset is known (can skip metadata API call)
 */
export function isKnownChain(dataset: string): boolean {
  return dataset.toLowerCase() in KNOWN_CHAINS
}
