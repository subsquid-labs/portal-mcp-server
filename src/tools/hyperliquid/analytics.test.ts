import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { McpServer } from '@modelcontextprotocol/server'
import type { z } from 'zod'

import { summarizeHyperliquidFees } from '../../helpers/hyperliquid-fees.js'
import { accumulateFill, createFillAccumulator, registerHyperliquidAnalyticsTool } from './analytics.js'

const fill = (over: Record<string, unknown> = {}) => ({
  user: '0xaaaa000000000000000000000000000000000001',
  coin: 'BTC',
  px: '100',
  sz: '2',
  dir: 'Open Long',
  fee: '0.5',
  feeToken: 'USDC',
  closedPnl: '0',
  ...over,
})

test('a maker rebate lowers the fee total instead of raising it', () => {
  const totals = createFillAccumulator()
  accumulateFill(totals, fill({ fee: '0.95' }))
  accumulateFill(totals, fill({ fee: '-1.9' }))
  accumulateFill(totals, fill({ fee: '3' }))

  assert.equal(summarizeHyperliquidFees(totals.fees).total_fees_usd, 2.05)
  assert.equal(summarizeHyperliquidFees(totals.coinData.get('BTC')!.fees).total_fees_usd, 2.05)
})

test('a market that only paid rebates reports a negative fee total', () => {
  const totals = createFillAccumulator()
  accumulateFill(totals, fill({ fee: '-0.4' }))
  accumulateFill(totals, fill({ fee: '-0.6' }))

  assert.equal(summarizeHyperliquidFees(totals.fees).total_fees_usd, -1)
  assert.equal(summarizeHyperliquidFees(totals.fees).fees_status, 'available')
})

test('fees in different tokens cannot be added to a USD total', () => {
  const totals = createFillAccumulator()
  accumulateFill(totals, fill({ fee: '2', feeToken: 'USDC' }))
  accumulateFill(totals, fill({ fee: '-0.25', feeToken: 'HYPE' }))
  accumulateFill(totals, fill({ coin: 'ETH', fee: '1.5', feeToken: 'USDC' }))

  assert.equal(summarizeHyperliquidFees(totals.fees).total_fees_usd, null)
  assert.equal(summarizeHyperliquidFees(totals.coinData.get('BTC')!.fees).total_fees_usd, null)
  assert.equal(summarizeHyperliquidFees(totals.coinData.get('ETH')!.fees).total_fees_usd, 1.5)
})

for (const feeToken of [undefined, null, true, {}, '', ' ', 'usdc']) {
  test(`an unverified fee token ${JSON.stringify(feeToken)} cannot imply a USD fee`, () => {
    const totals = createFillAccumulator()
    accumulateFill(totals, fill({ feeToken }))
    assert.equal(summarizeHyperliquidFees(totals.fees).total_fees_usd, null)
    assert.equal(summarizeHyperliquidFees(totals.coinData.get('BTC')!.fees).total_fees_usd, null)
  })
}

for (const fee of [undefined, null, true, {}, '', 'not a number', 'Infinity']) {
  test(`an invalid fee ${JSON.stringify(fee)} cannot imply a known zero`, () => {
    const totals = createFillAccumulator()
    accumulateFill(totals, fill({ fee }))
    assert.equal(summarizeHyperliquidFees(totals.fees).total_fees_usd, null)
    assert.equal(summarizeHyperliquidFees(totals.coinData.get('BTC')!.fees).total_fees_usd, null)
  })
}

test('realized PnL keeps its sign too', () => {
  const totals = createFillAccumulator()
  accumulateFill(totals, fill({ closedPnl: '120.5' }))
  accumulateFill(totals, fill({ closedPnl: '-200' }))

  assert.equal(Number(totals.totalPnl.toFixed(2)), -79.5)
})

