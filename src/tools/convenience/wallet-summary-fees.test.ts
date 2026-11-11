import assert from 'node:assert/strict'
import { it } from 'node:test'

import type { McpServer } from '@modelcontextprotocol/server'
import type { z } from 'zod'

import { registerGetWalletSummaryTool } from './wallet-summary.js'

it('wallet summaries preserve signed fee tokens and disclose unavailable USD totals in every format', async (t) => {
  type FeeSummary = {
    total_fees: string | null
    total_fees_usd: number | null
    fees_status: string
    fees_by_token: Array<{ fee_token: string; total_fees: string | null }>
  }
  type Payload = {
    fund_flow: { summary: FeeSummary }
    hyperliquid: { fee_summary: FeeSummary }
    _pagination: { returned: number; has_more: boolean }
    _notices?: string[]
    _ui: { metric_cards: Array<{ id: string; value_path: string; format: string }> }
    _llm: { answer_sequence: string[]; parser_notes: string[] }
  }
  let callTool: ((args: Record<string, unknown>) => Promise<{ structuredContent: Payload }>) | undefined
  const server = {
    registerTool: (
      _name: string,
      config: { inputSchema: z.ZodType<Record<string, unknown>> },
      handler: (args: Record<string, unknown>, context: unknown) => Promise<{ structuredContent: Payload }>,
    ) => {
      callTool = (args) => handler(config.inputSchema.parse(args), {})
    },
  } as unknown as McpServer
  registerGetWalletSummaryTool(server)
  assert.ok(callTool)
  const scenarios = [
    {
      name: 'USDC rebates',
      fills: [
        { fee: '0.4', feeToken: 'USDC' },
        { fee: '-0.9', feeToken: 'USDC' },
      ],
      usd: -0.5,
      byToken: [{ fee_token: 'USDC', total_fees: '-0.5' }],
    },
    {
      name: 'exact USDC fee amounts',
      fills: [
        { fee: '0.123456789', feeToken: 'USDC' },
        { fee: '-0.000000001', feeToken: 'USDC' },
      ],
      usd: 0.12,
      byToken: [{ fee_token: 'USDC', total_fees: '0.123456788' }],
    },
    {
      name: 'mixed tokens',
      fills: [
        { fee: '2', feeToken: 'USDC' },
        { fee: '-0.25', feeToken: 'HYPE' },
      ],
      usd: null,
      byToken: [
        { fee_token: 'HYPE', total_fees: '-0.25' },
        { fee_token: 'USDC', total_fees: '2' },
      ],
    },
    { name: 'missing unit', fills: [{ fee: '1' }], usd: null, byToken: [] },
    {
      name: 'invalid amount',
      fills: [{ fee: 'invalid', feeToken: 'USDC' }],
      usd: null,
      byToken: [{ fee_token: 'USDC', total_fees: null }],
    },
    {
      name: 'fees cover only the returned page',
      fills: [
        { fee: '5', feeToken: 'HYPE' },
        { fee: '0.4', feeToken: 'USDC' },
        { fee: '-0.9', feeToken: 'USDC' },
      ],
      usd: -0.5,
      byToken: [{ fee_token: 'USDC', total_fees: '-0.5' }],
    },
  ]
  let currentFills: Array<{ fee: string; feeToken?: string }> = []
  const requestedFeeTokens: unknown[] = []
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    if (url.pathname === '/datasets')
      return Response.json([{ dataset: 'hyperliquid-fills', aliases: [], metadata: { kind: 'hyperliquidFills' } }])
    if (url.pathname.endsWith('/head') || url.pathname.endsWith('/finalized-head'))
      return Response.json({ number: 100_000 })
    if (url.pathname.endsWith('/metadata')) return Response.json({ start_block: 0 })
    assert.ok(url.pathname.endsWith('/stream'))
    const query = JSON.parse(String(init?.body))
    requestedFeeTokens.push(query.fields?.fill?.feeToken)
    return Response.json({
      header: { number: query.toBlock, timestamp: 1_800_000_000 },
      fills: currentFills.map(({ feeToken, ...fill }, index) => ({
        ...fill,
        ...(query.fields?.fill?.feeToken ? { feeToken } : {}),
        fillIndex: index,
        coin: 'BTC',
        px: '100',
        sz: '2',
      })),
    })
  })
  for (const response_format of ['full', 'compact', 'summary']) {
    for (const scenario of scenarios) {
      await t.test(`${response_format}: ${scenario.name}`, async () => {
        currentFills = scenario.fills
        const payload = (
          await callTool!({
            network: 'hyperliquid-fills',
            address: '0xaaaa000000000000000000000000000000000001',
            timeframe: '10',
            limit_per_type: 2,
            response_format,
          })
        ).structuredContent
        for (const summary of [payload.fund_flow.summary, payload.hyperliquid.fee_summary]) {
          assert.equal(summary.total_fees_usd, scenario.usd)
          assert.equal(summary.total_fees, scenario.usd === null ? null : scenario.byToken[0].total_fees)
          assert.equal(summary.fees_status, scenario.usd === null ? 'unavailable' : 'available')
          assert.deepEqual(summary.fees_by_token, scenario.byToken)
        }
        assert.equal(payload._pagination.returned, Math.min(currentFills.length, 2))
        assert.equal(payload._pagination.has_more, currentFills.length > 2)
        assert.equal(
          payload._notices?.some((notice) => /USD fee total is unavailable/.test(notice)) ?? false,
          scenario.usd === null,
        )
        const card = payload._ui.metric_cards.find((card) => card.id === 'primary-value')
        assert.equal(card?.value_path, 'hyperliquid.fee_summary.total_fees_usd')
        assert.equal(card?.format, 'currency_usd')
        assert.ok(payload._llm.answer_sequence.includes('hyperliquid.fee_summary.fees_by_token'))
        assert.ok(payload._llm.answer_sequence.includes('hyperliquid.fee_summary.fees_status'))
        assert.ok(payload._llm.answer_sequence.includes('hyperliquid.fee_summary.total_fees_usd'))
      })
    }
  }
  assert.ok(requestedFeeTokens.every((requested) => requested === true))
})
