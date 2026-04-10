import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { EVENT_SIGNATURES } from '../src/constants/index.js'

export interface ToolTestContext {
  nowTimestamp: number
  baseHead: number
  solHead: number
  btcHead: number
  hlFillsHead: number
  hlReplicaHead: number
  usdcBase: string
  baseUniswapV3Pool: string
  evmWallet: string
  solWallet: string
  btcAddress: string
  hlUser: string
  tokenProgram: string
}

export interface ToolSpec {
  name: string
  prompt: string
  args: (context: ToolTestContext) => Record<string, unknown>
  validate: (text: string, context: ToolTestContext) => void
  validateError?: (text: string, context: ToolTestContext) => void
  validateFollowUp?: (text: string, client: Client, context: ToolTestContext) => Promise<void>
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
    throw new Error(`No JSON found in response: ${text.slice(0, 200)}`)
  }

  return JSON.parse(text.slice(jsonStart))
}

function getItems(data: any): any[] {
  if (Array.isArray(data)) return data
  if (Array.isArray(data?.items)) return data.items
  if (Array.isArray(data?.time_series)) return data.time_series
  if (Array.isArray(data?.candles)) return data.candles
  if (Array.isArray(data?.ohlc)) return data.ohlc
  if (Array.isArray(data?.top_contracts)) return data.top_contracts
  if (Array.isArray(data?.volume_by_coin)) return data.volume_by_coin
  if (Array.isArray(data?.top_traders_by_volume)) return data.top_traders_by_volume
  if (Array.isArray(data?.programs)) return data.programs
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

function expectWindowMetadata(data: any, label: string) {
  assert(data?._freshness !== undefined, `${label} should include _freshness`)
  assert(data?._coverage !== undefined, `${label} should include _coverage`)
}

function expectOrdering(data: any, label: string) {
  assert(data?._ordering !== undefined, `${label} should include _ordering`)
}

function expectGapDiagnostics(data: any, label: string) {
  assert(data?.gap_diagnostics !== undefined, `${label} should include gap_diagnostics`)
}

function expectPresentation(data: any, label: string, options?: { chartDataKey?: string; tableId?: string }) {
  assert(data?.chart !== undefined, `${label} should include chart metadata`)
  assert(Array.isArray(data?.tables) && data.tables.length > 0, `${label} should include table metadata`)
  if (options?.chartDataKey) {
    assert(data.chart?.data_key === options.chartDataKey, `${label} chart should point at ${options.chartDataKey}`)
  }
  if (options?.tableId) {
    assert(data.tables.some((table: any) => table?.id === options.tableId), `${label} should include table ${options.tableId}`)
  }
}

async function getHeadNumber(client: Client, network: string): Promise<number> {
  const result = await client.callTool({
    name: 'portal_get_head',
    arguments: { network },
  })

  return extractJson(getText(result)).number
}

export async function loadToolTestContext(client: Client): Promise<ToolTestContext> {
  const [baseHead, solHead, btcHead, hlFillsHead, hlReplicaHead] = await Promise.all([
    getHeadNumber(client, 'base-mainnet'),
    getHeadNumber(client, 'solana-mainnet'),
    getHeadNumber(client, 'bitcoin-mainnet'),
    getHeadNumber(client, 'hyperliquid-fills'),
    getHeadNumber(client, 'hyperliquid-replica-cmds'),
  ])

  const [recentSwapResult, evmTxResult, solTxResult, btcTxResult, hlFillResult] = await Promise.all([
    client.callTool({
      name: 'portal_evm_query_logs',
      arguments: {
        network: 'base-mainnet',
        from_timestamp: '6h ago',
        to_timestamp: 'now',
        topic0: [EVENT_SIGNATURES.UNISWAP_V3_SWAP],
        limit: 1,
        field_preset: 'minimal',
      },
    }),
    client.callTool({
      name: 'portal_evm_query_transactions',
      arguments: {
        network: 'base-mainnet',
        from_block: baseHead - 200,
        to_block: baseHead,
        limit: 1,
        field_preset: 'minimal',
      },
    }),
    client.callTool({
      name: 'portal_solana_query_transactions',
      arguments: {
        network: 'solana-mainnet',
        from_block: solHead - 20,
        to_block: solHead,
        limit: 1,
      },
    }),
    client.callTool({
      name: 'portal_bitcoin_query_transactions',
      arguments: {
        network: 'bitcoin-mainnet',
        timeframe: '1h',
        limit: 3,
        include_outputs: true,
      },
    }),
    client.callTool({
      name: 'portal_hyperliquid_query_fills',
      arguments: {
        network: 'hyperliquid-fills',
        timeframe: '5m',
        limit: 1,
      },
    }),
  ])

  const recentSwapItems = getItems(extractJson(getText(recentSwapResult)))
  assert(recentSwapItems.length > 0, 'Expected at least one active Base Uniswap V3 pool')
  const baseUniswapV3Pool = String(recentSwapItems[0].address || '').toLowerCase()

  const evmWallet = String(extractJson(getText(evmTxResult)).items?.[0]?.from || '')
  assert(evmWallet.startsWith('0x'), 'Expected an active Base wallet')

  const solItem = extractJson(getText(solTxResult)).items?.[0]
  const solWallet = String(solItem?.feePayer || solItem?.sender || '')
  assert(solWallet.length > 20, 'Expected an active Solana fee payer')

  const btcItems = extractJson(getText(btcTxResult)).items || []
  const btcAddress = String(
    btcItems.flatMap((item: any) => item.outputs || []).find((output: any) => typeof output?.scriptPubKeyAddress === 'string')
      ?.scriptPubKeyAddress || '',
  )
  assert(btcAddress.length > 10, 'Expected a recent Bitcoin output address')

  const hlUser = String(extractJson(getText(hlFillResult)).items?.[0]?.user || '')
  assert(hlUser.startsWith('0x'), 'Expected an active Hyperliquid user')

  return {
    nowTimestamp: Math.floor(Date.now() / 1000),
    baseHead,
    solHead,
    btcHead,
    hlFillsHead,
    hlReplicaHead,
    usdcBase: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    baseUniswapV3Pool,
    evmWallet,
    solWallet,
    btcAddress,
    hlUser,
    tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  }
}

export const LEGACY_TOOL_NAMES = [
  'portal_list_datasets',
  'portal_get_dataset_info',
  'portal_get_block_number',
  'portal_query_transactions',
  'portal_query_logs',
  'portal_get_erc20_transfers',
  'portal_get_contract_activity',
  'portal_evm_ohlc',
  'portal_query_solana_transactions',
  'portal_query_solana_instructions',
  'portal_solana_analytics',
  'portal_query_bitcoin_transactions',
  'portal_bitcoin_analytics',
  'portal_query_hyperliquid_fills',
  'portal_hyperliquid_analytics',
  'portal_hyperliquid_ohlc',
  'portal_query_blocks',
  'portal_block_at_timestamp',
  'portal_query_hyperliquid_replica_cmds',
  'portal_get_recent_transactions',
  'portal_compare_periods',
  'portal_get_top_contract_trends',
  'portal_get_transaction_density',
  'portal_get_top_contracts',
  'portal_decode_logs',
  'portal_solana_time_series',
  'portal_bitcoin_time_series',
  'portal_hyperliquid_time_series',
  'portal_query_bitcoin_inputs',
  'portal_query_bitcoin_outputs',
  'portal_aggregate_hyperliquid_fills',
] as const

export const TOOL_SPECS: ToolSpec[] = [
  {
    name: 'portal_list_networks',
    prompt: "what's the actual network name for Base again",
    args: () => ({ vm: 'evm', network_type: 'mainnet', limit: 10 }),
    validate: (text) => {
      const items = expectItems(text, 'portal_list_networks')
      assert(items.some((item: any) => item.vm === 'evm'), 'Expected at least one EVM network')
    },
  },
  {
    name: 'portal_get_network_info',
    prompt: 'is Base even indexed and caught up right now',
    args: () => ({ network: 'base' }),
    validate: (text) => {
      const data = expectKey(text, 'head', 'portal_get_network_info')
      assert(data.vm === 'evm', 'Base should resolve to an EVM network')
      assert(data.indexing?.indexed_head?.block_number === data.head?.number, 'Expected indexed head metadata')
    },
  },
  {
    name: 'portal_get_head',
    prompt: 'what block is Base on right now',
    args: () => ({ network: 'base' }),
    validate: (text) => {
      const data = extractJson(text)
      assert(typeof data.number === 'number' && data.number > 1_000_000, 'Expected a recent block number')
    },
  },
  {
    name: 'portal_get_recent_activity',
    prompt: 'what has been happening on Base lately',
    args: () => ({ network: 'base', timeframe: '100', limit: 3 }),
    validate: (text) => {
      const data = extractJson(text)
      const items = getItems(data)
      assert(items.length === 3, 'Expected 3 recent Base activity items')
      expectWindowMetadata(data, 'portal_get_recent_activity')
      expectOrdering(data, 'portal_get_recent_activity')
      assert(typeof items[0].primary_id === 'string', 'Expected normalized primary_id')
    },
  },
  {
    name: 'portal_get_wallet_summary',
    prompt: 'can you just tell me what this Base wallet has been doing',
    args: (context) => ({ network: 'base', address: context.evmWallet, timeframe: '5m' }),
    validate: (text) => {
      const data = extractJson(text)
      expectKey(text, 'overview', 'portal_get_wallet_summary evm')
      assert(data.overview?.vm === 'evm', 'Expected EVM wallet overview')
      assert(Array.isArray(data.activity?.items), 'Expected activity items on EVM wallet summary')
      expectWindowMetadata(data, 'portal_get_wallet_summary evm')
    },
    validateFollowUp: async (_text, client, context) => {
      const [solanaResult, bitcoinResult, hyperliquidResult] = await Promise.all([
        client.callTool({
          name: 'portal_get_wallet_summary',
          arguments: { network: 'solana-mainnet', address: context.solWallet, timeframe: '1h' },
        }),
        client.callTool({
          name: 'portal_get_wallet_summary',
          arguments: { network: 'bitcoin-mainnet', address: context.btcAddress, timeframe: '24h' },
        }),
        client.callTool({
          name: 'portal_get_wallet_summary',
          arguments: { network: 'hyperliquid-fills', address: context.hlUser, timeframe: '5m' },
        }),
      ])

      const solanaData = extractJson(getText(solanaResult))
      assert(solanaData.overview?.vm === 'solana', 'Expected Solana wallet overview')
      assert(solanaData.solana?.fee_summary !== undefined, 'Expected Solana-specific fee summary')
      expectWindowMetadata(solanaData, 'portal_get_wallet_summary solana')

      const bitcoinData = extractJson(getText(bitcoinResult))
      assert(bitcoinData.overview?.vm === 'bitcoin', 'Expected Bitcoin wallet overview')
      assert(bitcoinData.bitcoin?.outputs_count !== undefined, 'Expected Bitcoin-specific counts')
      expectWindowMetadata(bitcoinData, 'portal_get_wallet_summary bitcoin')

      const hyperliquidData = extractJson(getText(hyperliquidResult))
      assert(hyperliquidData.overview?.vm === 'hyperliquid', 'Expected Hyperliquid wallet overview')
      assert(hyperliquidData.hyperliquid?.fee_summary !== undefined, 'Expected Hyperliquid fee summary')
      expectWindowMetadata(hyperliquidData, 'portal_get_wallet_summary hyperliquid')
    },
  },
  {
    name: 'portal_get_time_series',
    prompt: 'make me a simple Base activity chart for the last hour',
    args: () => ({ network: 'base', metric: 'transaction_count', interval: '5m', duration: '1h' }),
    validate: (text) => {
      const data = extractJson(text)
      expectItems(text, 'portal_get_time_series base', 12)
      expectWindowMetadata(data, 'portal_get_time_series base')
      expectGapDiagnostics(data, 'portal_get_time_series base')
      assert(data.chart?.kind === 'time_series', 'Expected time-series chart metadata')
      expectPresentation(data, 'portal_get_time_series base', { chartDataKey: 'time_series', tableId: 'main' })
    },
    validateFollowUp: async (_text, client) => {
      const [compareResult, groupedResult, solanaResult, bitcoinResult, hyperliquidResult] = await Promise.all([
        client.callTool({
          name: 'portal_get_time_series',
          arguments: { network: 'base', metric: 'transaction_count', interval: '5m', duration: '1h', compare_previous: true },
        }),
        client.callTool({
          name: 'portal_get_time_series',
          arguments: { network: 'base', metric: 'transaction_count', interval: '5m', duration: '1h', group_by: 'contract', group_limit: 3 },
        }),
        client.callTool({
          name: 'portal_get_time_series',
          arguments: { network: 'solana-mainnet', metric: 'tps', interval: '5m', duration: '1h' },
        }),
        client.callTool({
          name: 'portal_get_time_series',
          arguments: { network: 'bitcoin-mainnet', metric: 'block_size_bytes', interval: '1h', duration: '24h' },
        }),
        client.callTool({
          name: 'portal_get_time_series',
          arguments: { network: 'hyperliquid-fills', metric: 'volume', interval: '5m', duration: '1h' },
        }),
      ])

      const compareData = extractJson(getText(compareResult))
      assert(Array.isArray(compareData.current_series), 'Expected current_series')
      assert(Array.isArray(compareData.previous_series), 'Expected previous_series')
      assert(Array.isArray(compareData.comparison_series), 'Expected comparison_series')
      assert(Array.isArray(compareData.bucket_deltas), 'Expected bucket_deltas')
      expectWindowMetadata(compareData, 'portal_get_time_series compare_previous')
      expectPresentation(compareData, 'portal_get_time_series compare_previous', { chartDataKey: 'comparison_series', tableId: 'comparison_series' })

      const groupedData = extractJson(getText(groupedResult))
      assert(Array.isArray(groupedData.top_contracts) && groupedData.top_contracts.length > 0, 'Expected top_contracts')
      assert(groupedData.chart?.grouped_value_field === 'contract_address', 'Expected grouped contract chart metadata')
      expectWindowMetadata(groupedData, 'portal_get_time_series grouped')
      expectGapDiagnostics(groupedData, 'portal_get_time_series grouped')
      expectPresentation(groupedData, 'portal_get_time_series grouped', { chartDataKey: 'time_series', tableId: 'contract_series' })

      const solanaData = extractJson(getText(solanaResult))
      expectItems(getText(solanaResult), 'portal_get_time_series solana', 12)
      assert(solanaData.summary?.metric === 'tps', 'Expected Solana TPS summary')
      expectWindowMetadata(solanaData, 'portal_get_time_series solana')
      expectPresentation(solanaData, 'portal_get_time_series solana', { chartDataKey: 'time_series', tableId: 'main' })

      const bitcoinData = extractJson(getText(bitcoinResult))
      expectItems(getText(bitcoinResult), 'portal_get_time_series bitcoin', 12)
      assert(bitcoinData.summary?.metric === 'block_size_bytes', 'Expected Bitcoin metric summary')
      expectWindowMetadata(bitcoinData, 'portal_get_time_series bitcoin')
      expectPresentation(bitcoinData, 'portal_get_time_series bitcoin', { chartDataKey: 'time_series', tableId: 'main' })

      const hyperliquidData = extractJson(getText(hyperliquidResult))
      expectItems(getText(hyperliquidResult), 'portal_get_time_series hyperliquid', 12)
      assert(hyperliquidData.summary?.metric === 'volume', 'Expected Hyperliquid metric summary')
      expectWindowMetadata(hyperliquidData, 'portal_get_time_series hyperliquid')
      expectPresentation(hyperliquidData, 'portal_get_time_series hyperliquid', { chartDataKey: 'time_series', tableId: 'main' })
    },
  },
  {
    name: 'portal_evm_query_transactions',
    prompt: 'show me a few raw Base transactions so I can inspect them',
    args: (context) => ({ network: 'base', from_block: context.baseHead - 200, to_block: context.baseHead, limit: 3, field_preset: 'minimal' }),
    validate: (text) => {
      const data = extractJson(text)
      const items = getItems(data)
      assert(items.length === 3, 'Expected 3 EVM transactions')
      expectWindowMetadata(data, 'portal_evm_query_transactions')
      expectOrdering(data, 'portal_evm_query_transactions')
    },
  },
  {
    name: 'portal_evm_query_logs',
    prompt: 'show me recent USDC event logs on Base',
    args: (context) => ({ network: 'base', from_block: context.baseHead - 200, to_block: context.baseHead, addresses: [context.usdcBase], limit: 3, field_preset: 'minimal' }),
    validate: (text, context) => {
      const data = extractJson(text)
      const items = getItems(data)
      assert(items[0].address?.toLowerCase() === context.usdcBase, 'Expected USDC log results')
      expectWindowMetadata(data, 'portal_evm_query_logs')
      expectOrdering(data, 'portal_evm_query_logs')
    },
    validateFollowUp: async (_text, client, context) => {
      const decodeResult = await client.callTool({
        name: 'portal_evm_query_logs',
        arguments: {
          network: 'base',
          from_block: context.baseHead - 200,
          to_block: context.baseHead,
          addresses: [context.usdcBase],
          limit: 1,
          decode: true,
        },
      })
      const data = extractJson(getText(decodeResult))
      const items = getItems(data)
      assert(items[0].decoded_log !== undefined, 'Expected decoded_log on EVM log results')
      expectWindowMetadata(data, 'portal_evm_query_logs decode')
    },
  },
  {
    name: 'portal_evm_query_token_transfers',
    prompt: 'did USDC move around on Base recently',
    args: (context) => ({ network: 'base', from_block: context.baseHead - 200, to_block: context.baseHead, token_addresses: [context.usdcBase], limit: 3 }),
    validate: (text, context) => {
      const data = extractJson(text)
      const items = getItems(data)
      assert(items[0].token_address?.toLowerCase() === context.usdcBase, 'Expected USDC transfers')
      expectWindowMetadata(data, 'portal_evm_query_token_transfers')
      expectOrdering(data, 'portal_evm_query_token_transfers')
    },
  },
  {
    name: 'portal_evm_get_contract_activity',
    prompt: 'what has this Base contract been doing',
    args: (context) => ({ network: 'base', contract_address: context.baseUniswapV3Pool, timeframe: '1h' }),
    validate: (text) => {
      const data = extractJson(text)
      assert(data.interactions !== undefined || data.overview !== undefined, 'Expected contract activity payload')
      expectWindowMetadata(data, 'portal_evm_get_contract_activity')
    },
  },
  {
    name: 'portal_evm_get_analytics',
    prompt: 'give me the big picture for Base activity',
    args: () => ({ network: 'base', timeframe: '1h', limit: 3 }),
    validate: (text) => {
      const data = extractJson(text)
      assert(Array.isArray(data.top_contracts), 'Expected top_contracts section')
      assert(data.overview !== undefined, 'Expected overview section')
      expectWindowMetadata(data, 'portal_evm_get_analytics')
      expectOrdering(data, 'portal_evm_get_analytics')
    },
  },
  {
    name: 'portal_evm_get_ohlc',
    prompt: 'make me price candles for this Base pool',
    args: (context) => ({ network: 'base', pool_address: context.baseUniswapV3Pool, source: 'uniswap_v3_swap', duration: '1h', interval: 'auto' }),
    validate: (text) => {
      const data = extractJson(text)
      const candles = Array.isArray(data.ohlc) ? data.ohlc : getItems(data)
      assert(candles.length > 0, 'Expected EVM candles')
      expectWindowMetadata(data, 'portal_evm_get_ohlc')
      expectGapDiagnostics(data, 'portal_evm_get_ohlc')
      expectOrdering(data, 'portal_evm_get_ohlc')
      expectPresentation(data, 'portal_evm_get_ohlc', { chartDataKey: 'ohlc', tableId: 'ohlc' })
    },
  },
  {
    name: 'portal_solana_query_transactions',
    prompt: 'show me some recent Solana transactions',
    args: (context) => ({ network: 'solana-mainnet', from_block: context.solHead - 20, to_block: context.solHead, limit: 3 }),
    validate: (text) => {
      const data = extractJson(text)
      expectItems(text, 'portal_solana_query_transactions', 1)
      expectWindowMetadata(data, 'portal_solana_query_transactions')
      expectOrdering(data, 'portal_solana_query_transactions')
    },
  },
  {
    name: 'portal_solana_query_instructions',
    prompt: 'show me recent Solana token program instructions',
    args: (context) => ({ network: 'solana-mainnet', from_block: context.solHead - 50, to_block: context.solHead, program_id: [context.tokenProgram], limit: 3 }),
    validate: (text) => {
      const data = extractJson(text)
      expectItems(text, 'portal_solana_query_instructions', 1)
      expectWindowMetadata(data, 'portal_solana_query_instructions')
      expectOrdering(data, 'portal_solana_query_instructions')
    },
  },
  {
    name: 'portal_solana_get_analytics',
    prompt: 'give me the big picture for Solana right now',
    args: () => ({ network: 'solana-mainnet', timeframe: '15m', include_programs: false }),
    validate: (text) => {
      const data = extractJson(text)
      assert(data.network !== undefined || data.overview !== undefined, 'Expected Solana analytics payload')
      expectWindowMetadata(data, 'portal_solana_get_analytics')
    },
  },
  {
    name: 'portal_bitcoin_query_transactions',
    prompt: 'show me a few recent Bitcoin transactions',
    args: () => ({ network: 'bitcoin-mainnet', timeframe: '1h', limit: 3 }),
    validate: (text) => {
      const data = extractJson(text)
      expectItems(text, 'portal_bitcoin_query_transactions', 1)
      expectWindowMetadata(data, 'portal_bitcoin_query_transactions')
      expectOrdering(data, 'portal_bitcoin_query_transactions')
    },
    validateFollowUp: async (_text, client) => {
      const ioResult = await client.callTool({
        name: 'portal_bitcoin_query_transactions',
        arguments: { network: 'bitcoin-mainnet', timeframe: '1h', limit: 1, include_inputs: true, include_outputs: true },
      })
      const data = extractJson(getText(ioResult))
      const items = getItems(data)
      assert(items[0].inputs !== undefined, 'Expected inline inputs')
      assert(items[0].outputs !== undefined, 'Expected inline outputs')
      expectWindowMetadata(data, 'portal_bitcoin_query_transactions io')
    },
  },
  {
    name: 'portal_bitcoin_get_analytics',
    prompt: 'give me the big picture for Bitcoin right now',
    args: () => ({ network: 'bitcoin-mainnet', timeframe: '1h', response_format: 'summary' }),
    validate: (text) => {
      const data = extractJson(text)
      assert(data.overview !== undefined, 'Expected Bitcoin analytics summary')
      expectWindowMetadata(data, 'portal_bitcoin_get_analytics')
    },
  },
  {
    name: 'portal_hyperliquid_query_fills',
    prompt: 'show me some recent Hyperliquid fills',
    args: () => ({ network: 'hyperliquid-fills', timeframe: '5m', limit: 3 }),
    validate: (text) => {
      const data = extractJson(text)
      expectItems(text, 'portal_hyperliquid_query_fills', 1)
      expectWindowMetadata(data, 'portal_hyperliquid_query_fills')
      expectOrdering(data, 'portal_hyperliquid_query_fills')
    },
  },
  {
    name: 'portal_hyperliquid_get_analytics',
    prompt: 'give me the big picture for Hyperliquid fills',
    args: () => ({ network: 'hyperliquid-fills', timeframe: '1h' }),
    validate: (text) => {
      const data = extractJson(text)
      assert(data.volume_by_coin !== undefined || data.overview !== undefined, 'Expected Hyperliquid analytics sections')
      expectWindowMetadata(data, 'portal_hyperliquid_get_analytics')
    },
  },
  {
    name: 'portal_hyperliquid_get_ohlc',
    prompt: 'make me BTC candles from recent Hyperliquid fills',
    args: () => ({ network: 'hyperliquid-fills', coin: 'BTC', duration: '1h', interval: 'auto' }),
    validate: (text) => {
      const data = extractJson(text)
      const candles = Array.isArray(data.ohlc) ? data.ohlc : getItems(data)
      assert(candles.length > 0, 'Expected Hyperliquid candles')
      expectWindowMetadata(data, 'portal_hyperliquid_get_ohlc')
      expectGapDiagnostics(data, 'portal_hyperliquid_get_ohlc')
      expectOrdering(data, 'portal_hyperliquid_get_ohlc')
      expectPresentation(data, 'portal_hyperliquid_get_ohlc', { chartDataKey: 'ohlc', tableId: 'ohlc' })
    },
  },
  {
    name: 'portal_debug_query_blocks',
    prompt: 'show me the last few Base blocks directly',
    args: () => ({ network: 'base', from_timestamp: '10m ago', to_timestamp: 'now', limit: 3 }),
    validate: (text) => {
      const data = extractJson(text)
      expectItems(text, 'portal_debug_query_blocks', 3)
      expectWindowMetadata(data, 'portal_debug_query_blocks')
      expectOrdering(data, 'portal_debug_query_blocks')
    },
  },
  {
    name: 'portal_debug_resolve_time_to_block',
    prompt: 'what Base block matches this timestamp',
    args: (context) => ({ network: 'base', timestamp: new Date((context.nowTimestamp - 24 * 3600) * 1000).toISOString() }),
    validate: (text) => {
      const data = extractJson(text)
      assert(typeof data.block_number === 'number' && data.block_number > 0, 'Expected a block number')
      assert(typeof data.timestamp_human === 'string', 'Expected human-readable timestamp')
      assert(typeof data.resolution === 'string', 'Expected resolution kind')
      expectWindowMetadata(data, 'portal_debug_resolve_time_to_block')
    },
  },
  {
    name: 'portal_debug_hyperliquid_query_replica_commands',
    prompt: 'show me recent Hyperliquid order and cancel commands',
    args: () => ({
      network: 'hyperliquid-replica-cmds',
      from_timestamp: '5m ago',
      to_timestamp: 'now',
      action_type: ['order'],
      limit: 1,
    }),
    validate: (text) => {
      const data = extractJson(text)
      expectItems(text, 'portal_debug_hyperliquid_query_replica_commands', 1)
      expectWindowMetadata(data, 'portal_debug_hyperliquid_query_replica_commands')
      expectOrdering(data, 'portal_debug_hyperliquid_query_replica_commands')
    },
  },
]
