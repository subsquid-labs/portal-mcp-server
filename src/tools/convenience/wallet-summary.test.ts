/* Characterisation tests for wallet-summary.ts. They pin the current
   behaviour of the pure exports on a recorded Portal response so the module
   can be split without changing what a client receives. */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { McpServer } from '@modelcontextprotocol/server'
import type { z } from 'zod'

import { RECORDED_FIXTURES } from '../../app-ui/fixtures.recorded.js'
import {
  applyWalletSummaryResponseFormat,
  bitcoinValueToSats,
  buildWalletCompleteness,
  formatDecimalAmountExact,
  formatSatsAsBtc,
  parseNumericAmount,
  registerGetWalletSummaryTool,
} from './wallet-summary.js'

const recorded = RECORDED_FIXTURES.wallet as Record<string, unknown>

it('EVM wallet movement tables have visible panels alongside the counterparty ranking', async (t) => {
  const address = '0xaaaa000000000000000000000000000000000001'
  const counterparty = '0xbbbb000000000000000000000000000000000002'
  type Payload = {
    tables: Array<{ id: string }>
    _ui: { panels: Array<{ kind: string; table_id?: string; data_key?: string }> }
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
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    if (url.pathname === '/datasets')
      return Response.json([{ dataset: 'base-mainnet', aliases: ['base'], metadata: { kind: 'evm' } }])
    if (url.pathname.endsWith('/head') || url.pathname.endsWith('/finalized-head'))
      return Response.json({ number: 100_000 })
    if (url.pathname.endsWith('/metadata')) return Response.json({ start_block: 0 })
    assert.ok(url.pathname.endsWith('/stream'), `Unexpected fixture request: ${url.pathname}`)
    const query = JSON.parse(String(init?.body))
    const filters = query.transactions ?? []
    const matches =
      query.fromBlock <= 100_000 &&
      query.toBlock >= 100_000 &&
      filters.some(
        (filter: { from?: string[]; to?: string[] }) =>
          (!filter.from || filter.from.includes(address)) && (!filter.to || filter.to.includes(counterparty)),
      )
    return Response.json({
      header: { number: query.toBlock, timestamp: 1_800_000_000 },
      transactions: matches
        ? [
            {
              transactionIndex: 0,
              hash: `0x${'1'.repeat(64)}`,
              from: address,
              to: counterparty,
              value: '0xde0b6b3a7640000',
              gasUsed: '0x5208',
              gasPrice: '0x1',
              status: 1,
            },
          ]
        : [],
    })
  })
  const payload = (
    await callTool({
      network: 'base',
      address,
      timeframe: '10',
      include_tokens: false,
      include_nfts: false,
      limit_per_type: 5,
      response_format: 'full',
    })
  ).structuredContent
  assert.ok(payload.tables.some((table) => table.id === 'flow_counterparties'))
  const panelIds = new Set(
    payload._ui.panels.filter((panel) => panel.kind === 'table_panel').map((panel) => panel.table_id),
  )
  for (const table of payload.tables) assert.ok(panelIds.has(table.id), `Missing panel for ${table.id}`)
  assert.ok(
    payload._ui.panels.some(
      (panel) => panel.kind === 'ranked_bars_panel' && panel.data_key === 'fund_flow.movement_counterparties',
    ),
  )
})

describe('buildWalletCompleteness', () => {
  it('derives one state from window, sections, and cursor', () => {
    assert.equal(buildWalletCompleteness({ hasMore: false, windowComplete: true }).state, 'complete')
    assert.equal(buildWalletCompleteness({ hasMore: true, windowComplete: true }).state, 'cursor_page')
    assert.equal(buildWalletCompleteness({ hasMore: false, windowComplete: false }).state, 'partial_window')
    const failed = buildWalletCompleteness({
      hasMore: false,
      windowComplete: true,
      failedSections: ['assets', 'assets'],
    })
    assert.equal(failed.state, 'section_partial')
    assert.deepEqual(failed.failed_sections, ['assets'])
    assert.equal(failed.result_complete, false)
  })

  it('is complete only when everything is complete', () => {
    const complete = buildWalletCompleteness({ hasMore: false, windowComplete: true })
    assert.equal(complete.result_complete, true)
    assert.equal(complete.page_complete, true)
    assert.equal(buildWalletCompleteness({ hasMore: true, windowComplete: true }).result_complete, false)
  })
})

describe('applyWalletSummaryResponseFormat on a recorded Portal response', () => {
  const activityItems = (payload: Record<string, unknown>) =>
    (payload.activity as { items?: unknown[] } | undefined)?.items

  it('leaves the full and compact shapes intact', () => {
    assert.ok(Array.isArray(activityItems(recorded)) && activityItems(recorded)!.length > 0)
    const full = applyWalletSummaryResponseFormat(recorded, 'full')
    assert.equal(full, recorded)
    const compact = applyWalletSummaryResponseFormat(recorded, 'compact')
    assert.deepEqual(Object.keys(compact), Object.keys(recorded))
    assert.equal(activityItems(compact)?.length, activityItems(recorded)?.length)
  })

  it('drops the activity rows from the summary format but keeps the counts and metadata', () => {
    const summary = applyWalletSummaryResponseFormat(recorded, 'summary')
    assert.deepEqual(Object.keys(summary), Object.keys(recorded))
    assert.equal(activityItems(summary), undefined)
    assert.equal((summary.activity as { count?: unknown }).count, (recorded.activity as { count?: unknown }).count)
    assert.deepEqual(summary._coverage, recorded._coverage)
    assert.deepEqual(summary.completeness, recorded.completeness)
    assert.ok(JSON.stringify(summary).length < JSON.stringify(recorded).length)
  })
})

describe('exact amount helpers', () => {
  it('converts Bitcoin values to satoshis and back without floating point', () => {
    assert.equal(bitcoinValueToSats('0.30000003'), 30_000_003n)
    assert.equal(bitcoinValueToSats(0.1), 10_000_000n)
    assert.equal(formatSatsAsBtc(30_000_003n), '0.30000003')
    assert.throws(() => bitcoinValueToSats('1.123456789'))
  })

  it('formats signed integer token amounts exactly', () => {
    assert.equal(formatDecimalAmountExact(-9_000_000_000n, 18), '-0.000000009')
    assert.equal(formatDecimalAmountExact(1_500_000n, 6), '1.5')
    assert.equal(parseNumericAmount('12.5'), 12.5)
    assert.equal(parseNumericAmount('not a number'), 0)
  })
})
