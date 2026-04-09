import type { Client } from '@modelcontextprotocol/sdk/client/index.js'

export interface ToolTestContext {
  nowTimestamp: number
  baseHead: number
  solHead: number
  hlFillsHead: number
  hlReplicaHead: number
  usdcBase: string
  activeWallet: string
  tokenProgram: string
}

export interface ToolSpec {
  name: string
  prompt: string
  args: (context: ToolTestContext) => Record<string, unknown>
  validate: (text: string, context: ToolTestContext) => void
}

export function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`)
  }
}

export function getText(result: any): string {
  return result?.content?.[0]?.text || ''
}

export function extractJson(text: string): any {
  const jsonStart = text.search(/[\[{]/)
  if (jsonStart === -1) {
    throw new Error('No JSON found in response')
  }

  return JSON.parse(text.slice(jsonStart))
}

function getItems(data: any): any[] {
  if (Array.isArray(data)) return data
  if (Array.isArray(data?.items)) return data.items
  if (Array.isArray(data?.top_contracts)) return data.top_contracts
  if (Array.isArray(data?.time_series)) return data.time_series
  if (Array.isArray(data?.grouped)) return data.grouped
  return []
}

function expectItems(text: string, label: string, minItems = 1): any[] {
  const items = getItems(extractJson(text))
  assert(items.length >= minItems, `${label} should return at least ${minItems} item(s)`)
  return items
}

function expectKey(text: string, key: string, label: string) {
  const data = extractJson(text)
  assert(data?.[key] !== undefined, `${label} should include '${key}'`)
  return data
}

async function getHeadNumber(client: Client, dataset: string): Promise<number> {
  const result = await client.callTool({
    name: 'portal_get_block_number',
    arguments: { dataset },
  })

  return extractJson(getText(result)).number
}

export async function loadToolTestContext(client: Client): Promise<ToolTestContext> {
  const [baseHead, solHead, hlFillsHead, hlReplicaHead] = await Promise.all([
    getHeadNumber(client, 'base-mainnet'),
    getHeadNumber(client, 'solana-mainnet'),
    getHeadNumber(client, 'hyperliquid-fills'),
    getHeadNumber(client, 'hyperliquid-replica-cmds'),
  ])

  return {
    nowTimestamp: Math.floor(Date.now() / 1000),
    baseHead,
    solHead,
    hlFillsHead,
    hlReplicaHead,
    usdcBase: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    activeWallet: '0x3304e22ddaa22bcdc5fca2269b418046ae7b566a',
    tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  }
}

export const TOOL_SPECS: ToolSpec[] = [
  {
    name: 'portal_list_datasets',
    prompt: 'Show me EVM mainnet datasets',
    args: () => ({ chain_type: 'evm', network_type: 'mainnet', limit: 10 }),
    validate: (text) => {
      const items = expectItems(text, 'portal_list_datasets')
      assert(items.some((item: any) => item.kind === 'evm'), 'Expected at least one EVM dataset')
    },
  },
  {
    name: 'portal_get_dataset_info',
    prompt: 'Tell me about Base',
    args: () => ({ dataset: 'base' }),
    validate: (text) => {
      const data = expectKey(text, 'head', 'portal_get_dataset_info')
      assert(data.kind === 'evm', 'Base should resolve to an EVM dataset')
    },
  },
  {
    name: 'portal_get_block_number',
    prompt: 'What is the latest block on Base?',
    args: () => ({ dataset: 'base' }),
    validate: (text) => {
      const data = extractJson(text)
      assert(typeof data.number === 'number' && data.number > 1_000_000, 'Expected a recent block number')
    },
  },
  {
    name: 'portal_block_at_timestamp',
    prompt: 'What block was Base at 24 hours ago?',
    args: (context) => ({ dataset: 'base', timestamp: context.nowTimestamp - 24 * 3600 }),
    validate: (text) => {
      const data = extractJson(text)
      assert(typeof data.block_number === 'number' && data.block_number > 0, 'Expected a block number')
    },
  },
  {
    name: 'portal_query_blocks',
    prompt: 'Show me the last 3 Base blocks',
    args: (context) => ({ dataset: 'base', from_block: context.baseHead - 5, limit: 3 }),
    validate: (text) => {
      expectItems(text, 'portal_query_blocks')
    },
  },
  {
    name: 'portal_query_logs',
    prompt: 'Show me recent USDC logs on Base',
    args: (context) => ({
      dataset: 'base',
      from_block: context.baseHead - 200,
      addresses: [context.usdcBase],
      limit: 3,
      field_preset: 'minimal',
    }),
    validate: (text, context) => {
      const items = expectItems(text, 'portal_query_logs')
      assert(items[0].address?.toLowerCase() === context.usdcBase, 'Expected USDC log results')
    },
  },
  {
    name: 'portal_query_transactions',
    prompt: 'Show me a few recent Base transactions',
    args: () => ({ dataset: 'base', timeframe: '1h', limit: 3, field_preset: 'minimal' }),
    validate: (text) => {
      const items = expectItems(text, 'portal_query_transactions')
      assert(items[0].from !== undefined, 'Expected transaction sender field')
    },
  },
  {
    name: 'portal_get_erc20_transfers',
    prompt: 'Show me recent USDC transfers on Base',
    args: (context) => ({
      dataset: 'base',
      from_block: context.baseHead - 200,
      token_addresses: [context.usdcBase],
      limit: 3,
      include_token_info: true,
    }),
    validate: (text, context) => {
      const items = expectItems(text, 'portal_get_erc20_transfers')
      assert(items[0].token_address?.toLowerCase() === context.usdcBase, 'Expected USDC transfer results')
    },
  },
  {
    name: 'portal_decode_logs',
    prompt: 'Decode recent USDC logs on Base',
    args: (context) => ({
      dataset: 'base',
      from_block: context.baseHead - 100,
      addresses: [context.usdcBase],
      limit: 3,
    }),
    validate: (text) => {
      assert(text.length > 0, 'portal_decode_logs should return output')
    },
  },
  {
    name: 'portal_get_recent_transactions',
    prompt: 'Show me recent transactions on Base',
    args: () => ({ dataset: 'base', timeframe: '100', limit: 3 }),
    validate: (text) => {
      expectItems(text, 'portal_get_recent_transactions')
    },
  },
  {
    name: 'portal_get_wallet_summary',
    prompt: 'Summarize wallet activity on Base',
    args: (context) => ({
      dataset: 'base',
      address: context.activeWallet,
      timeframe: '1000',
      include_tokens: true,
      include_nfts: false,
      limit_per_type: 3,
    }),
    validate: (text) => {
      const data = extractJson(text)
      assert(data.transactions !== undefined, 'Expected wallet summary transaction section')
    },
  },
  {
    name: 'portal_get_contract_activity',
    prompt: 'Summarize USDC contract activity on Base',
    args: (context) => ({
      dataset: 'base',
      contract_address: context.usdcBase,
      timeframe: '1000',
    }),
    validate: (text) => {
      const data = extractJson(text)
      assert(data.interactions?.total_transactions !== undefined, 'Expected contract interaction totals')
    },
  },
  {
    name: 'portal_get_top_contracts',
    prompt: 'Show me the busiest contracts on Base',
    args: () => ({ dataset: 'base', num_blocks: 100, limit: 5 }),
    validate: (text) => {
      expectItems(text, 'portal_get_top_contracts')
    },
  },
  {
    name: 'portal_get_transaction_density',
    prompt: 'How busy is Base right now?',
    args: () => ({ dataset: 'base', num_blocks: 20 }),
    validate: (text) => {
      const data = extractJson(text)
      assert(data.summary !== undefined || data.blocks !== undefined || data.items !== undefined, 'Expected density output')
    },
  },
  {
    name: 'portal_get_time_series',
    prompt: 'Chart Monad transaction count over the last hour',
    args: () => ({ dataset: 'monad', metric: 'transaction_count', interval: '5m', duration: '1h' }),
    validate: (text) => {
      const data = extractJson(text)
      assert(Array.isArray(data.time_series) && data.time_series.length === 12, 'Expected 12 time-series data points')
      assert(data.summary?.total_buckets === data.summary?.expected_buckets, 'Expected full time-series coverage')
    },
  },
  {
    name: 'portal_get_time_series',
    prompt: 'Chart Solana unique addresses over the last hour',
    args: () => ({ dataset: 'solana-mainnet', metric: 'unique_addresses', interval: '5m', duration: '1h' }),
    validate: (text) => {
      const data = extractJson(text)
      assert(Array.isArray(data.time_series) && data.time_series.length === 12, 'Expected 12 Solana time-series data points')
      assert(data.summary?.total_buckets === data.summary?.expected_buckets, 'Expected full Solana time-series coverage')
    },
  },
  {
    name: 'portal_query_solana_instructions',
    prompt: 'Show me recent SPL Token instructions on Solana',
    args: (context) => ({
      dataset: 'solana-mainnet',
      from_block: context.solHead - 10,
      to_block: context.solHead,
      program_id: [context.tokenProgram],
      limit: 3,
    }),
    validate: (text) => {
      expectItems(text, 'portal_query_solana_instructions')
    },
  },
  {
    name: 'portal_query_solana_transactions',
    prompt: 'Show me recent Solana transactions',
    args: (context) => ({
      dataset: 'solana-mainnet',
      from_block: context.solHead - 2,
      to_block: context.solHead,
      limit: 3,
      response_format: 'compact',
    }),
    validate: (text) => {
      expectItems(text, 'portal_query_solana_transactions')
    },
  },
  {
    name: 'portal_solana_analytics',
    prompt: 'Give me a Solana network snapshot',
    args: () => ({ dataset: 'solana-mainnet', timeframe: '1h', include_programs: false }),
    validate: (text) => {
      const data = extractJson(text)
      assert(data.network !== undefined && data.throughput !== undefined, 'Expected Solana analytics sections')
    },
  },
  {
    name: 'portal_solana_time_series',
    prompt: 'Chart Solana transaction count over the last hour',
    args: () => ({ dataset: 'solana-mainnet', metric: 'transaction_count', interval: '5m', duration: '1h' }),
    validate: (text) => {
      const data = extractJson(text)
      assert(Array.isArray(data.time_series) && data.time_series.length > 0, 'Expected Solana time-series data')
    },
  },
  {
    name: 'portal_query_bitcoin_transactions',
    prompt: 'Show me recent Bitcoin transactions',
    args: () => ({ dataset: 'bitcoin-mainnet', timeframe: '1h', limit: 3, response_format: 'compact' }),
    validate: (text) => {
      expectItems(text, 'portal_query_bitcoin_transactions')
    },
  },
  {
    name: 'portal_query_bitcoin_inputs',
    prompt: 'Show me recent Bitcoin inputs',
    args: () => ({ dataset: 'bitcoin-mainnet', timeframe: '1h', limit: 3, response_format: 'compact' }),
    validate: (text) => {
      expectItems(text, 'portal_query_bitcoin_inputs')
    },
  },
  {
    name: 'portal_query_bitcoin_outputs',
    prompt: 'Show me recent Bitcoin outputs',
    args: () => ({ dataset: 'bitcoin-mainnet', timeframe: '1h', limit: 3, response_format: 'compact' }),
    validate: (text) => {
      expectItems(text, 'portal_query_bitcoin_outputs')
    },
  },
  {
    name: 'portal_bitcoin_analytics',
    prompt: 'Give me a Bitcoin network snapshot',
    args: () => ({ dataset: 'bitcoin-mainnet', timeframe: '1h', include_address_activity: false }),
    validate: (text) => {
      const data = extractJson(text)
      assert(data.block_details !== undefined && data.transaction_stats !== undefined, 'Expected Bitcoin analytics sections')
    },
  },
  {
    name: 'portal_bitcoin_time_series',
    prompt: 'Chart Bitcoin transaction count over the last 6 hours',
    args: () => ({ dataset: 'bitcoin-mainnet', metric: 'transaction_count', interval: '1h', duration: '6h' }),
    validate: (text) => {
      const data = extractJson(text)
      assert(Array.isArray(data.time_series) && data.time_series.length > 0, 'Expected Bitcoin time-series data')
    },
  },
  {
    name: 'portal_query_hyperliquid_fills',
    prompt: 'Show me recent Hyperliquid fills',
    args: (context) => ({ dataset: 'hyperliquid-fills', from_block: context.hlFillsHead - 100, limit: 3 }),
    validate: (text) => {
      expectItems(text, 'portal_query_hyperliquid_fills')
    },
  },
  {
    name: 'portal_query_hyperliquid_replica_cmds',
    prompt: 'Show me recent Hyperliquid order actions',
    args: (context) => ({ dataset: 'hyperliquid-replica-cmds', from_block: context.hlReplicaHead - 100, limit: 3 }),
    validate: (text) => {
      expectItems(text, 'portal_query_hyperliquid_replica_cmds')
    },
  },
  {
    name: 'portal_aggregate_hyperliquid_fills',
    prompt: 'Aggregate Hyperliquid fills over the last hour',
    args: () => ({ dataset: 'hyperliquid-fills', timeframe: '1h', group_by: 'coin' }),
    validate: (text) => {
      const data = extractJson(text)
      assert(typeof data.total_fills === 'number' && data.total_fills > 0, 'Expected aggregate Hyperliquid fill totals')
    },
  },
  {
    name: 'portal_hyperliquid_time_series',
    prompt: 'Chart Hyperliquid volume over the last hour',
    args: () => ({ dataset: 'hyperliquid-fills', metric: 'volume', interval: '5m', duration: '1h' }),
    validate: (text) => {
      const data = extractJson(text)
      assert(Array.isArray(data.time_series) && data.time_series.length > 0, 'Expected Hyperliquid time-series data')
    },
  },
  {
    name: 'portal_hyperliquid_analytics',
    prompt: 'Give me a Hyperliquid trading snapshot',
    args: () => ({ dataset: 'hyperliquid-fills', timeframe: '1h' }),
    validate: (text) => {
      const data = extractJson(text)
      assert(data.overview?.total_fills > 0, 'Expected Hyperliquid analytics overview totals')
    },
  },
]
