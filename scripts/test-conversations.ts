#!/usr/bin/env tsx

import { loadToolTestContext } from './tool-manifest.ts'
import {
  assert,
  assertChatSurface,
  callToolWithRetry,
  classifySpeed,
  closeTestClient,
  connectTestClient,
  printSection,
} from './test-helpers.ts'

type ConversationStep = {
  user: string
  tool: string
  args: (context: Awaited<ReturnType<typeof loadToolTestContext>>) => Record<string, unknown>
  validate?: (data: any) => void
}

type ConversationScenario = {
  name: string
  steps: ConversationStep[]
}

const SCENARIOS: ConversationScenario[] = [
  {
    name: 'Confused Base Newcomer',
    steps: [
      {
        user: "what's the real network name for base",
        tool: 'portal_list_networks',
        args: () => ({ query: 'base', limit: 5 }),
        validate: (data) => {
          assert(Array.isArray(data.items) && data.items.some((item: any) => item.network === 'base-mainnet'), 'Base discovery should include base-mainnet')
        },
      },
      {
        user: 'is base actually caught up right now',
        tool: 'portal_get_network_info',
        args: () => ({ network: 'base' }),
        validate: (data) => {
          assert(data.network === 'base-mainnet', 'Network info should resolve Base correctly')
          assert(data.display?.network === 'Base', 'Display network should be humanized')
        },
      },
      {
        user: "what's been happening there lately",
        tool: 'portal_get_recent_activity',
        args: () => ({ network: 'base', timeframe: '30m', limit: 5 }),
        validate: (data) => {
          assert(Array.isArray(data.items) && data.items.length === 5, 'Recent activity should return 5 items')
        },
      },
      {
        user: 'make me a simple activity chart for the last hour',
        tool: 'portal_get_time_series',
        args: () => ({ network: 'base', metric: 'transaction_count', duration: '1h', interval: '5m' }),
        validate: (data) => {
          assert(Array.isArray(data.time_series) && data.time_series.length >= 12, 'Time series should return chart buckets')
          assert(data.next_steps?.actions?.length > 0, 'Time series should suggest next steps')
          assert(data._ui?.layout, 'Time series should include app layout metadata')
          assert(Array.isArray(data._ui?.panels) && data._ui.panels.length > 0, 'Time series should include app panels')
        },
      },
    ],
  },
  {
    name: 'DEX Trader',
    steps: [
      {
        user: 'make me a quick dexscreener-style chart for this pool',
        tool: 'portal_evm_get_ohlc',
        args: (context) => ({
          network: 'base-mainnet',
          pool_address: context.baseUniswapV3Pool,
          source: 'uniswap_v3_swap',
          duration: '1h',
          interval: '5m',
          mode: 'fast',
          include_recent_trades: true,
          recent_trades_limit: 5,
        }),
        validate: (data) => {
          assert(data.display?.focus, 'OHLC should expose a user-facing focus label')
          assert(data.next_steps?.actions?.some((action: any) => action.label === 'Show recent trades'), 'OHLC should offer recent-trade follow-up')
          assert(Array.isArray(data.recent_trades), 'OHLC should include recent trades')
        },
      },
      {
        user: 'okay now do the deeper version',
        tool: 'portal_evm_get_ohlc',
        args: (context) => ({
          network: 'base-mainnet',
          pool_address: context.baseUniswapV3Pool,
          source: 'uniswap_v3_swap',
          duration: '1h',
          interval: '5m',
          mode: 'deep',
          include_recent_trades: true,
          recent_trades_limit: 5,
        }),
        validate: (data) => {
          assert(data.summary?.mode === 'deep', 'Deep OHLC should preserve mode in summary')
          assert(data.guidance?.recommended_mode !== undefined, 'Deep OHLC should include guidance')
        },
      },
    ],
  },
  {
    name: 'Wallet Investigator',
    steps: [
      {
        user: 'just summarize what this wallet has been doing',
        tool: 'portal_get_wallet_summary',
        args: (context) => ({ network: 'base', address: context.evmWallet, timeframe: '24h' }),
        validate: (data) => {
          assert(data.overview?.vm === 'evm', 'Wallet summary should resolve EVM wallet')
          assert(data.next_steps?.actions?.length > 0, 'Wallet summary should expose next steps')
          assert(Array.isArray(data._ui?.panels) && data._ui.panels.length > 0, 'Wallet summary should include app panels')
        },
      },
      {
        user: 'now show me the raw recent transactions too',
        tool: 'portal_evm_query_transactions',
        args: (context) => ({ network: 'base', from_block: context.baseHead - 150, to_block: context.baseHead, limit: 5, field_preset: 'minimal' }),
        validate: (data) => {
          assert(Array.isArray(data.items) && data.items.length === 5, 'Raw tx follow-up should return rows')
        },
      },
    ],
  },
  {
    name: 'Hyperliquid User',
    steps: [
      {
        user: 'who traded the most on hyperliquid lately',
        tool: 'portal_hyperliquid_get_analytics',
        args: () => ({ network: 'hyperliquid-fills', timeframe: '1h' }),
        validate: (data) => {
          assert(data.display?.network === 'Hyperliquid', 'Hyperliquid analytics should humanize network display')
        },
      },
      {
        user: 'give me btc candles there for the last hour',
        tool: 'portal_hyperliquid_get_ohlc',
        args: () => ({ network: 'hyperliquid-fills', coin: 'BTC', duration: '1h', interval: 'auto' }),
        validate: (data) => {
          assert(Array.isArray(data.candles) || Array.isArray(data.ohlc), 'Hyperliquid OHLC should return candles')
          assert(data.next_steps?.actions?.length > 0, 'Hyperliquid OHLC should expose next steps')
        },
      },
    ],
  },
]

async function main() {
  const connected = await connectTestClient('conversation-test')
  const { client } = connected

  try {
    const context = await loadToolTestContext(client)
    let passed = 0
    let failed = 0

    for (const scenario of SCENARIOS) {
      printSection(`Conversation: ${scenario.name}`)

      try {
        for (const step of scenario.steps) {
          const result = await callToolWithRetry(client, step.tool, step.args(context))
          const data = result.data

          console.log(`USER: ${step.user}`)
          console.log(`TOOL: ${step.tool} [${result.elapsedMs}ms ${classifySpeed(result.elapsedMs)}]`)

          assert(!result.isError, `${scenario.name} step '${step.user}' should not error`)
          assertChatSurface(data, `${scenario.name} -> ${step.tool}`)
          assert(!String(data.display?.title || '').includes('portal_'), `${scenario.name} display title should stay product-friendly`)
          assert(!String(data.display?.network || '').includes('-mainnet'), `${scenario.name} display network should stay humanized`)

          if (step.validate) {
            step.validate(data)
          }
        }

        console.log(`PASS  ${scenario.name}`)
        passed++
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.log(`FAIL  ${scenario.name}`)
        console.log(`      ${message.slice(0, 320)}`)
        failed++
      }
    }

    printSection(`Conversation results: ${passed} passed, ${failed} failed`)
    process.exit(failed > 0 ? 1 : 0)
  } finally {
    await closeTestClient(connected)
  }
}

main().catch((error) => {
  console.error(`Fatal error: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