test('volume, fills, traders and coins accumulate across fills', () => {
  const totals = createFillAccumulator()
  accumulateFill(totals, fill({ px: '100', sz: '2' }))
  accumulateFill(totals, fill({ user: '0xbbbb000000000000000000000000000000000002', coin: 'ETH', px: '50', sz: '3' }))
  accumulateFill(totals, fill({ px: '10', sz: '1' }))

  assert.equal(totals.totalFills, 3)
  assert.equal(totals.totalVolume, 360)
  assert.equal(totals.traders.size, 2)
  assert.deepEqual([...totals.allCoins].sort(), ['BTC', 'ETH'])
  assert.equal(totals.coinData.get('BTC')?.fills, 2)
  assert.equal(totals.coinData.get('ETH')?.volume, 150)
  assert.equal(totals.traderData.get('0xbbbb000000000000000000000000000000000002')?.coins.size, 1)
})

test('position flips do not establish liquidations when Portal omits the marker', () => {
  const totals = createFillAccumulator()
  accumulateFill(totals, fill({ dir: 'Long > Short', px: '100', sz: '4' }))
  accumulateFill(totals, fill({ dir: 'Short > Long', px: '100', sz: '1' }))
  accumulateFill(totals, fill({ dir: 'Open Short' }))

  assert.equal(totals.liquidationCount, null)
  assert.equal(totals.liquidationVolume, null)
  assert.equal(totals.dirCounts['Open Short'], 1)
  assert.equal(totals.coinData.get('BTC')?.liquidations, null)
  assert.equal(totals.coinData.get('BTC')?.shorts, 1)
  assert.equal(totals.coinData.get('BTC')?.longs, 0)
})

test('a fill missing its fields is counted, not dropped or turned into NaN', () => {
  const totals = createFillAccumulator()
  accumulateFill(totals, {})

  assert.equal(totals.totalFills, 1)
  assert.equal(totals.totalVolume, 0)
  assert.equal(summarizeHyperliquidFees(totals.fees).total_fees_usd, null)
  assert.equal(totals.traders.size, 0, 'a fill with no user adds no trader')
  assert.deepEqual([...totals.allCoins], ['unknown'])
  assert.equal(totals.dirCounts.Unknown, 1)
})

