import { TOOL_SPECS } from './tool-manifest.ts'

export interface RoutingEvalCase {
  prompt: string
  expected: string
  max_rank?: number
  acceptable?: string[]
  source: 'manifest' | 'extra'
}

const MANIFEST_ROUTING_CASES: RoutingEvalCase[] = TOOL_SPECS.map((spec) => ({
  prompt: spec.prompt,
  expected: spec.name,
  max_rank: 1,
  source: 'manifest',
}))

const EXTRA_ROUTING_CASES: RoutingEvalCase[] = [
  { prompt: 'which chain name am i supposed to use for Base', expected: 'portal_list_networks', max_rank: 1, source: 'extra' },
  { prompt: 'is monad indexed yet or is it behind', expected: 'portal_get_network_info', max_rank: 1, source: 'extra' },
  { prompt: 'what is the current head on optimism', expected: 'portal_get_head', max_rank: 1, source: 'extra' },
  { prompt: 'show me recent stuff on solana without making me think too hard', expected: 'portal_get_recent_activity', max_rank: 1, source: 'extra' },
  { prompt: 'i have a wallet address, can you just summarize what it has been doing', expected: 'portal_get_wallet_summary', max_rank: 1, source: 'extra' },
  { prompt: 'graph transactions on base over the last 24h', expected: 'portal_get_time_series', max_rank: 1, source: 'extra' },
  { prompt: 'give me raw base transactions from the last hour', expected: 'portal_evm_query_transactions', max_rank: 1, source: 'extra' },
  {
    prompt: 'show me usdc transfer events on base',
    expected: 'portal_evm_query_logs',
    acceptable: ['portal_evm_query_token_transfers'],
    max_rank: 2,
    source: 'extra',
  },
  { prompt: 'just show me token transfers for usdc on base, not all logs', expected: 'portal_evm_query_token_transfers', max_rank: 1, source: 'extra' },
  { prompt: 'is this base contract busy lately', expected: 'portal_evm_get_contract_activity', max_rank: 1, source: 'extra' },
  { prompt: 'what are the hottest contracts on base right now', expected: 'portal_evm_get_analytics', max_rank: 1, source: 'extra' },
  { prompt: 'make me 5 minute candles for this pool on base', expected: 'portal_evm_get_ohlc', max_rank: 1, source: 'extra' },
  { prompt: 'show me raw solana transactions for the last few slots', expected: 'portal_solana_query_transactions', max_rank: 1, source: 'extra' },
  { prompt: 'show me token program instructions on solana', expected: 'portal_solana_query_instructions', max_rank: 1, source: 'extra' },
  { prompt: 'how healthy is solana right now', expected: 'portal_solana_get_analytics', max_rank: 1, source: 'extra' },
  { prompt: 'show me raw bitcoin transactions with inputs and outputs', expected: 'portal_bitcoin_query_transactions', max_rank: 1, source: 'extra' },
  { prompt: 'how is bitcoin mainnet doing right now', expected: 'portal_bitcoin_get_analytics', max_rank: 1, source: 'extra' },
  { prompt: 'show me raw polkadot events with the parent extrinsic', expected: 'portal_substrate_query_events', max_rank: 1, source: 'extra' },
  { prompt: 'show me raw polkadot calls and the events they emitted', expected: 'portal_substrate_query_calls', max_rank: 1, source: 'extra' },
  { prompt: 'how is polkadot doing in this indexed window', expected: 'portal_substrate_get_analytics', max_rank: 1, source: 'extra' },
  { prompt: 'show me the latest fills on hyperliquid', expected: 'portal_hyperliquid_query_fills', max_rank: 1, source: 'extra' },
  { prompt: 'who traded the most on hyperliquid lately', expected: 'portal_hyperliquid_get_analytics', max_rank: 1, source: 'extra' },
  { prompt: 'give me eth candles on hyperliquid for the last 6 hours', expected: 'portal_hyperliquid_get_ohlc', max_rank: 1, source: 'extra' },
  { prompt: 'i am debugging, show me raw base blocks directly', expected: 'portal_debug_query_blocks', max_rank: 1, source: 'extra' },
  { prompt: 'what base block matches this exact timestamp', expected: 'portal_debug_resolve_time_to_block', max_rank: 1, source: 'extra' },
  { prompt: 'i need raw hyperliquid order and cancel commands, not fills', expected: 'portal_debug_hyperliquid_query_replica_commands', max_rank: 1, source: 'extra' },
]

export const ROUTING_EVAL_CASES: RoutingEvalCase[] = [
  ...MANIFEST_ROUTING_CASES,
  ...EXTRA_ROUTING_CASES,
]
