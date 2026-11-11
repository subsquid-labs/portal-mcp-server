#!/usr/bin/env tsx

import {
  type ToolCallResult,
  assert,
  callToolWithRetry,
  closeTestClient,
  connectTestClient,
  isBoundedUpstreamToolError,
} from './test-helpers.ts'

const MAX_INTERACTIVE_MS = 12_000

async function callWithoutRetry(
  client: Parameters<typeof callToolWithRetry>[0],
  tool: string,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  const result = await callToolWithRetry(client, tool, args, { retries: 0 })
  assert(!result.isError, `${tool} returned a tool error: ${result.text.slice(0, 240)}`)
  assert(result.elapsedMs < MAX_INTERACTIVE_MS, `${tool} took ${result.elapsedMs}ms`)
  return result
}

async function callHighErrorToolWithoutRetry(
  client: Parameters<typeof callToolWithRetry>[0],
  tool: string,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  const result = await callToolWithRetry(client, tool, args, { retries: 0 })
  assert(result.elapsedMs < MAX_INTERACTIVE_MS, `${tool} took ${result.elapsedMs}ms`)
  if (result.isError) {
    assert(
      isBoundedUpstreamToolError(result),
      `${tool} returned an unexpected tool error: ${result.text.slice(0, 240)}`,
    )
  }
  return result
}

