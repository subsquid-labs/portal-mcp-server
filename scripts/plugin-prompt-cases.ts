export type PluginPromptCase = {
  prompt: string
  tool: string
  arguments: Record<string, unknown>
  why: string
  validate: (data: any) => void
}

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message)
}

export const PLUGIN_PROMPT_CASES: PluginPromptCase[] = [
  {
    prompt: 'Show me up to 200 BTC perp fills on Hyperliquid from the past hour.',
    tool: 'portal_hyperliquid_query_fills',
    arguments: {
      network: 'hyperliquid-fills',
      timeframe: '1h',
      coin: ['BTC'],
      limit: 200,
    },
    why: 'A bounded timeframe makes the starter prompt executable instead of relying on limit alone.',
    validate: (data) => {
      assert(Array.isArray(data.items) && data.items.length > 0, 'BTC fills prompt should return rows')
      assert(data._pagination?.returned > 0, 'BTC fills prompt should report returned rows')
      assert(data._pagination?.returned <= 200, 'BTC fills prompt should respect its 200-row limit')
    },
  },
  {
    prompt: 'How many transactions landed on Base in the past 2h?',
    tool: 'portal_evm_get_analytics',
    arguments: {
      network: 'base',
      timeframe: '2h',
      limit: 10,
    },
    why: 'The analytics tool computes the transaction count across the complete two-hour window.',
    validate: (data) => {
      assert(
        typeof data.answer === 'string' && /transactions on Base/i.test(data.answer),
        'Base count prompt should return a transaction count',
      )
      assert(data._coverage?.window_complete === true, 'Base count prompt should cover the complete requested window')
    },
  },
  {
    prompt: 'Show me the 20 most recent USDC transfers on Base from the past hour.',
    tool: 'portal_evm_query_token_transfers',
    arguments: {
      network: 'base',
      timeframe: '1h',
      token_symbols: ['USDC'],
      limit: 20,
    },
    why: 'A bounded recent-row request avoids claiming an aggregate over incomplete cursor pages.',
    validate: (data) => {
      assert(Array.isArray(data.items) && data.items.length > 0, 'USDC prompt should return transfer rows')
      assert(data._pagination?.returned === 20, 'USDC prompt should return the requested 20 matches')
      assert(
        data.items.every((item: any) => item.sender && item.recipient && item.tx_hash),
        'USDC rows should expose sender, recipient, and transaction hash',
      )
    },
  },
]
