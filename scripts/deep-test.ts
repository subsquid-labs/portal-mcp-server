#!/usr/bin/env tsx
/**
 * Deep test: simulates natural-language user queries for every MCP tool.
 * Tests data quality, response structure, and real-world usefulness.
 *
 * Run: npx tsx scripts/deep-test.ts
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

// ============================================================================
// Helpers
// ============================================================================

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function extractJson(text: string): any {
  const jsonStart = text.search(/[\[{]/)
  if (jsonStart === -1) throw new Error('No JSON found in response')
  return JSON.parse(text.slice(jsonStart))
}

function getText(result: any): string {
  return result?.content?.[0]?.text || ''
}

let passed = 0
let failed = 0
const failures: { query: string; error: string }[] = []

async function test(
  client: Client,
  query: string,
  toolName: string,
  args: Record<string, unknown>,
  validate: (text: string, data?: any) => void,
) {
  const label = `[${toolName}] ${query}`
  try {
    const start = Date.now()
    const result = await client.callTool({ name: toolName, arguments: args })
    const elapsed = Date.now() - start
    const text = getText(result)

    if (text.startsWith('Error:') || (result as any).isError) {
      throw new Error(`Tool error: ${text.slice(0, 300)}`)
    }

    validate(text)

    const speed = elapsed < 1000 ? 'FAST' : elapsed < 3000 ? 'OK' : elapsed < 10000 ? 'SLOW' : 'VERY SLOW'
    console.log(`  ✓ ${label} [${elapsed}ms ${speed}]`)
    passed++
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    console.log(`  ✗ ${label}`)
    console.log(`    ${errorMsg.slice(0, 300)}`)
    failed++
    failures.push({ query: label, error: errorMsg.slice(0, 300) })
  }
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  console.log('Deep testing all 30 MCP tools with realistic queries...\n')

  const transport = new StdioClientTransport({ command: 'node', args: ['dist/index.js'] })
  const client = new Client({ name: 'deep-test', version: '1.0.0' })
  await client.connect(transport)

  const { tools } = await client.listTools()
  console.log(`Server reports ${tools.length} tools\n`)

  // Get latest blocks for all chains
  const baseHead = extractJson(getText(await client.callTool({ name: 'portal_get_block_number', arguments: { dataset: 'base-mainnet' } }))).number
  const ethHead = extractJson(getText(await client.callTool({ name: 'portal_get_block_number', arguments: { dataset: 'ethereum-mainnet' } }))).number
  const solHead = extractJson(getText(await client.callTool({ name: 'portal_get_block_number', arguments: { dataset: 'solana-mainnet' } }))).number
  const hlFillsHead = extractJson(getText(await client.callTool({ name: 'portal_get_block_number', arguments: { dataset: 'hyperliquid-fills' } }))).number
  const hlReplicaHead = extractJson(getText(await client.callTool({ name: 'portal_get_block_number', arguments: { dataset: 'hyperliquid-replica-cmds' } }))).number

  console.log(`Base: ${baseHead}, Ethereum: ${ethHead}, Solana: ${solHead}`)
  console.log(`HL Fills: ${hlFillsHead}, HL Replica: ${hlReplicaHead}\n`)

  const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
  const ACTIVE_WALLET = '0x3304e22ddaa22bcdc5fca2269b418046ae7b566a'

  // ============================================================================
  // 1. DATASET TOOLS (2)
  // ============================================================================
  console.log('--- Dataset Discovery ---')

  // "What EVM mainnets are available?"
  await test(client, 'What EVM mainnets are available?', 'portal_list_datasets',
    { chain_type: 'evm', network_type: 'mainnet' },
    (text) => {
      assert(text.includes('Found'), 'Should say how many found')
      const data = extractJson(text)
      const items = data.items || data
      assert(items.length > 10, `Expected >10 EVM mainnets, got ${items.length}`)
      assert(items.some((d: any) => d.dataset === 'base-mainnet'), 'Should include Base')
      // Note: ethereum-mainnet has type:"testnet" in Portal metadata (upstream bug)
      // so it's excluded from mainnet filter. Check that Base is present instead.
      const base = items.find((d: any) => d.dataset === 'base-mainnet')
      assert(base?.kind === 'evm', 'Base should be evm kind')
    })

  // "Find me all Hyperliquid datasets"
  await test(client, 'Find all Hyperliquid datasets', 'portal_list_datasets',
    { query: 'hyperliquid' },
    (text) => {
      const data = extractJson(text)
      const items = data.items || data
      assert(items.length >= 3, `Expected >=3 Hyperliquid datasets, got ${items.length}`)
      assert(items.some((d: any) => d.dataset === 'hyperliquid-fills'), 'Should find hyperliquid-fills')
      assert(items.some((d: any) => d.dataset === 'hyperliquid-mainnet'), 'Should find hyperliquid-mainnet')
    })

  // "Tell me about the Base dataset"
  await test(client, 'Tell me about Base mainnet', 'portal_get_dataset_info',
    { dataset: 'base' },
    (text) => {
      const data = extractJson(text)
      assert(data.kind === 'evm', 'Base should be EVM')
      assert(data.head?.number > 40000000, 'Head should be recent')
      assert(data.tables?.includes('transactions'), 'Should have transactions table')
      assert(data.tables?.includes('logs'), 'Should have logs table')
      assert(data.tables?.includes('traces'), 'Should have traces table')
    })

  // ============================================================================
  // 2. EVM CORE TOOLS (9)
  // ============================================================================
  console.log('\n--- EVM Core ---')

  // "What's the latest block on Base?"
  await test(client, "What's the latest block on Base?", 'portal_get_block_number',
    { dataset: 'base' },
    (text) => {
      const data = extractJson(text)
      assert(data.number > 40000000, `Block number should be >40M, got ${data.number}`)
    })

  // "What block was Base at 1 hour ago?"
  await test(client, 'What block was Base at 1 hour ago?', 'portal_block_at_timestamp',
    { dataset: 'base-mainnet', timestamp: Math.floor(Date.now() / 1000) - 3600 },
    (text) => {
      const data = extractJson(text)
      assert(data.block_number > 0, 'Should return a block number')
      assert(data.block_number < baseHead, 'Should be before current head')
    })

  // "Show me the last 3 blocks on Base"
  await test(client, 'Show me the last 3 blocks on Base', 'portal_query_blocks',
    { dataset: 'base', from_block: baseHead - 5, limit: 3 },
    (text) => {
      assert(text.includes('Retrieved'), 'Should report blocks retrieved')
      const data = extractJson(text)
      const items = Array.isArray(data) ? data : data.items || []
      assert(items.length >= 1, 'Should return at least 1 block')
      // Block data comes wrapped in header object
      const block = items[0]
      const header = block.header || block
      assert(header.number !== undefined, 'Block should have number')
      assert(header.timestamp !== undefined, 'Block should have timestamp')
    })

  // "Show me USDC Transfer events on Base in last 500 blocks"
  await test(client, 'Show USDC events on Base recently', 'portal_query_logs',
    {
      dataset: 'base',
      from_block: baseHead - 500,
      addresses: [USDC_BASE],
      limit: 5,
      field_preset: 'standard',
    },
    (text) => {
      assert(text.includes('Retrieved'), 'Should report logs retrieved')
      const data = extractJson(text)
      const items = Array.isArray(data) ? data : data.items || []
      assert(items.length > 0, 'USDC should have events in 500 blocks')
      const log = items[0]
      assert(log.address?.toLowerCase() === USDC_BASE, 'Log should be from USDC contract')
      assert(log.topics || log.topic0, 'Log should have topics')
    })

  // "Show me 3 recent transactions on Base"
  await test(client, 'Show me 3 recent transactions on Base', 'portal_query_transactions',
    { dataset: 'base', timeframe: '1h', limit: 3, field_preset: 'minimal' },
    (text) => {
      assert(text.includes('Retrieved'), 'Should report txs retrieved')
      const data = extractJson(text)
      const items = Array.isArray(data) ? data : data.items || []
      assert(items.length === 3, `Expected 3 txs, got ${items.length}`)
      const tx = items[0]
      assert(tx.from !== undefined, 'Transaction should have from')
      assert(tx.to !== undefined, 'Transaction should have to')
    })

  // "Find contract deployments on Base in last 500 blocks"
  await test(client, 'Find contract deployments on Base', 'portal_query_traces',
    { dataset: 'base', from_block: baseHead - 500, type: ['create'], limit: 5 },
    (text) => {
      assert(text.includes('Retrieved') || text.includes('traces'), 'Should report traces')
    })

  // "Show me state changes on Base in last 50 blocks"
  await test(client, 'Show state changes on Base', 'portal_query_state_diffs',
    { dataset: 'base', from_block: baseHead - 50, addresses: [USDC_BASE], limit: 5 },
    (text) => {
      assert(text.length > 0, 'Should return non-empty response')
    })

  // "Show me USDC transfers on Base with token info"
  await test(client, 'Show USDC transfers on Base with token info', 'portal_get_erc20_transfers',
    {
      dataset: 'base',
      from_block: baseHead - 500,
      token_addresses: [USDC_BASE],
      limit: 5,
      include_token_info: true,
    },
    (text) => {
      assert(text.includes('ERC20'), 'Should mention ERC20')
      const data = extractJson(text)
      const items = Array.isArray(data) ? data : data.items || []
      assert(items.length > 0, 'Should have USDC transfers')
      const transfer = items[0]
      assert(transfer.from !== undefined, 'Transfer should have from')
      assert(transfer.to !== undefined, 'Transfer should have to')
      assert(transfer.token_address?.toLowerCase() === USDC_BASE, 'Should be USDC')
      assert(transfer.value_formatted !== undefined, 'Should have formatted value')
    })

  // "Show me NFT transfers on Base"
  await test(client, 'Show NFT transfers on Base', 'portal_get_nft_transfers',
    { dataset: 'base', from_block: baseHead - 1000, limit: 5 },
    (text) => {
      assert(text.includes('NFT'), 'Should mention NFT')
    })

  // ============================================================================
  // 3. SOLANA TOOLS (5)
  // ============================================================================
  console.log('\n--- Solana ---')

  // "Show me SPL Token program instructions on Solana"
  await test(client, 'Show SPL Token instructions on Solana', 'portal_query_solana_instructions',
    {
      dataset: 'solana-mainnet',
      from_block: solHead - 3,
      program_id: ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'],
      limit: 5,
    },
    (text) => {
      assert(text.includes('Retrieved'), 'Should report instructions')
      const data = extractJson(text)
      const items = Array.isArray(data) ? data : data.items || []
      assert(items.length > 0, 'Should have SPL Token instructions')
      const instr = items[0]
      assert(instr.programId === 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'Should be SPL Token program')
    })

  // "Show me SOL balance changes"
  await test(client, 'Show SOL balance changes', 'portal_query_solana_balances',
    { dataset: 'solana-mainnet', from_block: solHead - 2, limit: 5 },
    (text) => {
      assert(text.includes('Retrieved'), 'Should report balance changes')
      const data = extractJson(text)
      const items = Array.isArray(data) ? data : data.items || []
      assert(items.length > 0, 'Should have balance changes')
    })

  // "Show me SPL token balance changes"
  await test(client, 'Show SPL token balance changes', 'portal_query_solana_token_balances',
    { dataset: 'solana-mainnet', from_block: solHead - 2, limit: 5 },
    (text) => {
      assert(text.includes('Retrieved'), 'Should report token balance changes')
    })

  // "Show me Solana program logs"
  await test(client, 'Show Solana program logs', 'portal_query_solana_logs',
    {
      dataset: 'solana-mainnet',
      from_block: solHead - 2,
      program_id: ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'],
      limit: 5,
    },
    (text) => {
      assert(text.includes('Retrieved'), 'Should report logs')
    })

  // "Show me Solana block rewards"
  await test(client, 'Show Solana block rewards', 'portal_query_solana_rewards',
    { dataset: 'solana-mainnet', from_block: solHead - 5, limit: 5 },
    (text) => {
      assert(text.includes('Retrieved'), 'Should report rewards')
    })

  // ============================================================================
  // 4. HYPERLIQUID TOOLS (2)
  // ============================================================================
  console.log('\n--- Hyperliquid ---')

  // "Show me recent Hyperliquid trade fills"
  await test(client, 'Show recent Hyperliquid trade fills', 'portal_query_hyperliquid_fills',
    { dataset: 'hyperliquid-fills', from_block: hlFillsHead - 100, limit: 5, include_pnl: true },
    (text) => {
      assert(text.includes('Retrieved'), 'Should report fills retrieved')
      const data = extractJson(text)
      const items = Array.isArray(data) ? data : data.items || []
      assert(items.length > 0, 'Should have fills')
      const fill = items[0]
      assert(fill.coin !== undefined, 'Fill should have coin')
      assert(fill.px !== undefined, 'Fill should have price')
      assert(fill.sz !== undefined, 'Fill should have size')
      assert(fill.side !== undefined, 'Fill should have side (A/B)')
      assert(fill.dir !== undefined, 'Fill should have direction')
      assert(fill.user !== undefined, 'Fill should have user address')
      assert(fill.block_number !== undefined, 'Fill should have block number')
    })

  // "Show me BTC fills on Hyperliquid"
  await test(client, 'Show BTC fills on Hyperliquid', 'portal_query_hyperliquid_fills',
    { dataset: 'hyperliquid-fills', from_block: hlFillsHead - 500, coin: ['BTC'], limit: 5 },
    (text) => {
      const data = extractJson(text)
      const items = Array.isArray(data) ? data : data.items || []
      if (items.length > 0) {
        assert(items.every((f: any) => f.coin === 'BTC'), 'All fills should be BTC')
      }
    })

  // "Show me recent order actions on Hyperliquid"
  await test(client, 'Show recent order actions on Hyperliquid', 'portal_query_hyperliquid_replica_cmds',
    { dataset: 'hyperliquid-replica-cmds', from_block: hlReplicaHead - 100, limit: 5 },
    (text) => {
      assert(text.includes('Retrieved'), 'Should report actions retrieved')
      const data = extractJson(text)
      const items = Array.isArray(data) ? data : data.items || []
      assert(items.length > 0, 'Should have actions')
      const action = items[0]
      assert(action.user !== undefined, 'Action should have user')
      assert(action.status !== undefined, 'Action should have status')
      assert(action.block_number !== undefined, 'Action should have block number')
    })

  // "Show me only order placements on Hyperliquid"
  await test(client, 'Show only order placements on Hyperliquid', 'portal_query_hyperliquid_replica_cmds',
    {
      dataset: 'hyperliquid-replica-cmds',
      from_block: hlReplicaHead - 200,
      action_type: ['order'],
      status: 'ok',
      limit: 3,
    },
    (text) => {
      const data = extractJson(text)
      const items = Array.isArray(data) ? data : data.items || []
      if (items.length > 0) {
        assert(items.every((a: any) => a.status === 'ok'), 'All actions should have status ok')
      }
    })

  // ============================================================================
  // 5. UTILITY TOOLS (2)
  // ============================================================================
  console.log('\n--- Utilities ---')

  // "Raw stream query for block headers"
  await test(client, 'Raw stream: get 3 block headers', 'portal_stream',
    {
      dataset: 'base',
      query: {
        fromBlock: baseHead - 3,
        toBlock: baseHead,
        fields: { block: { number: true, timestamp: true, hash: true } },
        includeAllBlocks: true,
      },
    },
    (text) => {
      assert(text.includes('Retrieved') || text.includes('block'), 'Should return block data')
    })

  // "Decode USDC events on Base"
  await test(client, 'Decode USDC events on Base', 'portal_decode_logs',
    {
      dataset: 'base',
      from_block: baseHead - 200,
      addresses: [USDC_BASE],
      event_types: ['Transfer'],
      limit: 5,
    },
    (text) => {
      assert(text.length > 0, 'Should return decoded logs')
      // Check if decoded events have human-readable names
      if (text.includes('Transfer')) {
        // Great - events are decoded
      }
    })

  // ============================================================================
  // 6. CONVENIENCE TOOLS (7)
  // ============================================================================
  console.log('\n--- Convenience ---')

  // "Show me the last 5 transactions on Polygon"
  await test(client, 'Last 5 transactions on Polygon', 'portal_get_recent_transactions',
    { dataset: 'polygon', timeframe: '100', limit: 5 },
    (text) => {
      assert(text.includes('Retrieved'), 'Should report txs')
      const data = extractJson(text)
      const items = Array.isArray(data) ? data : data.items || []
      assert(items.length === 5, `Expected 5 txs, got ${items.length}`)
    })

  // "What has wallet 0x3304... been doing on Base?"
  await test(client, 'What has wallet been doing on Base?', 'portal_get_wallet_summary',
    {
      dataset: 'base',
      address: ACTIVE_WALLET,
      timeframe: '1000',
      include_tokens: true,
      include_nfts: false,
      limit_per_type: 5,
    },
    (text) => {
      assert(text.includes('Wallet') || text.includes('wallet'), 'Should report wallet summary')
      // Check structure
      const data = extractJson(text)
      assert(data.transactions !== undefined || data.summary !== undefined, 'Should have transaction data')
    })

  // "How active is the USDC contract on Base?"
  await test(client, 'How active is USDC contract on Base?', 'portal_get_contract_activity',
    { dataset: 'base', contract_address: USDC_BASE, timeframe: '1000' },
    (text) => {
      assert(text.includes('Contract') || text.includes('interaction'), 'Should report contract activity')
      const data = extractJson(text)
      assert(data.interactions?.total_transactions > 0, 'USDC should have interactions')
      assert(data.interactions?.unique_callers > 0, 'USDC should have unique callers')
      assert(data.interactions?.top_callers?.length > 0, 'Should have top callers')
      if (data.events) {
        assert(data.events.total_events > 0, 'USDC should emit events')
      }
    })

  // "How busy is Base right now?"
  await test(client, 'How busy is Base right now?', 'portal_get_transaction_density',
    { dataset: 'base', num_blocks: 20 },
    (text) => {
      assert(text.includes('Analyzed') || text.includes('block'), 'Should report density')
      const data = extractJson(text)
      assert(data.items || data.blocks || data.summary, 'Should have density data')
    })

  // "What's gas like on Ethereum right now?"
  await test(client, "What's gas like on Ethereum?", 'portal_get_gas_analytics',
    { dataset: 'ethereum', timeframe: '1h' },
    (text) => {
      assert(text.includes('Analyzed') || text.includes('gas') || text.includes('Gwei'), 'Should report gas')
      const data = extractJson(text)
      assert(data.current_gas || data.statistics || data.current || data.summary, 'Should have gas data')
    })

  // "Which contracts are most active on Base?"
  await test(client, 'Which contracts are most active on Base?', 'portal_get_top_contracts',
    { dataset: 'base', num_blocks: 200, limit: 5 },
    (text) => {
      assert(text.includes('Analyzed') || text.includes('contract'), 'Should report contracts')
      const data = extractJson(text)
      const contracts = data.contracts || data.top_contracts || (Array.isArray(data) ? data : [])
      assert(contracts.length > 0, 'Should have top contracts')
      const top = contracts[0]
      assert(top.address || top.contract_address, 'Contract should have address')
      assert(top.transaction_count || top.count || top.interactions, 'Contract should have count')
    })

  // "Show hourly transaction count on Base for last 24h"
  await test(client, 'Hourly tx count on Base for 24h', 'portal_get_time_series',
    { dataset: 'base', metric: 'transaction_count', interval: '1h', duration: '24h' },
    (text) => {
      assert(text.includes('Aggregated') || text.includes('transaction_count'), 'Should report time series')
      const data = extractJson(text)
      const points = data.time_series || data.data_points || data.series || (Array.isArray(data) ? data : [])
      assert(points.length > 0, 'Should have data points')
    })

  // ============================================================================
  // 7. ENRICHMENT TOOLS (1)
  // ============================================================================
  console.log('\n--- Enrichment ---')

  // "What token is 0x833589fcd6edb6e08f4c7c32d4f71b54bda02913 on Base?"
  await test(client, 'What token is this address on Base?', 'portal_get_token_info',
    { chain: 'base', address: USDC_BASE },
    (text) => {
      assert(text.includes('USDC') || text.includes('USD Coin'), 'Should identify USDC')
    })

  // "Show me all tokens on Base"
  await test(client, 'Show me tokens available on Base', 'portal_get_token_info',
    { chain: 'base', limit: 5 },
    (text) => {
      assert(text.length > 0, 'Should return token list')
    })

  // ============================================================================
  // 8. AGGREGATION TOOLS (2)
  // ============================================================================
  console.log('\n--- Aggregation ---')

  // "How many USDC events in the last hour on Base?"
  await test(client, 'How many USDC events in last hour on Base?', 'portal_count_events',
    { dataset: 'base', timeframe: '1h', addresses: [USDC_BASE] },
    (text) => {
      assert(text.includes('count') || text.includes('event') || text.includes('Counted'), 'Should report counts')
      const data = extractJson(text)
      assert(data.total_events !== undefined || data.count !== undefined || data.total !== undefined, 'Should have event count')
    })

  // "What's the USDC transfer volume on Base in the last hour?"
  await test(client, 'USDC transfer volume on Base last hour', 'portal_aggregate_transfers',
    { dataset: 'base', timeframe: '1h', token_address: USDC_BASE },
    (text) => {
      assert(text.includes('transfer') || text.includes('Transfer') || text.includes('aggregate'), 'Should report transfers')
      const data = extractJson(text)
      assert(data.total_transfers !== undefined || data.count !== undefined || data.summary !== undefined, 'Should have transfer stats')
    })

  // ============================================================================
  // EDGE CASES & ERROR HANDLING
  // ============================================================================
  console.log('\n--- Edge Cases ---')

  // "Use short alias 'eth' instead of 'ethereum-mainnet'"
  await test(client, 'Use short alias: eth', 'portal_get_block_number',
    { dataset: 'eth' },
    (text) => {
      const data = extractJson(text)
      assert(data.number > 0, 'Should resolve eth alias')
    })

  // "Use short alias 'arb' for Arbitrum"
  await test(client, 'Use short alias: arb', 'portal_get_block_number',
    { dataset: 'arb' },
    (text) => {
      const data = extractJson(text)
      assert(data.number > 0, 'Should resolve arb alias')
    })

  // "Minimal field preset for context efficiency"
  await test(client, 'Minimal preset for small response', 'portal_query_logs',
    { dataset: 'base', from_block: baseHead - 100, addresses: [USDC_BASE], limit: 3, field_preset: 'minimal' },
    (text) => {
      assert(text.length > 0, 'Should return data with minimal preset')
      // Minimal should be smaller than full
    })

  // "Summary response format"
  await test(client, 'Summary format for counting', 'portal_query_transactions',
    { dataset: 'base', timeframe: '1h', limit: 3, response_format: 'summary' },
    (text) => {
      assert(text.length > 0, 'Should return summary')
    })

  // ============================================================================
  // RESULTS
  // ============================================================================
  console.log(`\n${'='.repeat(60)}`)
  console.log(`Results: ${passed} passed, ${failed} failed out of ${passed + failed} tests`)

  if (failures.length > 0) {
    console.log('\nFailures:')
    failures.forEach((f) => console.log(`  - ${f.query}\n    ${f.error}`))
  }

  console.log(`${'='.repeat(60)}`)

  await client.close()
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