async function main() {
  console.log('Starting live reliability regression sweep...')
  const connected = await connectTestClient('reliability-live-test')
  const { client } = connected

  try {
    const [baseHeadResult, solanaHeadResult, usdcResult, tronNetworksResult, tronInfoResult] = await Promise.all([
      callWithoutRetry(client, 'portal_get_head', { network: 'base' }),
      callWithoutRetry(client, 'portal_get_head', { network: 'solana-mainnet' }),
      callWithoutRetry(client, 'portal_resolve_entity', { network: 'base', kind: 'token', query: 'USDC', limit: 5 }),
      callWithoutRetry(client, 'portal_list_networks', { vm: 'tron', limit: 10 }),
      callWithoutRetry(client, 'portal_get_network_info', { network: 'tron-mainnet' }),
    ])
    const baseHead = Number(baseHeadResult.data.number)
    const solanaHead = Number(solanaHeadResult.data.number)
    const usdc = String(
      usdcResult.data.matches?.find((match: any) => String(match?.symbol).toUpperCase() === 'USDC')?.address || '',
    ).toLowerCase()
    assert(Number.isFinite(baseHead) && baseHead > 0, 'Expected current Base head')
    assert(Number.isFinite(solanaHead) && solanaHead > 0, 'Expected current Solana head')
    assert(/^0x[0-9a-f]{40}$/.test(usdc), 'Expected Base USDC address from entity resolver')
    assert(
      tronNetworksResult.data.items?.some(
        (network: any) => network.network === 'tron-mainnet' && network.vm === 'tron',
      ),
      'Expected Tron discovery to use the native VM family',
    )
    assert(tronInfoResult.data.vm === 'tron', 'Expected Tron network info to use the native VM family')
    assert(
      Number(tronInfoResult.data.indexing?.indexed_head?.timestamp) > 1_000_000_000,
      'Expected Tron network info to resolve its indexed head timestamp',
    )
    assert(
      Number(tronInfoResult.data.indexing?.indexed_head?.timestamp) < 10_000_000_000,
      'Expected Tron network info to normalize millisecond timestamps to Unix seconds',
    )
    assert(
      Number(tronInfoResult.data.indexing?.indexed_head?.age_seconds) < 10 * 365 * 24 * 3600,
      'Expected Tron indexed-head age to remain within a plausible human timeframe',
    )

    const walletFixtureResult = await callWithoutRetry(client, 'portal_evm_query_transactions', {
      network: 'base',
      from_block: baseHead - 500,
      to_block: baseHead,
      limit: 20,
      field_preset: 'standard',
      response_format: 'full',
    })
    const wallets = Array.from(
      new Set(
        (walletFixtureResult.data.items ?? [])
          .map((item: any) => String(item?.from || '').toLowerCase())
          .filter((address: string) => /^0x[0-9a-f]{40}$/.test(address)),
      ),
    ).slice(0, 5)
    assert(wallets.length >= 3, `Expected at least 3 active Base wallets, got ${wallets.length}`)

    let partialWallets = 0
    for (const address of wallets) {
      const result = await callWithoutRetry(client, 'portal_get_wallet_summary', {
        network: 'base',
        address,
        timeframe: '5m',
      })
      assert(result.data.overview?.vm === 'evm', 'Wallet summary should return EVM overview')
      assert(Array.isArray(result.data.activity?.items), 'Wallet summary should return activity items')
      if (result.data.overview?.partial) partialWallets += 1
    }
    assert(
      partialWallets <= Math.floor(wallets.length / 2),
      `Too many partial wallet summaries: ${partialWallets}/${wallets.length}`,
    )
    console.log(`PASS  portal_get_wallet_summary: ${wallets.length}/${wallets.length} calls, ${partialWallets} partial`)

    const [solanaWalletFixture, bitcoinWalletFixture, hyperliquidWalletFixture] = await Promise.all([
      callWithoutRetry(client, 'portal_solana_query_transactions', {
        network: 'solana-mainnet',
        from_block: solanaHead - 20,
        to_block: solanaHead,
        limit: 1,
      }),
      callWithoutRetry(client, 'portal_bitcoin_query_transactions', {
        network: 'bitcoin-mainnet',
        timeframe: '1h',
        limit: 3,
        include_outputs: true,
      }),
      callWithoutRetry(client, 'portal_hyperliquid_query_fills', {
        network: 'hyperliquid-fills',
        timeframe: '5m',
        limit: 1,
      }),
    ])
    const solanaWallet = String(
      solanaWalletFixture.data.items?.[0]?.feePayer || solanaWalletFixture.data.items?.[0]?.sender || '',
    )
    const bitcoinWallet = String(
      (bitcoinWalletFixture.data.items ?? [])
        .flatMap((item: any) => item.outputs || [])
        .find((output: any) => typeof output?.scriptPubKeyAddress === 'string' || typeof output?.address === 'string')
        ?.scriptPubKeyAddress ||
        (bitcoinWalletFixture.data.items ?? [])
          .flatMap((item: any) => item.outputs || [])
          .find((output: any) => typeof output?.address === 'string')?.address ||
        '',
    )
    const hyperliquidWallet = String(hyperliquidWalletFixture.data.items?.[0]?.user || '')
    assert(solanaWallet.length > 20, 'Expected an active Solana wallet fixture')
    assert(bitcoinWallet.length > 10, 'Expected an active Bitcoin wallet fixture')
    assert(/^0x[0-9a-f]{40}$/i.test(hyperliquidWallet), 'Expected an active Hyperliquid wallet fixture')

    const crossVmWalletCases = [
      { network: 'solana-mainnet', address: solanaWallet, timeframe: '1h' },
      { network: 'bitcoin-mainnet', address: bitcoinWallet, timeframe: '24h' },
      { network: 'hyperliquid-fills', address: hyperliquidWallet, timeframe: '5m' },
    ]
    const crossVmWalletResults = await Promise.all(
      crossVmWalletCases.map((args) => callToolWithRetry(client, 'portal_get_wallet_summary', args, { retries: 0 })),
    )
    for (const [index, result] of crossVmWalletResults.entries()) {
      assert(
        result.elapsedMs < MAX_INTERACTIVE_MS,
        `${crossVmWalletCases[index].network} wallet call took ${result.elapsedMs}ms`,
      )
      if (result.isError) {
        assert(
          isBoundedUpstreamToolError(result),
          `cross-VM wallet returned an unexpected tool error: ${result.text.slice(0, 240)}`,
        )
      }
    }
    const successfulCrossVmWallets = crossVmWalletResults.filter((result) => !result.isError)
    assert(
      successfulCrossVmWallets.length >= 2,
      `Expected at least 2/3 cross-VM wallet successes, got ${successfulCrossVmWallets.length}`,
    )
    assert(
      successfulCrossVmWallets.every((result) => result.data.fund_flow?.summary !== undefined),
      'Successful cross-VM wallet summaries should include fund-flow summaries',
    )
    console.log(
      `PASS  cross-VM wallet summaries: ${successfulCrossVmWallets.length}/3 succeeded without retries; ${3 - successfulCrossVmWallets.length} bounded upstream errors`,
    )

    const durations = ['5m', '15m', '30m']
    const highErrorOutcomes: ToolCallResult[] = []
    for (let index = 0; index < 3; index += 1) {
      const baseFrom = baseHead - 200 - index * 50
      highErrorOutcomes.push(
        await callHighErrorToolWithoutRetry(client, 'portal_evm_query_transactions', {
          network: 'base',
          from_block: baseFrom,
          to_block: baseHead,
          limit: 5,
          field_preset: 'standard',
        }),
        await callHighErrorToolWithoutRetry(client, 'portal_evm_query_logs', {
          network: 'base',
          from_block: baseFrom,
          to_block: baseHead,
          addresses: [usdc],
          limit: 5,
        }),
        await callHighErrorToolWithoutRetry(client, 'portal_evm_query_token_transfers', {
          network: 'base',
          from_block: baseFrom,
          to_block: baseHead,
          token_addresses: [usdc],
          limit: 5,
        }),
        await callHighErrorToolWithoutRetry(client, 'portal_get_time_series', {
          network: 'base',
          metric: index === 2 ? 'gas_used' : 'transaction_count',
          interval: '5m',
          duration: durations[index],
        }),
        await callHighErrorToolWithoutRetry(client, 'portal_solana_query_transactions', {
          network: 'solana-mainnet',
          from_block: solanaHead - 10 - index * 10,
          to_block: solanaHead,
          limit: 5,
        }),
      )
    }

    const successfulHighErrorCalls = highErrorOutcomes.filter((result) => !result.isError).length
    assert(
      successfulHighErrorCalls >= 13,
      `Expected at least 13/15 high-error tool successes, got ${successfulHighErrorCalls}`,
    )
    console.log(
      `PASS  highest-error raw and time-series tools: ${successfulHighErrorCalls}/15 succeeded without retries; ${15 - successfulHighErrorCalls} bounded upstream errors`,
    )
    console.log('Live reliability regression sweep passed')
  } finally {
    await closeTestClient(connected)
  }
}

main().catch((error) => {
  console.error(`Live reliability regression sweep failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
