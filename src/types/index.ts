// ============================================================================
// Types
// ============================================================================

export interface Dataset {
  dataset: string
  aliases: string[]
  real_time: boolean
}

export interface DatasetMetadata extends Dataset {
  start_block: number
}

export interface BlockHead {
  number: number
  hash: string
}

export type ChainType = 'evm' | 'solana'
