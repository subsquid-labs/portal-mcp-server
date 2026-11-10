import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { McpServer } from '@modelcontextprotocol/server'
import type { z } from 'zod'

import { accumulateFill, createFillAccumulator, registerHyperliquidAnalyticsTool } from './analytics.js'

/*
 * The fee sign is the point of this file. Hyperliquid charges a taker fee and
 * pays a maker rebate, and a rebate arrives as a negative `fee`. Summing the
 * absolute values turns a market that paid rebates out into one that collected
 * fees, which is not an imprecise number but the wrong sign on a real one. The
 * fills summary was fixed for this and the analytics tool was not, because its
 * copy of the arithmetic sat inside a streaming callback that only a live
 * Portal window could reach. It is a plain function now, so the sign is held
 * here rather than by whoever next reads that loop.
 */

const fill = (over: Record<string, unknown> = {}) => ({
  user: '0xaaaa000000000000000000000000000000000001',
  coin: 'BTC',
  px: '100',
  sz: '2',
  dir: 'Open Long',
  fee: '0.5',
  closedPnl: '0',
  ...over,
})

test('a maker rebate lowers the fee total instead of raising it', () => {
  const totals = createFillAccumulator()
  accumulateFill(totals, fill({ fee: '0.95' }))
  accumulateFill(totals, fill({ fee: '-1.9' }))
  accumulateFill(totals, fill({ fee: '3' }))

  assert.equal(Number(totals.totalFees.toFixed(2)), 2.05)
  assert.equal(Number(totals.coinData.get('BTC')?.fees.toFixed(2)), 2.05)
})

test('a market that only paid rebates reports a negative fee total', () => {
  const totals = createFillAccumulator()
  accumulateFill(totals, fill({ fee: '-0.4' }))
  accumulateFill(totals, fill({ fee: '-0.6' }))

  assert.equal(Number(totals.totalFees.toFixed(2)), -1)
  assert.ok(totals.totalFees < 0, 'rebates must not be reported as fees paid')
})

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
  assert.equal(totals.totalFees, 0)
  assert.equal(totals.traders.size, 0, 'a fill with no user adds no trader')
  assert.deepEqual([...totals.allCoins], ['unknown'])
  assert.equal(totals.dirCounts.Unknown, 1)
})

test('analytics preserves unavailable metrics and caches only the resolved block window', async (t) => {
  type Payload = {
    overview: { total_fills: number; long_short_ratio: number | null; long_short_label: string }
    liquidations: { status?: string; count: number | null; volume_usd: number | null }
    volume_by_coin: Array<{ long_short_ratio: number | null }>
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
    }
    if (query.fills) {
      aggregationRequests += 1
      now += 100
      return json({
        header: { number: query.toBlock, timestamp: 1_700_000_000 + query.toBlock },
        fills:
          query.fills[0]?.coin?.[0] === 'CLOSE_ONLY'
            ? [fill({ dir: 'Close Long' })]
            : query.fills[0]?.coin?.[0] === 'SHORT_ONLY'
              ? [fill({ dir: 'Open Short' })]
              : query.fills[0]?.coin?.[0] === 'BALANCED'
                ? [fill({ dir: 'Open Long' }), fill({ dir: 'Open Short' })]
                : [
                    fill({ dir: 'Open Long', closedPnl: '-10' }),
                    fill({ user: '0xbbbb000000000000000000000000000000000002', dir: 'Long > Short', closedPnl: '5' }),
                    fill({ user: '0xcccc000000000000000000000000000000000003', dir: 'Buy', closedPnl: '0' }),
                  ],
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

  for (const response_format of ['compact', 'summary']) {
    const payload = (await callTool({ timeframe: '1h', response_format })).structuredContent
    await t.test(`${response_format} keeps liquidation availability explicit`, () => {
      assert.equal(payload.liquidations.status, 'unavailable')
      assert.equal(payload.liquidations.count, null)
      assert.equal(payload.overview.long_short_ratio, null)
    })
  }
})