test('analytics preserves unavailable metrics and caches only the resolved block window', async (t) => {
  type Payload = {
    overview: {
      total_fills: number
      total_fees_usd: number | null
      fees_status: string
      fees_by_token: Array<{ fee_token: string; total_fees: string | null }>
      long_short_ratio: number | null
      long_short_label: string
    }
    liquidations: { status?: string; count: number | null; volume_usd: number | null }
    volume_by_coin: Array<{
      coin: string
      fees_usd: number | null
      fees_status: string
      long_short_ratio: number | null
    }>
    _ui: { metric_cards: Array<{ id: string }> }
    top_pnl_winners: Array<{ realized_pnl: number; pnl_formatted: string }>
    top_pnl_losers: Array<{ realized_pnl: number; pnl_formatted: string }>
    _cache?: { hit: boolean }
    _notices?: string[]
    _freshness: { window_to_block: number }
    _coverage: { analyzed_to_block: number; window_to_block: number }
    _meta: { queried_blocks: string }
  }
  type ToolResult = { structuredContent: Payload }
  let callTool: ((args: Record<string, unknown>) => Promise<ToolResult>) | undefined
  const server = {
    registerTool: (
      _name: string,
      config: { inputSchema: z.ZodType<Record<string, unknown>> },
      handler: (args: Record<string, unknown>, context: unknown) => Promise<ToolResult>,
    ) => {
      callTool = (args) => handler(config.inputSchema.parse(args), {})
    },
  } as unknown as McpServer
  registerHyperliquidAnalyticsTool(server)
  assert.ok(callTool)

  const initialTime = 1_800_000_000_000
  let now = initialTime
  let head = 1_000_000
  let aggregationRequests = 0
  const feeScenarios: Record<string, Record<string, unknown>[]> = {
    FEE_USDC: [fill({ fee: '0.95' }), fill({ fee: '-1.9' }), fill({ fee: '3' })],
    FEE_REBATE: [fill({ fee: '-0.4' }), fill({ fee: '-0.6' })],
    FEE_MIXED: [fill({ fee: '2' }), fill({ fee: '-0.25', feeToken: 'HYPE' }), fill({ coin: 'ETH', fee: '1.5' })],
    FEE_MISSING: [fill({ feeToken: undefined })],
    FEE_INVALID: [fill({ feeToken: true })],
    FEE_BAD_AMOUNT: [fill({ fee: 'not a number' })],
  }
  t.mock.method(Date, 'now', () => now)
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200 })
    if (url.pathname === '/datasets') {
      return json([{ dataset: 'hyperliquid-fills', aliases: [], metadata: { kind: 'hyperliquidFills' } }])
    }
    if (url.pathname.endsWith('/metadata')) return json({ start_block: 0 })
    if (url.pathname.endsWith('/head') || url.pathname.endsWith('/finalized-head')) return json({ number: head })
    if (url.pathname.includes('/timestamps/')) {
      const timestamp = Number(url.pathname.split('/').at(-2)) / 1000
      return json({ block_number: timestamp - 1_700_000_000 })
    }
    assert.ok(url.pathname.endsWith('/stream'), `Unexpected request: ${url}`)
    const query = JSON.parse(String(init?.body)) as {
      fromBlock: number
      toBlock: number
      fills?: Array<{ coin?: string[] }>
      fields?: { fill?: { feeToken?: boolean } }
    }
    if (query.fills) {
      assert.equal(query.fields?.fill?.feeToken, true, 'fee amounts require their source unit')
      aggregationRequests += 1
      now += 100
      return json({
        header: { number: query.toBlock, timestamp: 1_700_000_000 + query.toBlock },
        fills:
          feeScenarios[query.fills[0]?.coin?.[0] ?? ''] ??
          (query.fills[0]?.coin?.[0] === 'CLOSE_ONLY'
            ? [fill({ dir: 'Close Long' })]
            : query.fills[0]?.coin?.[0] === 'SHORT_ONLY'
              ? [fill({ dir: 'Open Short' })]
              : query.fills[0]?.coin?.[0] === 'BALANCED'
                ? [fill({ dir: 'Open Long' }), fill({ dir: 'Open Short' })]
                : [
                    fill({ dir: 'Open Long', closedPnl: '-10' }),
                    fill({ user: '0xbbbb000000000000000000000000000000000002', dir: 'Long > Short', closedPnl: '5' }),
                    fill({ user: '0xcccc000000000000000000000000000000000003', dir: 'Buy', closedPnl: '0' }),
                  ]),
      })
    }
    const blocks = Array.from({ length: query.toBlock - query.fromBlock + 1 }, (_, index) => ({
      header: { number: query.fromBlock + index, timestamp: 1_700_000_000 + query.fromBlock + index },
    }))
    return new Response(blocks.map((block) => JSON.stringify(block)).join('\n'))
  })

  const fresh = (await callTool({ timeframe: '1h', response_format: 'full' })).structuredContent
  await t.test('position flips leave liquidation metrics unavailable', () => {
    assert.equal(fresh.liquidations.status, 'unavailable')
    assert.equal(fresh.liquidations.count, null)
    assert.equal(fresh.liquidations.volume_usd, null)
    assert.ok(fresh._notices?.some((notice) => /liquidation/i.test(notice)))
    assert.ok(fresh._ui.metric_cards.every((card) => card.id !== 'liquidations'))
  })
  await t.test('all-long opening fills cannot be described as short-biased', () => {
    assert.equal(fresh.overview.long_short_ratio, null)
    assert.equal(fresh.overview.long_short_label, 'Long-biased')
    assert.equal(fresh.volume_by_coin[0].long_short_ratio, null)
  })

  await t.test('PnL winners and losers contain only traders with the matching sign', () => {
    assert.deepEqual(
      fresh.top_pnl_winners.map((trader) => trader.realized_pnl),
      [5],
    )
    assert.deepEqual(
      fresh.top_pnl_losers.map((trader) => trader.realized_pnl),
      [-10],
    )
    assert.ok(fresh.top_pnl_winners.every((trader) => !trader.pnl_formatted.includes('+-')))
  })
  await t.test('the volume basis names the account fill notional', () => {
    assert.ok(fresh._notices?.some((notice) => /per-account fill notional/.test(notice)))
  })

  const cached = (await callTool({ timeframe: '1h', response_format: 'full' })).structuredContent
  await t.test('cache hits retain the evidence limitation notice', () => {
    assert.equal(cached._cache?.hit, true)
    assert.ok(cached._notices?.some((notice) => /liquidation/i.test(notice)))
    assert.equal(aggregationRequests, 1)
  })

  head += 10
  now = initialTime + 30_050
  const moved = (await callTool({ timeframe: '1h', response_format: 'full' })).structuredContent
  await t.test('a head refresh cannot relabel cached rows as a new scan', () => {
    assert.equal(aggregationRequests, 2)
    assert.equal(moved._cache, undefined)
    assert.equal(moved._freshness.window_to_block, head)
    assert.equal(moved._coverage.analyzed_to_block, head)
    assert.equal(moved._coverage.window_to_block, head)
    assert.ok(moved._meta.queried_blocks.endsWith(`-${head}`))
  })

  for (const [coin, label, ratio] of [
    ['CLOSE_ONLY', 'No opening fills', null],
    ['SHORT_ONLY', 'Short-biased', 0],
    ['BALANCED', 'Balanced', 1],
  ] as const) {
    const payload = (await callTool({ timeframe: '1h', response_format: 'full', coin: [coin] })).structuredContent
    await t.test(`opening fill bias for ${coin}`, () => {
      assert.equal(payload.overview.long_short_label, label)
      assert.equal(payload.overview.long_short_ratio, ratio)
      assert.equal(payload.volume_by_coin[0].long_short_ratio, ratio)
    })
  }

  for (const [scenario, expectedUsd] of [
    ['FEE_USDC', 2.05],
    ['FEE_REBATE', -1],
    ['FEE_MIXED', null],
    ['FEE_MISSING', null],
    ['FEE_INVALID', null],
    ['FEE_BAD_AMOUNT', null],
  ] as const) {
    for (const response_format of ['full', 'compact', 'summary']) {
      const payload = (await callTool({ timeframe: '1h', response_format, coin: [scenario] })).structuredContent
      await t.test(`${response_format} fee units for ${scenario}`, () => {
        assert.equal(payload.overview.total_fees_usd, expectedUsd)
        assert.equal(payload.overview.fees_status, expectedUsd === null ? 'unavailable' : 'available')
        if (scenario === 'FEE_MIXED') {
          assert.deepEqual(payload.overview.fees_by_token, [
            { fee_token: 'HYPE', total_fees: '-0.25' },
            { fee_token: 'USDC', total_fees: '3.5' },
          ])
          assert.ok(payload._notices?.some((notice) => /fee.*USDC/i.test(notice)))
          if (response_format !== 'summary') {
            assert.equal(payload.volume_by_coin.find((row) => row.coin === 'BTC')?.fees_usd, null)
            assert.equal(payload.volume_by_coin.find((row) => row.coin === 'ETH')?.fees_usd, 1.5)
          }
        }
      })
    }
  }

  for (const response_format of ['compact', 'summary']) {
    const payload = (await callTool({ timeframe: '1h', response_format })).structuredContent
    await t.test(`${response_format} keeps liquidation availability explicit`, () => {
      assert.equal(payload.liquidations.status, 'unavailable')
      assert.equal(payload.liquidations.count, null)
      assert.equal(payload.overview.long_short_ratio, null)
    })
  }
})
