// Re-exports from cache/datasets.ts
export { getChainType, isL2Chain } from '../cache/datasets.js'

import { peekKnownChainType } from '../cache/datasets.js'
import type { ChainType } from '../types/index.js'

/**
 * Sync chain type detection. Uses heuristic (dataset name pattern).
 * Prefer getChainType() for metadata-driven detection.
 */
export function detectChainType(dataset: string): ChainType {
  const cachedKind = peekKnownChainType(dataset)
  if (cachedKind) {
    return cachedKind
  }

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
  if (lower.includes('bitcoin')) {
    return 'bitcoin'
  }
  if (
    lower.includes('substrate') ||
    [
      'acala',
      'aleph-zero',
      'asset-hub-kusama',
      'asset-hub-polkadot',
      'astar-substrate',
      'avail',
      'basilisk',
      'hydradx',
      'karura',
      'kusama',
      'moonbeam-substrate',
      'moonriver-substrate',
      'people-chain',
      'polkadot',
      'rococo',
      'shibuya-substrate',
      'shiden-substrate',
      'vara',
      'westend',
    ].includes(lower)
  ) {
    return 'substrate'
  }
  return 'evm'
}
