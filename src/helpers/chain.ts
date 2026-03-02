import type { ChainType } from '../types/index.js'

// ============================================================================
// Chain Type Detection (EVM or Solana only)
// ============================================================================

export function detectChainType(dataset: string): ChainType {
  const lower = dataset.toLowerCase()

  // Solana datasets
  if (lower.includes('solana') || lower.startsWith('solana-') || lower === 'solana' || lower.includes('eclipse')) {
    return 'solana'
  }

  // Default to EVM for all other chains
  return 'evm'
}

export function isL2Chain(dataset: string): boolean {
  const lower = dataset.toLowerCase()
  const l2Patterns = [
    'arbitrum',
    'optimism',
    'base',
    'zksync',
    'linea',
    'scroll',
    'blast',
    'mantle',
    'mode',
    'zora',
    'polygon-zkevm',
    'starknet',
    'taiko',
    'manta',
    'metis',
  ]
  return l2Patterns.some((pattern) => lower.includes(pattern))
}
