#!/usr/bin/env tsx

import {
  assert,
  assertChatSurface,
  callToolWithRetry,
  classifySpeed,
  closeTestClient,
  connectTestClient,
  printSection,
} from './test-helpers.ts'
import { loadToolTestContext } from './tool-manifest.ts'

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
          assert(
            Array.isArray(data.items) && data.items.some((item: any) => item.network === 'base-mainnet'),
            'Base discovery should include base-mainnet',
          )
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
        user: 'make me a simple activity chart',
        tool: 'portal_get_time_series',
        args: () => ({ network: 'base', metric: 'transaction_count', interval: '5m' }),
        validate: (data) => {
          assert(
            Array.isArray(data.time_series) && data.time_series.length >= 3,
            'Time series should return chart buckets',
          )
          assert(
            typeof data.answer === 'string' && data.answer.includes('Base'),
            'Time series should include a concise natural-language answer',
          )
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
          assert(
            data.next_steps?.actions?.some((action: any) => action.label === 'Show recent trades'),
            'OHLC should offer recent-trade follow-up',
          )
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
          assert(
            data.investigation?.version === 'portal_investigation_v1',
            'Wallet summary should include investigation guide',
          )
          assert(
            Array.isArray(data.investigation?.follow_up_filters) && data.investigation.follow_up_filters.length > 0,
            'Wallet summary should suggest follow-up filters',
          )
        },
      },
      {
        user: 'trace suspicious USDC movement on Base and give me evidence pivots',
        tool: 'portal_evm_query_token_transfers',
        args: (context) => ({
          network: 'base',
          from_block: context.baseHead - 2_000,
          to_block: context.baseHead,
          token_symbols: ['USDC'],
          include_token_info: true,
          limit: 2,
        }),
        validate: (data) => {
          assert(
            Array.isArray(data.items) && data.items.length > 0,
            'Suspicious token trace should return transfer rows',
          )
          assert(
            data.investigation?.pivots?.some((pivot: any) =>
              ['from', 'to', 'token_address', 'transaction_hash'].includes(String(pivot.field)),
            ),
            'Suspicious token trace should expose transfer pivots',
          )
        },
      },
      {
        user: 'now show me the raw recent transactions too',
        tool: 'portal_evm_query_transactions',
        args: (context) => ({
          network: 'base',
          from_block: context.baseHead - 150,
          to_block: context.baseHead,
          limit: 5,
          field_preset: 'minimal',
        }),
        validate: (data) => {
          assert(Array.isArray(data.items) && data.items.length === 5, 'Raw tx follow-up should return rows')
        },
      },
    ],
  },
  {
    name: 'EVM Investigator',
    steps: [
      {
        user: 'which tx was the first one on ethereum mainnet with tx type 0x1? start searching from 12,244,000',
        tool: 'portal_evm_query_transactions',
        args: () => ({
          network: 'ethereum-mainnet',
          from_block: 12_244_000,
          to_block: 12_244_200,
          transaction_type: '0x1',
          scan_order: 'earliest',
          limit: 1,
          field_preset: 'minimal',
        }),
        validate: (data) => {
          assert(
            data.items?.[0]?.hash === '0x851bad0415758075a1eb86776749c829b866d43179c57c3e4a4b9359a0358231',
            'EIP-2930 lookup should return the known first type 0x1 tx',
          )
          assert(data._execution?.scan_order === 'earliest', 'EIP-2930 lookup should scan earliest first')
        },
      },
      {
        user: 'show me the first recent USDC Transfer event on Base',
        tool: 'portal_evm_query_logs',
        args: (context) => ({
          network: 'base',
          from_block: context.baseHead - 200,
          to_block: context.baseHead,
          addresses: [context.usdcBase],
          event: 'transfer',
          scan_order: 'latest',
          limit: 1,
          field_preset: 'minimal',
        }),
        validate: (data) => {
          assert(
            Array.isArray(data.items) && data.items.length === 1,
            'Event alias query should return one Transfer log',
          )
          assert(data._execution?.scan_order === 'latest', 'Event alias query should preserve latest scan metadata')
        },
      },
      {
        user: 'who deployed this recent Base contract and what was the deployment tx',
        tool: 'portal_evm_get_contract_deployment',
        args: (context) => ({
          network: 'base',
          contract_address: context.recentDeploymentContract,
          from_block: context.recentDeploymentFromBlock,
          to_block: context.recentDeploymentToBlock,
          scan_order: 'earliest',
        }),
        validate: (data) => {
          assert(
            data.items?.[0]?.deployed_contract_address,
            'Deployment lookup should return deployed contract address',
          )
          assert(data.items?.[0]?.transaction_hash, 'Deployment lookup should return parent transaction hash')
          assert(data.items?.[0]?.deployer, 'Deployment lookup should return deployer')
        },
      },
      {
        user: 'show me the top gas-used USDC transfer calls on Base recently',
        tool: 'portal_evm_query_transactions',
        args: (context) => ({
          network: 'base',
          from_block: context.baseHead - 5_000,
          to_block: context.baseHead,
          to_token_symbols: ['USDC'],
          method: 'transfer',
          order_by: 'gas_used_desc',
          scan_order: 'latest',
          max_scan_blocks: 5_000,
          limit: 3,
          field_preset: 'standard',
        }),
        validate: (data) => {
          assert(Array.isArray(data.items) && data.items.length > 0, 'Ranked transaction query should return rows')
          assert(
            data._execution?.order_by === 'gas_used_desc',
            'Ranked transaction query should expose order_by metadata',
          )
        },
      },
    ],
  },
  {
    name: 'Hyperliquid User',
    steps: [
      {
        user: 'normalize bitcoin for hyperliquid and then use it as a coin filter',
        tool: 'portal_resolve_entity',
        args: () => ({ kind: 'hyperliquid_coin', query: 'bitcoin', limit: 3 }),
        validate: (data) => {
          assert(data.matches?.[0]?.coin === 'BTC', 'Hyperliquid coin resolver should normalize bitcoin to BTC')
          assert(data.suggested_arguments?.coin?.includes('BTC'), 'Resolver should suggest Hyperliquid coin filters')
        },
      },
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
      {
        user: 'show me raw BTC fills too',
        tool: 'portal_hyperliquid_query_fills',
        args: () => ({ network: 'hyperliquid-fills', timeframe: '1h', coin: ['BTC'], limit: 2 }),
        validate: (data) => {
          assert(Array.isArray(data.items) && data.items.length > 0, 'Hyperliquid BTC fill query should return rows')
          assert(
            data.items.every((item: any) => String(item.coin || '').toUpperCase() === 'BTC'),
            'Hyperliquid BTC fill query should preserve coin filter',
          )
        },
      },
    ],
  },
  {
    name: 'Non-EVM Investigator',
    steps: [
      {
        user: 'show me solana program instructions and keep transaction context',
        tool: 'portal_solana_query_instructions',
        args: (context) => ({
          network: 'solana-mainnet',
          from_block: context.solProgramFromBlock,
          to_block: context.solProgramToBlock,
          program_id: context.tokenProgram,
          include_transaction: true,
          limit: 2,
        }),
        validate: (data) => {
          assert(Array.isArray(data.items) && data.items.length > 0, 'Solana program query should return rows')
          assert(data._execution !== undefined, 'Solana program query should describe the window')
        },
      },
      {
        user: 'what happened around this bitcoin address recently',
        tool: 'portal_get_wallet_summary',
        args: (context) => ({ network: 'bitcoin-mainnet', address: context.btcAddress, timeframe: '24h' }),
        validate: (data) => {
          assert(data.overview?.vm === 'bitcoin', 'Bitcoin address flow should use the Bitcoin wallet summary path')
          assert(data.bitcoin?.outputs_count !== undefined, 'Bitcoin address flow should include output counts')
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
          assert(
            !String(data.display?.title || '').includes('portal_'),
            `${scenario.name} display title should stay product-friendly`,
          )
          assert(
            !String(data.display?.network || '').includes('-mainnet'),
            `${scenario.name} display network should stay humanized`,
          )

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
