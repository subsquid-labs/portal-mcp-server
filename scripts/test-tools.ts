#!/usr/bin/env tsx
/**
 * Test script: exercises every MCP tool against live Portal API.
 * Run: npx tsx scripts/test-tools.ts
 *
 * Uses the MCP Client SDK to connect to our server via stdio transport,
 * then calls each tool with test parameters and validates the response.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

// ============================================================================
// Test Definitions
// ============================================================================

interface ToolTest {
  name: string
  args: Record<string, unknown>
  validate: (result: any) => void
}

// We'll get the latest block dynamically
let latestBlock = 0

const tests: ToolTest[] = [
  // --- Dataset Tools ---
  {
    name: 'portal_list_datasets',
    args: { chain_type: 'evm', network_type: 'mainnet' },
    validate: (r) => {
      const text = r.content[0].text
      assert(text.includes('Found'), 'Should report found datasets')
      const data = extractJson(text)
      assert(Array.isArray(data) || data.items, 'Should return array or items')
      const items = data.items || data
      assert(items.length > 10, `Expected >10 mainnet EVM datasets, got ${items.length}`)
      // Check metadata fields are present from expanded endpoint
      const first = items[0]
      assert(first.kind === 'evm', `Expected kind=evm, got ${first.kind}`)
    },
  },
  {
    name: 'portal_list_datasets',
    args: { query: 'base' },
    validate: (r) => {
      const text = r.content[0].text
      const data = extractJson(text)
      const items = data.items || data
      assert(items.some((d: any) => d.dataset === 'base-mainnet'), 'Should find base-mainnet')
    },
  },
  {
    name: 'portal_get_dataset_info',
    args: { dataset: 'base-mainnet' },
    validate: (r) => {
      const data = extractJson(r.content[0].text)
      assert(data.kind === 'evm', 'base-mainnet should be evm')
      assert(data.head?.number > 0, 'Should have head block')
      assert(data.tables?.includes('transactions'), 'Should have transactions table')
      latestBlock = data.head.number // capture for later tests
    },
  },

  // --- EVM Core Tools ---
  {
    name: 'portal_get_block_number',
    args: { dataset: 'base-mainnet' },
    validate: (r) => {
      const data = extractJson(r.content[0].text)
      assert(data.number > 0, 'Should return block number')
    },
  },
  {
    name: 'portal_block_at_timestamp',
    args: { dataset: 'base-mainnet', timestamp: Math.floor(Date.now() / 1000) - 3600 },
    validate: (r) => {
      const data = extractJson(r.content[0].text)
      assert(data.block_number > 0, 'Should return block number for timestamp')
    },
  },
  {
    name: 'portal_query_blocks',
    args: { dataset: 'base-mainnet', from_block: -1, limit: 3 }, // -1 = will be replaced
    validate: (r) => {
      const text = r.content[0].text
      assert(text.includes('Retrieved'), 'Should report retrieved blocks')
    },
  },
  {
    name: 'portal_query_logs',
    args: {
      dataset: 'base-mainnet',
      from_block: -1, // will be replaced
      addresses: ['0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'], // USDC on Base
      limit: 5,
      field_preset: 'minimal',
    },
    validate: (r) => {
      const text = r.content[0].text
      assert(text.includes('Retrieved') || text.includes('Log'), 'Should report results')
    },
  },
  {
    name: 'portal_query_transactions',
    args: {
      dataset: 'base-mainnet',
      timeframe: '1h',
      limit: 3,
      field_preset: 'minimal',
    },
    validate: (r) => {
      const text = r.content[0].text
      assert(text.includes('Retrieved') || text.includes('Transaction'), 'Should report results')
    },
  },
  {
    name: 'portal_query_traces',
    args: {
      dataset: 'base-mainnet',
      from_block: -1, // will be replaced
      type: ['create'],
      limit: 3,
    },
    validate: (r) => {
      const text = r.content[0].text
      assert(text.includes('Retrieved') || text.includes('traces') || text.includes('Trace'), 'Should report trace results')
    },
  },
  {
    name: 'portal_query_state_diffs',
    args: {
      dataset: 'base-mainnet',
      from_block: -5, // will be replaced — use small range, state diffs are very dense
      limit: 3,
    },
    validate: (r) => {
      const text = r.content[0].text
      // State diffs may return empty for small ranges, that's OK
      assert(text.length > 0, 'Should return non-empty response')
    },
  },
  {
    name: 'portal_get_erc20_transfers',
    args: {
      dataset: 'base-mainnet',
      from_block: -1, // will be replaced
      token_addresses: ['0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'], // USDC
      limit: 5,
    },
    validate: (r) => {
      const text = r.content[0].text
      assert(text.includes('ERC20') || text.includes('transfer'), 'Should report ERC20 transfers')
    },
  },
  {
    name: 'portal_get_nft_transfers',
    args: {
      dataset: 'base-mainnet',
      from_block: -1, // will be replaced
      limit: 5,
    },
    validate: (r) => {
      const text = r.content[0].text
      assert(text.includes('NFT') || text.includes('transfer'), 'Should report NFT results')
    },
  },

  // --- Solana Tools ---
  {
    name: 'portal_query_solana_instructions',
    args: {
      dataset: 'solana-mainnet',
      from_block: -2, // special placeholder: use latestBlock - 5
      program_id: ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'], // SPL Token program
      limit: 3,
    },
    validate: (r) => {
      const text = r.content[0].text
      assert(text.length > 0, 'Should return Solana instruction data')
    },
  },
  {
    name: 'portal_query_solana_token_balances',
    args: {
      dataset: 'solana-mainnet',
      from_block: -2, // special placeholder: use latestBlock - 5
      limit: 3,
    },
    validate: (r) => {
      const text = r.content[0].text
      assert(text.length > 0, 'Should return Solana token balance data')
    },
  },

  // --- Hyperliquid Tools ---
  {
    name: 'portal_query_hyperliquid_fills',
    args: {
      dataset: 'hyperliquid-fills',
      from_block: -3, // special placeholder: use hlBlock - 100
      limit: 5,
    },
    validate: (r) => {
      const text = r.content[0].text
      assert(text.includes('Retrieved') || text.includes('fill'), 'Should report fills')
    },
  },
  {
    name: 'portal_query_hyperliquid_replica_cmds',
    args: {
      dataset: 'hyperliquid-replica-cmds',
      from_block: -4, // special placeholder: use hlReplicaBlock - 100
      limit: 5,
    },
    validate: (r) => {
      const text = r.content[0].text
      assert(text.includes('Retrieved') || text.includes('action'), 'Should report actions')
    },
  },

  // --- Convenience Tools ---
  {
    name: 'portal_get_recent_transactions',
    args: { dataset: 'base-mainnet', timeframe: '100', limit: 5 },
    validate: (r) => {
      const text = r.content[0].text
      assert(text.includes('Retrieved') || text.includes('transaction'), 'Should report recent txs')
    },
  },
  {
    name: 'portal_get_wallet_summary',
    args: {
      dataset: 'base-mainnet',
      address: '0x3304e22ddaa22bcdc5fca2269b418046ae7b566a', // active Base address
      timeframe: '1000',
      include_tokens: true,
      include_nfts: false,
      limit_per_type: 5,
    },
    validate: (r) => {
      const text = r.content[0].text
      assert(text.includes('Wallet summary') || text.includes('wallet'), 'Should report wallet summary')
    },
  },
  {
    name: 'portal_get_contract_activity',
    args: {
      dataset: 'base-mainnet',
      contract_address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', // USDC
      timeframe: '1000',
    },
    validate: (r) => {
      const text = r.content[0].text
      assert(text.includes('Contract') || text.includes('interaction'), 'Should report contract activity')
    },
  },
  {
    name: 'portal_get_transaction_density',
    args: { dataset: 'base-mainnet', num_blocks: 20 },
    validate: (r) => {
      const text = r.content[0].text
      assert(text.includes('Analyzed') || text.includes('block'), 'Should report density analysis')
    },
  },
  {
    name: 'portal_get_gas_analytics',
    args: { dataset: 'base-mainnet', timeframe: '1h' },
    validate: (r) => {
      const text = r.content[0].text
      assert(text.includes('Analyzed') || text.includes('gas') || text.includes('Gwei'), 'Should report gas analytics')
    },
  },
  {
    name: 'portal_get_top_contracts',
    args: { dataset: 'base-mainnet', num_blocks: 100, limit: 5 },
    validate: (r) => {
      const text = r.content[0].text
      assert(text.includes('Analyzed') || text.includes('contract'), 'Should report top contracts')
    },
  },
  {
    name: 'portal_get_time_series',
    args: { dataset: 'base-mainnet', metric: 'transaction_count', interval: '5m', duration: '1h' },
    validate: (r) => {
      const text = r.content[0].text
      assert(text.includes('Aggregated') || text.includes('transaction_count'), 'Should report time series')
    },
  },

  // --- Utility Tools ---
  {
    name: 'portal_stream',
    args: {
      dataset: 'base-mainnet',
      query: {
        fromBlock: -1, // will be replaced
        toBlock: -1,
        fields: { block: { number: true, timestamp: true } },
        includeAllBlocks: true,
      },
    },
    validate: (r) => {
      const text = r.content[0].text
      assert(text.includes('Retrieved') || text.includes('block'), 'Should return stream data')
    },
  },
  {
    name: 'portal_decode_logs',
    args: {
      dataset: 'base-mainnet',
      from_block: -1, // will be replaced
      addresses: ['0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'],
      limit: 3,
    },
    validate: (r) => {
      const text = r.content[0].text
      assert(text.length > 0, 'Should return decoded log data')
    },
  },

  // --- Enrichment Tools ---
  {
    name: 'portal_get_token_info',
    args: { chain: 'base', address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' },
    validate: (r) => {
      const text = r.content[0].text
      assert(text.includes('USDC') || text.includes('USD Coin'), 'Should identify USDC')
    },
  },

  // --- Aggregation Tools ---
  {
    name: 'portal_count_events',
    args: {
      dataset: 'base-mainnet',
      timeframe: '1h',
      addresses: ['0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'],
    },
    validate: (r) => {
      const text = r.content[0].text
      assert(text.includes('count') || text.includes('event') || text.includes('Counted'), 'Should report event counts')
    },
  },
  {
    name: 'portal_aggregate_transfers',
    args: {
      dataset: 'base-mainnet',
      timeframe: '1h',
      token_addresses: ['0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'],
    },
    validate: (r) => {
      const text = r.content[0].text
      assert(text.includes('transfer') || text.includes('Transfer') || text.includes('aggregate'), 'Should report transfer aggregation')
    },
  },
]

// ============================================================================
// Helpers
// ============================================================================

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function extractJson(text: string): any {
  // Find first { or [ in the text (skip the message prefix)
  const jsonStart = text.search(/[\[{]/)
  if (jsonStart === -1) throw new Error('No JSON found in response')
  return JSON.parse(text.slice(jsonStart))
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  console.log('Starting MCP tool tests...\n')

  // Start server as child process and connect via stdio
  const transport = new StdioClientTransport({
    command: 'node',
    args: ['dist/index.js'],
  })

  const client = new Client({ name: 'test-runner', version: '1.0.0' })
  await client.connect(transport)

  // List available tools
  const { tools } = await client.listTools()
  console.log(`Server reports ${tools.length} tools\n`)

  // Get latest blocks for test data
  const baseHead = await client.callTool({ name: 'portal_get_block_number', arguments: { dataset: 'base-mainnet' } })
  const baseBlock = extractJson((baseHead as any).content[0].text).number
  console.log(`Base latest block: ${baseBlock}`)

  const solHead = await client.callTool({ name: 'portal_get_block_number', arguments: { dataset: 'solana-mainnet' } })
  const solBlock = extractJson((solHead as any).content[0].text).number
  console.log(`Solana latest slot: ${solBlock}`)

  const hlFillsHead = await client.callTool({ name: 'portal_get_block_number', arguments: { dataset: 'hyperliquid-fills' } })
  const hlFillsBlock = extractJson((hlFillsHead as any).content[0].text).number
  console.log(`Hyperliquid fills latest block: ${hlFillsBlock}`)

  let hlReplicaBlock = 0
  try {
    const hlReplicaHead = await client.callTool({ name: 'portal_get_block_number', arguments: { dataset: 'hyperliquid-replica-cmds' } })
    hlReplicaBlock = extractJson((hlReplicaHead as any).content[0].text).number
    console.log(`Hyperliquid replica-cmds latest block: ${hlReplicaBlock}\n`)
  } catch {
    console.log(`Hyperliquid replica-cmds: could not get latest block (dataset may be unavailable)\n`)
  }

  let passed = 0
  let failed = 0
  const failures: { name: string; error: string }[] = []

  for (const test of tests) {
    const testLabel = `${test.name}${Object.keys(test.args).length > 1 ? ` (${JSON.stringify(test.args).slice(0, 60)}...)` : ''}`

    // Replace placeholder block numbers with real ones
    const args = JSON.parse(JSON.stringify(test.args))
    let blockForTest = baseBlock
    if (test.name.includes('solana')) blockForTest = solBlock
    else if (test.name.includes('hyperliquid_fills')) blockForTest = hlFillsBlock
    else if (test.name.includes('hyperliquid_replica')) blockForTest = hlReplicaBlock
    replacePlaceholders(args, blockForTest)

    try {
      const start = Date.now()
      const result = await client.callTool({ name: test.name, arguments: args })
      const elapsed = Date.now() - start

      // Check for error responses
      const text = (result as any).content?.[0]?.text || ''
      if (text.startsWith('Error:') || (result as any).isError) {
        throw new Error(`Tool returned error: ${text.slice(0, 200)}`)
      }

      test.validate(result)

      const speed = elapsed < 1000 ? 'FAST' : elapsed < 3000 ? 'OK' : elapsed < 10000 ? 'SLOW' : 'VERY SLOW'
      console.log(`  PASS  ${testLabel} [${elapsed}ms ${speed}]`)
      passed++
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      console.log(`  FAIL  ${testLabel}`)
      console.log(`        ${errorMsg.slice(0, 200)}`)
      failed++
      failures.push({ name: test.name, error: errorMsg.slice(0, 200) })
    }
  }

  console.log(`\n${'='.repeat(60)}`)
  console.log(`Results: ${passed} passed, ${failed} failed out of ${tests.length} tests`)

  if (failures.length > 0) {
    console.log('\nFailures:')
    failures.forEach((f) => console.log(`  - ${f.name}: ${f.error}`))
  }

  console.log(`${'='.repeat(60)}`)

  await client.close()
  process.exit(failed > 0 ? 1 : 0)
}

function replacePlaceholders(obj: any, latestBlock: number) {
  for (const key of Object.keys(obj)) {
    if (typeof obj[key] === 'object' && obj[key] !== null) {
      replacePlaceholders(obj[key], latestBlock)
    } else if (key === 'from_block' || key === 'fromBlock') {
      if (obj[key] === -1) obj[key] = latestBlock - 500
      else if (obj[key] === -2) obj[key] = latestBlock - 5 // Tiny range (Solana)
      else if (obj[key] === -3) obj[key] = latestBlock - 100 // Hyperliquid fills
      else if (obj[key] === -4) obj[key] = latestBlock - 100 // Hyperliquid replica cmds
      else if (obj[key] === -5) obj[key] = latestBlock - 10 // Tiny range for dense data (state diffs)
    } else if (obj[key] === -1 && (key === 'to_block' || key === 'toBlock')) {
      obj[key] = latestBlock
    }
  }
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
