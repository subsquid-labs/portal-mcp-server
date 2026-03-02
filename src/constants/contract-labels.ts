// Well-known contract labels across chains
// Helps users identify contracts without external lookups

export interface ContractLabel {
  address: string
  name: string
  category: 'token' | 'dex' | 'bridge' | 'lending' | 'nft' | 'staking' | 'other'
  symbol?: string
  website?: string
}

// Ethereum Mainnet
export const ETHEREUM_LABELS: ContractLabel[] = [
  // Tokens
  { address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', name: 'USD Coin', category: 'token', symbol: 'USDC' },
  { address: '0xdac17f958d2ee523a2206206994597c13d831ec7', name: 'Tether USD', category: 'token', symbol: 'USDT' },
  { address: '0x6b175474e89094c44da98b954eedeac495271d0f', name: 'Dai Stablecoin', category: 'token', symbol: 'DAI' },
  { address: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', name: 'Wrapped Ether', category: 'token', symbol: 'WETH' },
  { address: '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599', name: 'Wrapped BTC', category: 'token', symbol: 'WBTC' },

  // DEXs
  {
    address: '0x7a250d5630b4cf539739df2c5dacb4c659f2488d',
    name: 'Uniswap V2 Router',
    category: 'dex',
    website: 'uniswap.org',
  },
  {
    address: '0xe592427a0aece92de3edee1f18e0157c05861564',
    name: 'Uniswap V3 Router',
    category: 'dex',
    website: 'uniswap.org',
  },
  {
    address: '0xdef1c0ded9bec7f1a1670819833240f027b25eff',
    name: '0x Exchange Proxy',
    category: 'dex',
    website: '0x.org',
  },

  // Lending
  {
    address: '0x7d2768de32b0b80b7a3454c06bdac94a69ddc7a9',
    name: 'Aave V2 Lending Pool',
    category: 'lending',
    website: 'aave.com',
  },
  {
    address: '0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2',
    name: 'Aave V3 Pool',
    category: 'lending',
    website: 'aave.com',
  },
]

// Base Mainnet
export const BASE_LABELS: ContractLabel[] = [
  // Tokens
  { address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', name: 'USD Coin', category: 'token', symbol: 'USDC' },
  { address: '0x4200000000000000000000000000000000000006', name: 'Wrapped Ether', category: 'token', symbol: 'WETH' },
  { address: '0x50c5725949a6f0c72e6c4a641f24049a917db0cb', name: 'Dai Stablecoin', category: 'token', symbol: 'DAI' },

  // DEXs
  {
    address: '0x4752ba5dbc23f44d87826276bf6fd6b1c372ad24',
    name: 'Uniswap V2 Router',
    category: 'dex',
    website: 'uniswap.org',
  },
  {
    address: '0x327df1e6de05895d2ab08513aadd9313fe505d86',
    name: 'Aerodrome Router',
    category: 'dex',
    website: 'aerodrome.finance',
  },
]

// Arbitrum One
export const ARBITRUM_LABELS: ContractLabel[] = [
  // Tokens
  { address: '0xaf88d065e77c8cc2239327c5edb3a432268e5831', name: 'USD Coin', category: 'token', symbol: 'USDC' },
  { address: '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9', name: 'Tether USD', category: 'token', symbol: 'USDT' },
  { address: '0x82af49447d8a07e3bd95bd0d56f35241523fbab1', name: 'Wrapped Ether', category: 'token', symbol: 'WETH' },

  // DEXs
  {
    address: '0xe592427a0aece92de3edee1f18e0157c05861564',
    name: 'Uniswap V3 Router',
    category: 'dex',
    website: 'uniswap.org',
  },
  {
    address: '0x1b02da8cb0d097eb8d57a175b88c7d8b47997506',
    name: 'SushiSwap Router',
    category: 'dex',
    website: 'sushi.com',
  },
]

// Optimism
export const OPTIMISM_LABELS: ContractLabel[] = [
  // Tokens
  { address: '0x0b2c639c533813f4aa9d7837caf62653d097ff85', name: 'USD Coin', category: 'token', symbol: 'USDC' },
  { address: '0x4200000000000000000000000000000000000006', name: 'Wrapped Ether', category: 'token', symbol: 'WETH' },
  { address: '0xda10009cbd5d07dd0cecc66161fc93d7c9000da1', name: 'Dai Stablecoin', category: 'token', symbol: 'DAI' },

  // DEXs
  {
    address: '0xe592427a0aece92de3edee1f18e0157c05861564',
    name: 'Uniswap V3 Router',
    category: 'dex',
    website: 'uniswap.org',
  },
  {
    address: '0x9c12939390052919af3155f41bf4160fd3666a6f',
    name: 'Velodrome Router',
    category: 'dex',
    website: 'velodrome.finance',
  },
]

// Polygon
export const POLYGON_LABELS: ContractLabel[] = [
  // Tokens
  { address: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359', name: 'USD Coin', category: 'token', symbol: 'USDC' },
  { address: '0xc2132d05d31c914a87c6611c10748aeb04b58e8f', name: 'Tether USD', category: 'token', symbol: 'USDT' },
  { address: '0x7ceb23fd6bc0add59e62ac25578270cff1b9f619', name: 'Wrapped Ether', category: 'token', symbol: 'WETH' },

  // DEXs
  {
    address: '0xe592427a0aece92de3edee1f18e0157c05861564',
    name: 'Uniswap V3 Router',
    category: 'dex',
    website: 'uniswap.org',
  },
  {
    address: '0xa5e0829caced8ffdd4de3c43696c57f7d7a678ff',
    name: 'QuickSwap Router',
    category: 'dex',
    website: 'quickswap.exchange',
  },
]

// All labels by chain
export const CONTRACT_LABELS: Record<string, ContractLabel[]> = {
  'ethereum-mainnet': ETHEREUM_LABELS,
  'base-mainnet': BASE_LABELS,
  'arbitrum-one': ARBITRUM_LABELS,
  'optimism-mainnet': OPTIMISM_LABELS,
  'polygon-mainnet': POLYGON_LABELS,
}

/**
 * Resolve address to label
 */
export function resolveContractLabel(address: string, dataset: string): ContractLabel | undefined {
  const normalized = address.toLowerCase()

  // Special case: null address (burn address)
  if (normalized === '0x0000000000000000000000000000000000000000') {
    return {
      address: normalized,
      name: 'Null Address (Burn)',
      category: 'other',
      symbol: 'NULL',
    }
  }

  const labels = CONTRACT_LABELS[dataset]
  if (!labels) return undefined

  return labels.find((l) => l.address.toLowerCase() === normalized)
}

/**
 * Get all labels for a dataset
 */
export function getLabelsForDataset(dataset: string): ContractLabel[] {
  return CONTRACT_LABELS[dataset] || []
}
