// ============================================================================
// Constants
// ============================================================================

// Environment configuration
// Note: In Cloudflare Workers, env vars come from wrangler.toml or env parameter
export const PORTAL_URL = process.env.PORTAL_URL || 'https://portal.sqd.dev'
export const DEFAULT_TIMEOUT = 10000 // 10s for regular fetch (Portal API is fast, avg 200ms)
export const STREAM_TIMEOUT = 15000 // 15s for streaming queries (was 60s, but API responds in <5s for reasonable queries)
export const DEFAULT_RETRIES = 2 // Reduced from 3 - fail faster

// Query performance recommendations (based on real-world Portal API benchmarks)
// Portal API typically responds in <1s for these ranges
export const MAX_RECOMMENDED_BLOCK_RANGE = {
  LOGS: 10000, // 10k blocks for log queries (responds ~500ms)
  TRANSACTIONS: 5000, // 5k blocks for transaction queries (responds ~100ms)
  TRACES: 1000, // 1k blocks for trace queries (expensive)
}

// Common ERC20/721/1155 event signatures
export const EVENT_SIGNATURES = {
  // ERC20
  TRANSFER_ERC20: '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
  APPROVAL_ERC20: '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925',
  // ERC721
  TRANSFER_ERC721: '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
  APPROVAL_ERC721: '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925',
  APPROVAL_FOR_ALL: '0x17307eab39ab6107e8899845ad3d59bd9653f200f220920489ca2b5937696c31',
  // ERC1155
  TRANSFER_SINGLE: '0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62',
  TRANSFER_BATCH: '0x4a39dc06d4c0dbc64b70af90fd698a233a518aa5d07e595d983b8c0526c8f7fb',
  // DEX
  UNISWAP_V2_SWAP: '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822',
  UNISWAP_V3_SWAP: '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67',
  SYNC: '0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1',
  // WETH
  DEPOSIT: '0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c',
  WITHDRAWAL: '0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65',
  // Common token operations
  BURN: '0xcc16f5dbb4873280815c1ee09dbd06736cffcc184412cf7a71a0fdb75d397ca5',
  MINT: '0xab8530f87dc9b59234c4623bf917212bb2536d647574c8e7e5da92c2ede0c9f8',
  AUTHORIZATION_USED: '0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5',
  // Uniswap V3 liquidity
  INCREASE_LIQUIDITY: '0x3067048beee31b25b2f1681f88dac838c8bba36af25bfb2b7cf7473a5847e35f',
  DECREASE_LIQUIDITY: '0x26f6a048ee9138f2c0ce266f322cb99228e8d619ae2bff30c67f8dcf9d2377b4',
}

/**
 * Reverse lookup: topic0 hash → human-readable event name.
 * Used by tools that display raw topic0 hashes to make output more actionable.
 */
export const EVENT_NAMES: Record<string, string> = {
  [EVENT_SIGNATURES.TRANSFER_ERC20]: 'Transfer',
  [EVENT_SIGNATURES.APPROVAL_ERC20]: 'Approval',
  [EVENT_SIGNATURES.APPROVAL_FOR_ALL]: 'ApprovalForAll',
  [EVENT_SIGNATURES.TRANSFER_SINGLE]: 'TransferSingle (ERC1155)',
  [EVENT_SIGNATURES.TRANSFER_BATCH]: 'TransferBatch (ERC1155)',
  [EVENT_SIGNATURES.UNISWAP_V2_SWAP]: 'Swap (Uniswap V2)',
  [EVENT_SIGNATURES.UNISWAP_V3_SWAP]: 'Swap (Uniswap V3)',
  [EVENT_SIGNATURES.SYNC]: 'Sync (Uniswap V2)',
  [EVENT_SIGNATURES.DEPOSIT]: 'Deposit (WETH)',
  [EVENT_SIGNATURES.WITHDRAWAL]: 'Withdrawal (WETH)',
  [EVENT_SIGNATURES.BURN]: 'Burn',
  [EVENT_SIGNATURES.MINT]: 'Mint',
  [EVENT_SIGNATURES.AUTHORIZATION_USED]: 'AuthorizationUsed',
  [EVENT_SIGNATURES.INCREASE_LIQUIDITY]: 'IncreaseLiquidity (Uniswap V3)',
  [EVENT_SIGNATURES.DECREASE_LIQUIDITY]: 'DecreaseLiquidity (Uniswap V3)',
}
