#!/usr/bin/env tsx

import {
  assert,
  assertErrorQuality,
  callToolWithRetry,
  closeTestClient,
  connectTestClient,
  printSection,
} from './test-helpers.ts'

type NegativeCase = {
  name: string
  tool: string
  args: Record<string, unknown>
  expect: (text: string) => void
}

const CASES: NegativeCase[] = [
  {
    name: 'Unknown network alias',
    tool: 'portal_get_head',
    args: { network: 'definitely-not-a-real-network-xyz' },
    expect: (text) => {
      assert(/Unknown dataset/i.test(text), 'Unknown network should mention unknown dataset')
      assert(/portal_list_networks/i.test(text), 'Unknown network should suggest portal_list_networks')
    },
  },
  {
    name: 'Unsupported Substrate recent activity',
    tool: 'portal_get_recent_activity',
    args: { network: 'polkadot', timeframe: '1h', limit: 5 },
    expect: (text) => {
      assert(/does not support dataset 'polkadot'/i.test(text), 'Unsupported flow should mention polkadot clearly')
      assert(/supported chain types/i.test(text), 'Unsupported flow should explain supported chain types')
    },
  },
  {
    name: 'Conflicting compare/group args',
    tool: 'portal_get_time_series',
    args: { network: 'base', metric: 'transaction_count', duration: '1h', interval: '5m', compare_previous: true, group_by: 'contract' },
    expect: (text) => {
      assert(/compare_previous and group_by="contract" cannot be used together/i.test(text), 'Invalid combo should explain the conflict')
    },
  },
  {
    name: 'Missing OHLC pool address',
    tool: 'portal_evm_get_ohlc',
    args: { network: 'base', source: 'uniswap_v3_swap', duration: '1h', interval: '5m' },
    expect: (text) => {
      assert(/pool_address is required/i.test(text), 'Missing OHLC pool should mention pool_address')
    },
  },
  {
    name: 'Invalid pagination cursor',
    tool: 'portal_get_recent_activity',
    args: { cursor: 'definitely-not-a-valid-cursor' },
    expect: (text) => {
      assert(/Invalid pagination cursor/i.test(text), 'Invalid cursor should be called out clearly')
    },
  },
]

async function main() {
  const connected = await connectTestClient('negative-test')
  const { client } = connected

  try {
    let passed = 0
    let failed = 0

    printSection('Negative-path quality tests')

    for (const testCase of CASES) {
      try {
        const result = await callToolWithRetry(client, testCase.tool, testCase.args, { parseJson: false })
        assert(result.isError, `${testCase.name} should return an error`)
        assertErrorQuality(result.text, testCase.name)
        testCase.expect(result.text)
        console.log(`PASS  ${testCase.name}`)
        passed++
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.log(`FAIL  ${testCase.name}`)
        console.log(`      ${message.slice(0, 320)}`)
        failed++
      }
    }

    printSection(`Negative-path results: ${passed} passed, ${failed} failed`)
    process.exit(failed > 0 ? 1 : 0)
  } finally {
    await closeTestClient(connected)
  }
}

main().catch((error) => {
  console.error(`Fatal error: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
