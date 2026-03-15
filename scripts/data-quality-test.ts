#!/usr/bin/env tsx
/**
 * Data quality test: prints actual tool output so we can verify
 * the data is useful, readable, and contains what a user needs.
 *
 * Run: npx tsx scripts/data-quality-test.ts
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

function getText(result: any): string {
  return result?.content?.[0]?.text || ''
}

function divider(label: string) {
  console.log(`\n${'='.repeat(70)}`)
  console.log(`  ${label}`)
  console.log(`${'='.repeat(70)}`)
}

function truncate(text: string, maxLines = 40): string {
  const lines = text.split('\n')
  if (lines.length <= maxLines) return text
  return lines.slice(0, maxLines).join('\n') + `\n... (${lines.length - maxLines} more lines)`
}

async function main() {
  const transport = new StdioClientTransport({ command: 'node', args: ['dist/index.js'] })
  const client = new Client({ name: 'data-quality', version: '1.0.0' })
  await client.connect(transport)

  const { tools } = await client.listTools()
  console.log(`Server: ${tools.length} tools\n`)

  // Get head blocks
  const baseHead = JSON.parse(getText(await client.callTool({ name: 'portal_get_block_number', arguments: { dataset: 'base-mainnet' } })).replace(/^[^{]*/, '')).number
  const solHead = JSON.parse(getText(await client.callTool({ name: 'portal_get_block_number', arguments: { dataset: 'solana-mainnet' } })).replace(/^[^{]*/, '')).number
  const hlHead = JSON.parse(getText(await client.callTool({ name: 'portal_get_block_number', arguments: { dataset: 'hyperliquid-fills' } })).replace(/^[^{]*/, '')).number
  const hlRepHead = JSON.parse(getText(await client.callTool({ name: 'portal_get_block_number', arguments: { dataset: 'hyperliquid-replica-cmds' } })).replace(/^[^{]*/, '')).number

  const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'

  // ---- 1. LIST DATASETS ----
  divider('1. portal_list_datasets — "Show me all EVM mainnets"')
  console.log(truncate(getText(await client.callTool({
    name: 'portal_list_datasets',
    arguments: { chain_type: 'evm', network_type: 'mainnet' },
  }))))

  // ---- 2. GET DATASET INFO ----
  divider('2. portal_get_dataset_info — "Tell me about Base"')
  console.log(truncate(getText(await client.callTool({
    name: 'portal_get_dataset_info',
    arguments: { dataset: 'base' },
  }))))

  // ---- 3. GET BLOCK NUMBER ----
  divider('3. portal_get_block_number — "Latest block on Base"')
  console.log(getText(await client.callTool({
    name: 'portal_get_block_number',
    arguments: { dataset: 'base' },
  })))

  // ---- 4. BLOCK AT TIMESTAMP ----
  divider('4. portal_block_at_timestamp — "What block was Base at 1 hour ago?"')
  console.log(getText(await client.callTool({
    name: 'portal_block_at_timestamp',
    arguments: { dataset: 'base', timestamp: Math.floor(Date.now() / 1000) - 3600 },
  })))

  // ---- 5. QUERY BLOCKS ----
  divider('5. portal_query_blocks — "Show me the last 3 blocks on Base"')
  console.log(truncate(getText(await client.callTool({
    name: 'portal_query_blocks',
    arguments: { dataset: 'base', from_block: baseHead - 5, limit: 3 },
  }))))

  // ---- 6. QUERY LOGS ----
  divider('6. portal_query_logs — "USDC events on Base, last 200 blocks"')
  console.log(truncate(getText(await client.callTool({
    name: 'portal_query_logs',
    arguments: { dataset: 'base', from_block: baseHead - 200, addresses: [USDC], limit: 3, field_preset: 'standard' },
  }))))

  // ---- 7. QUERY TRANSACTIONS ----
  divider('7. portal_query_transactions — "3 recent Base txs"')
  console.log(truncate(getText(await client.callTool({
    name: 'portal_query_transactions',
    arguments: { dataset: 'base', timeframe: '1h', limit: 3, field_preset: 'standard' },
  }))))

  // ---- 8. QUERY TRACES ----
  divider('8. portal_query_traces — "Contract deployments on Base"')
  console.log(truncate(getText(await client.callTool({
    name: 'portal_query_traces',
    arguments: { dataset: 'base', from_block: baseHead - 500, type: ['create'], limit: 3 },
  }))))

  // ---- 9. QUERY STATE DIFFS ----
  divider('9. portal_query_state_diffs — "USDC state changes on Base"')
  console.log(truncate(getText(await client.callTool({
    name: 'portal_query_state_diffs',
    arguments: { dataset: 'base', from_block: baseHead - 20, addresses: [USDC], limit: 3 },
  }))))

  // ---- 10. ERC20 TRANSFERS ----
  divider('10. portal_get_erc20_transfers — "USDC transfers with token info"')
  console.log(truncate(getText(await client.callTool({
    name: 'portal_get_erc20_transfers',
    arguments: { dataset: 'base', from_block: baseHead - 200, token_addresses: [USDC], limit: 3, include_token_info: true },
  }))))

  // ---- 11. NFT TRANSFERS ----
  divider('11. portal_get_nft_transfers — "NFT transfers on Base"')
  console.log(truncate(getText(await client.callTool({
    name: 'portal_get_nft_transfers',
    arguments: { dataset: 'base', from_block: baseHead - 1000, limit: 3 },
  }))))

  // ---- 12. SOLANA INSTRUCTIONS ----
  divider('12. portal_query_solana_instructions — "SPL Token instructions"')
  console.log(truncate(getText(await client.callTool({
    name: 'portal_query_solana_instructions',
    arguments: { dataset: 'solana-mainnet', from_block: solHead - 3, program_id: ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'], limit: 3 },
  }))))

  // ---- 13. SOLANA BALANCES ----
  divider('13. portal_query_solana_balances — "SOL balance changes"')
  console.log(truncate(getText(await client.callTool({
    name: 'portal_query_solana_balances',
    arguments: { dataset: 'solana-mainnet', from_block: solHead - 2, limit: 3 },
  }))))

  // ---- 14. SOLANA TOKEN BALANCES ----
  divider('14. portal_query_solana_token_balances — "SPL token balance changes"')
  console.log(truncate(getText(await client.callTool({
    name: 'portal_query_solana_token_balances',
    arguments: { dataset: 'solana-mainnet', from_block: solHead - 2, limit: 3 },
  }))))

  // ---- 15. SOLANA LOGS ----
  divider('15. portal_query_solana_logs — "Solana program logs"')
  console.log(truncate(getText(await client.callTool({
    name: 'portal_query_solana_logs',
    arguments: { dataset: 'solana-mainnet', from_block: solHead - 2, program_id: ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'], limit: 3 },
  }))))

  // ---- 16. SOLANA REWARDS ----
  divider('16. portal_query_solana_rewards — "Block rewards"')
  console.log(truncate(getText(await client.callTool({
    name: 'portal_query_solana_rewards',
    arguments: { dataset: 'solana-mainnet', from_block: solHead - 3, limit: 3 },
  }))))

  // ---- 17. HYPERLIQUID FILLS ----
  divider('17. portal_query_hyperliquid_fills — "Recent trade fills"')
  console.log(truncate(getText(await client.callTool({
    name: 'portal_query_hyperliquid_fills',
    arguments: { dataset: 'hyperliquid-fills', from_block: hlHead - 50, limit: 3, include_pnl: true, include_builder_info: true },
  }))))

  // ---- 18. HYPERLIQUID FILLS (filtered) ----
  divider('18. portal_query_hyperliquid_fills — "ETH fills only"')
  console.log(truncate(getText(await client.callTool({
    name: 'portal_query_hyperliquid_fills',
    arguments: { dataset: 'hyperliquid-fills', from_block: hlHead - 500, coin: ['ETH'], limit: 3, include_pnl: true },
  }))))

  // ---- 19. HYPERLIQUID REPLICA CMDS ----
  divider('19. portal_query_hyperliquid_replica_cmds — "Recent order actions"')
  console.log(truncate(getText(await client.callTool({
    name: 'portal_query_hyperliquid_replica_cmds',
    arguments: { dataset: 'hyperliquid-replica-cmds', from_block: hlRepHead - 50, limit: 3 },
  }))))

  // ---- 20. HYPERLIQUID REPLICA CMDS (filtered) ----
  divider('20. portal_query_hyperliquid_replica_cmds — "Only successful orders"')
  console.log(truncate(getText(await client.callTool({
    name: 'portal_query_hyperliquid_replica_cmds',
    arguments: { dataset: 'hyperliquid-replica-cmds', from_block: hlRepHead - 200, action_type: ['order'], status: 'ok', limit: 3 },
  }))))

  // ---- 21. STREAM (raw) ----
  divider('21. portal_stream — "Raw block headers"')
  console.log(truncate(getText(await client.callTool({
    name: 'portal_stream',
    arguments: { dataset: 'base', query: { fromBlock: baseHead - 2, toBlock: baseHead, fields: { block: { number: true, timestamp: true, hash: true } }, includeAllBlocks: true } },
  }))))

  // ---- 22. DECODE LOGS ----
  divider('22. portal_decode_logs — "Decode USDC events"')
  console.log(truncate(getText(await client.callTool({
    name: 'portal_decode_logs',
    arguments: { dataset: 'base', from_block: baseHead - 100, addresses: [USDC], limit: 3 },
  }))))

  // ---- 23. RECENT TRANSACTIONS ----
  divider('23. portal_get_recent_transactions — "Last 3 txs on Polygon"')
  console.log(truncate(getText(await client.callTool({
    name: 'portal_get_recent_transactions',
    arguments: { dataset: 'polygon', timeframe: '100', limit: 3 },
  }))))

  // ---- 24. WALLET SUMMARY ----
  divider('24. portal_get_wallet_summary — "What has this wallet been doing?"')
  console.log(truncate(getText(await client.callTool({
    name: 'portal_get_wallet_summary',
    arguments: { dataset: 'base', address: '0x3304e22ddaa22bcdc5fca2269b418046ae7b566a', timeframe: '1000', include_tokens: true, limit_per_type: 3 },
  }))))

  // ---- 25. CONTRACT ACTIVITY ----
  divider('25. portal_get_contract_activity — "How active is USDC on Base?"')
  console.log(truncate(getText(await client.callTool({
    name: 'portal_get_contract_activity',
    arguments: { dataset: 'base', contract_address: USDC, timeframe: '1000' },
  }))))

  // ---- 26. TRANSACTION DENSITY ----
  divider('26. portal_get_transaction_density — "How busy is Base?"')
  console.log(truncate(getText(await client.callTool({
    name: 'portal_get_transaction_density',
    arguments: { dataset: 'base', num_blocks: 10 },
  }))))

  // ---- 27. GAS ANALYTICS ----
  divider('27. portal_get_gas_analytics — "Gas prices on Base"')
  console.log(truncate(getText(await client.callTool({
    name: 'portal_get_gas_analytics',
    arguments: { dataset: 'base', timeframe: '1h' },
  }))))

  // ---- 28. TOP CONTRACTS ----
  divider('28. portal_get_top_contracts — "Most active contracts on Base"')
  console.log(truncate(getText(await client.callTool({
    name: 'portal_get_top_contracts',
    arguments: { dataset: 'base', num_blocks: 200, limit: 5 },
  }))))

  // ---- 29. TIME SERIES ----
  divider('29. portal_get_time_series — "Hourly tx count, last 6h"')
  console.log(truncate(getText(await client.callTool({
    name: 'portal_get_time_series',
    arguments: { dataset: 'base', metric: 'transaction_count', interval: '1h', duration: '6h' },
  }))))

  // ---- 30. TOKEN INFO ----
  divider('30a. portal_get_token_info — "What token is this address?"')
  console.log(truncate(getText(await client.callTool({
    name: 'portal_get_token_info',
    arguments: { chain: 'base', address: USDC },
  }))))

  divider('30b. portal_get_token_info — "Find WETH by symbol"')
  console.log(truncate(getText(await client.callTool({
    name: 'portal_get_token_info',
    arguments: { chain: 'ethereum', symbol: 'WETH' },
  }))))

  // ---- 31. COUNT EVENTS ----
  divider('31. portal_count_events — "How many USDC events in 1h?"')
  console.log(truncate(getText(await client.callTool({
    name: 'portal_count_events',
    arguments: { dataset: 'base', timeframe: '1h', addresses: [USDC] },
  }))))

  // ---- 32. AGGREGATE TRANSFERS ----
  divider('32. portal_aggregate_transfers — "USDC transfer volume"')
  console.log(truncate(getText(await client.callTool({
    name: 'portal_aggregate_transfers',
    arguments: { dataset: 'base', timeframe: '1h', token_address: USDC },
  }))))

  console.log(`\n${'='.repeat(70)}`)
  console.log('  DATA QUALITY REVIEW COMPLETE')
  console.log(`${'='.repeat(70)}`)

  await client.close()
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
