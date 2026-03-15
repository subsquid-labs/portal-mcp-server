// Re-exports from cache/datasets.ts
export { getChainType, isL2Chain } from '../cache/datasets.js'

import type { ChainType } from '../types/index.js'

/**
 * Sync chain type detection. Uses heuristic (dataset name pattern).
 * Prefer getChainType() for metadata-driven detection.
 */
export function detectChainType(dataset: string): ChainType {
  const lower = dataset.toLowerCase()
  if (lower.includes('solana') || lower.includes('eclipse')) {
    return 'solana'
  }
  if (lower === 'hyperliquid-fills') {
    return 'hyperliquidFills'
  }
  if (lower === 'hyperliquid-replica-cmds') {
    return 'hyperliquidReplicaCmds'
  }
  return 'evm'
}
