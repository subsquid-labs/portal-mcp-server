/**
 * Tool Suggestion Engine
 *
 * Helps LLMs pick the right tool for natural language questions.
 * Zero API cost - pure logic based on question keywords and intent.
 */

import { z } from 'zod'

export const suggestToolSchema = z.object({
  question: z.string().describe('Natural language question about blockchain data'),
  dataset: z.string().optional().describe("Dataset/chain if mentioned (e.g., 'ethereum', 'base-mainnet')"),
})

export type SuggestToolInput = z.infer<typeof suggestToolSchema>

interface ToolSuggestion {
  tool: string
  reason: string
  priority: number // 1 = best match, 2 = alternative, 3 = related
  parameters?: Record<string, any>
}

export async function suggestTool(input: SuggestToolInput): Promise<{
  question: string
  suggestions: ToolSuggestion[]
  workflow?: string
}> {
  const q = input.question.toLowerCase()
  const suggestions: ToolSuggestion[] = []

  // Address analysis patterns
  if (q.match(/what is (0x[a-f0-9]{40}|.*address)/i)) {
    suggestions.push({
      tool: 'portal_get_wallet_summary',
      reason: 'Comprehensive wallet analysis with transactions and token transfers',
      priority: 1,
      parameters: { dataset: input.dataset || 'ethereum-mainnet' },
    })
    suggestions.push({
      tool: 'portal_resolve_addresses',
      reason: 'Get just the name/label if address is well-known',
      priority: 2,
    })
  }

  // Contract activity
  if (q.match(/contract.*(active|activity|usage|calls|events)/i)) {
    suggestions.push({
      tool: 'portal_get_contract_activity',
      reason: 'Specific contract usage metrics and top callers',
      priority: 1,
    })
  }

  // Wallet/address activity
  if (q.match(/(wallet|address).*(hold|balance|own|asset)/i)) {
    suggestions.push({
      tool: 'portal_get_wallet_summary',
      reason: 'Wallet transaction and transfer summary',
      priority: 1,
    })
    suggestions.push({
      tool: 'portal_get_token_transfers_for_address',
      reason: 'Detailed token transfers for this address',
      priority: 2,
    })
  }

  // Token analysis
  if (q.match(/token.*(info|detail|decimal|supply)/i) || q.match(/what is (usdc|usdt|dai|weth)/i)) {
    suggestions.push({
      tool: 'portal_get_token_info',
      reason: 'Token metadata (symbol, decimals, total supply)',
      priority: 1,
    })
  }

  // Transfer/transaction counting
  if (q.match(/how many.*(transfer|transaction|swap|trade)/i)) {
    suggestions.push({
      tool: 'portal_count_events',
      reason: 'Fast event counting with optional filtering',
      priority: 1,
      parameters: { timeframe: '24h', top_n: 10 },
    })
    suggestions.push({
      tool: 'portal_aggregate_transfers',
      reason: 'Aggregate transfer volumes if you need totals',
      priority: 2,
    })
  }

  // Comparisons
  if (q.match(/(compare|versus|vs|difference between)/i)) {
    suggestions.push({
      tool: 'portal_batch_query',
      reason: 'Run multiple queries in parallel for comparison',
      priority: 1,
    })
    suggestions.push({
      tool: 'portal_compare_chains',
      reason: 'Compare metrics across different chains',
      priority: 1,
    })
  }

  // Time-based questions
  if (q.match(/when (did|was).*(first|last|deploy|created)/i)) {
    suggestions.push({
      tool: 'portal_find_first_interaction',
      reason: 'Find when an address first interacted with another',
      priority: 1,
    })
    suggestions.push({
      tool: 'portal_get_contract_deployments',
      reason: 'Find contract deployment transactions',
      priority: 2,
    })
  }

  // Transaction density / activity trends
  if (q.match(/(busy|congested|tps|transaction.*(per|rate|volume))/i)) {
    suggestions.push({
      tool: 'portal_get_transaction_density',
      reason: 'Transactions per block over time',
      priority: 1,
    })
    suggestions.push({
      tool: 'portal_get_time_series',
      reason: 'Time-series metrics for trend analysis',
      priority: 2,
    })
  }

  // Gas analytics
  if (q.match(/gas|gwei|fee|cost/i)) {
    suggestions.push({
      tool: 'portal_get_gas_analytics',
      reason: 'Gas price trends and fee analysis',
      priority: 1,
    })
  }

  // Top/trending contracts or addresses
  if (q.match(/(top|most|popular|trending).*(contract|address|token)/i)) {
    suggestions.push({
      tool: 'portal_get_top_contracts',
      reason: 'Most active contracts by transaction count',
      priority: 1,
    })
    suggestions.push({
      tool: 'portal_get_top_addresses',
      reason: 'Most active addresses (wallets/contracts)',
      priority: 2,
    })
  }

  // DeFi protocols - suggest on-chain data tools
  if (q.match(/(defi|protocol|dex|lending|yield|pool)/i)) {
    suggestions.push({
      tool: 'portal_get_top_contracts',
      reason: 'Find most active DEX/DeFi contracts on-chain',
      priority: 1,
    })
    suggestions.push({
      tool: 'portal_get_contract_activity',
      reason: 'Analyze specific protocol contract activity',
      priority: 2,
    })
  }

  // NFT activity
  if (q.match(/nft|erc721|erc1155|collectible/i)) {
    suggestions.push({
      tool: 'portal_get_nft_transfers',
      reason: 'NFT transfer events and minting activity',
      priority: 1,
    })
  }

  // Recent activity
  if (q.match(/recent|latest|last.*(hour|day|week)/i)) {
    suggestions.push({
      tool: 'portal_get_recent_transactions',
      reason: 'Latest transactions for an address or contract',
      priority: 1,
      parameters: { timeframe: '1h' },
    })
  }

  // Raw blockchain queries (advanced users)
  if (q.match(/logs?|events?|emit/i) && q.match(/topic|0x[a-f0-9]{64}/i)) {
    suggestions.push({
      tool: 'portal_query_logs',
      reason: 'Raw event log queries with topic filtering',
      priority: 1,
    })
  }

  if (q.match(/trace|internal.*transaction/i)) {
    suggestions.push({
      tool: 'portal_query_traces',
      reason: 'Internal transaction traces',
      priority: 1,
    })
  }

  if (q.match(/transaction.*detail|tx.*hash|0x[a-f0-9]{64}/i)) {
    suggestions.push({
      tool: 'portal_query_transactions',
      reason: 'Transaction-level data',
      priority: 1,
    })
  }

  // Dataset/chain info
  if (q.match(/available.*(chain|dataset|network)/i) || q.match(/list.*chain/i)) {
    suggestions.push({
      tool: 'portal_get_sqd_info',
      reason: 'List all available datasets and chains',
      priority: 1,
    })
  }

  if (q.match(/block.*(height|number|latest|current)/i)) {
    suggestions.push({
      tool: 'portal_get_block_number',
      reason: 'Get latest block number for a dataset',
      priority: 1,
    })
  }

  // Default fallback
  if (suggestions.length === 0) {
    suggestions.push({
      tool: 'portal_get_sqd_info',
      reason: 'Start by exploring available datasets',
      priority: 2,
    })
    suggestions.push({
      tool: 'portal_get_wallet_summary',
      reason: 'If analyzing an address, get comprehensive wallet overview',
      priority: 2,
    })
  }

  // Sort by priority
  suggestions.sort((a, b) => a.priority - b.priority)

  // Generate workflow suggestion for multi-step queries
  let workflow: string | undefined
  if (q.match(/compare/i) && suggestions.some((s) => s.tool === 'portal_batch_query')) {
    workflow = 'Use portal_batch_query to run parallel queries, then aggregate results for comparison'
  } else if (suggestions.length > 2) {
    workflow = `Multi-step approach: 1) ${suggestions[0].tool} 2) ${suggestions[1].tool} if more detail needed`
  }

  return {
    question: input.question,
    suggestions: suggestions.slice(0, 5), // Top 5 suggestions
    workflow,
  }
}
