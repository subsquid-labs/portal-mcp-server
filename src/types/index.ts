// ============================================================================
// Types
// ============================================================================

export interface DatasetExpandedMetadata {
  display_name?: string
  logo_url?: string
  type?: 'mainnet' | 'testnet' | 'devnet'
  kind?: ChainType
  evm?: { chain_id: number }
}

export interface DatasetSchema {
  tables?: Record<string, unknown>
}

export interface Dataset {
  dataset: string
  aliases: string[]
  real_time: boolean
  metadata?: DatasetExpandedMetadata
  schema?: DatasetSchema
}

export interface DatasetMetadata extends Dataset {
  start_block: number
}

export interface BlockHead {
  number: number
  hash: string
}

export type ChainType = 'evm' | 'solana' | 'hyperliquidFills' | 'hyperliquidReplicaCmds'
