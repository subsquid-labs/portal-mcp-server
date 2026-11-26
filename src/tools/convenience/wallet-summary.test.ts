/* Characterisation tests for wallet-summary.ts. They pin the current
   behaviour of the pure exports on a recorded Portal response so the module
   can be split without changing what a client receives. */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { McpServer } from '@modelcontextprotocol/server'
import type { z } from 'zod'

import { RECORDED_FIXTURES } from '../../app-ui/fixtures.recorded.js'
import { clearDatasetCaches } from '../../cache/datasets.js'
import {
  applyWalletSummaryResponseFormat,
  bitcoinValueToSats,
  buildWalletCompleteness,
  formatDecimalAmountExact,
  formatSatsAsBtc,
  isTrc20TransferLog,
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

describe('Tron wallet summary TRC-20 filtering and follow-up pivots', () => {
  const TRANSFER_TOPIC0 = 'ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
  const WALLET_BASE58 = 'TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7'
  const WALLET_TOPIC = '00000000000000000000000074472e7d35395a6b54421a4b67c5c199736b2c2a'
  const OTHER_TOPIC = '0000000000000000000000001111111111111111111111111111111111111111'
  const TRC20_CONTRACT_HEX = 'a614f803b6fd780986a42c78ec9c7f77e6ded13c'
  const TRC721_CONTRACT_HEX = '2222222222222222222222222222222222222222'

  it('distinguishes 3-topic TRC-20 transfers from 4-topic TRC-721 NFT transfers', () => {
    assert.equal(
      isTrc20TransferLog({
        topics: [TRANSFER_TOPIC0, OTHER_TOPIC, WALLET_TOPIC],
        data: '00000000000000000000000000000000000000000000000000000000000f4240',
      }),
      true,
    )
    assert.equal(
      isTrc20TransferLog({
        topics: [
          TRANSFER_TOPIC0,
          OTHER_TOPIC,
          WALLET_TOPIC,
          '000000000000000000000000000000000000000000000000000000000000002a',
        ],
        data: '',
      }),
      false,
    )
  })

  it('excludes TRC-721 logs from TRC-20 counts/pagination and emits accurate directional next_pivots', async (t) => {
    clearDatasetCaches()
    t.after(() => clearDatasetCaches())
    type TronPayload = {
      tron: { trc20_transfers_count: number }
      fund_flow: {
        summary: { assets_moved: number; trc20_transfer_logs: number }
        next_pivots: Array<{ tool: string; suggested_arguments: Record<string, unknown> }>
      }
      _pagination: { sections: { trc20_transfers: { returned: number; has_more: boolean } } }
    }
    let callTool: ((args: Record<string, unknown>) => Promise<{ structuredContent: TronPayload }>) | undefined
    const server = {
      registerTool: (
        _name: string,
        config: { inputSchema: z.ZodType<Record<string, unknown>> },
        handler: (args: Record<string, unknown>, context: unknown) => Promise<{ structuredContent: TronPayload }>,
      ) => {
        callTool = (args) => handler(config.inputSchema.parse(args), {})
      },
    } as unknown as McpServer
    registerGetWalletSummaryTool(server)
    assert.ok(callTool)

    t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.pathname === '/datasets') {
        return Response.json([{ dataset: 'tron-mainnet', aliases: ['tron'], metadata: { kind: 'tron' } }])
      }
      if (url.pathname.endsWith('/head') || url.pathname.endsWith('/finalized-head')) {
        return Response.json({ number: 88_000_010 })
      }
      if (url.pathname.endsWith('/metadata')) return Response.json({ start_block: 0 })
      const query = JSON.parse(String(init?.body))
      if (Array.isArray(query.logs)) {
        return Response.json({
          header: { number: 88_000_010, timestamp: 1_795_000_000_000 },
          transactions: [{ transactionIndex: 0, hash: 'a'.repeat(64) }],
          logs: [
            // Standard TRC-20 Transfer (3 topics + 32-byte data)
            {
              logIndex: 0,
              transactionIndex: 0,
              address: TRC20_CONTRACT_HEX,
              topics: [TRANSFER_TOPIC0, OTHER_TOPIC, WALLET_TOPIC],
              data: '00000000000000000000000000000000000000000000000000000000000f4240',
            },
            // TRC-721 NFT Transfer (4 topics + empty data) -> must NOT count as TRC-20 or trigger has_more
            {
              logIndex: 1,
              transactionIndex: 0,
              address: TRC721_CONTRACT_HEX,
              topics: [
                TRANSFER_TOPIC0,
                OTHER_TOPIC,
                WALLET_TOPIC,
                '0000000000000000000000000000000000000000000000000000000000000007',
              ],
              data: '',
            },
          ],
        })
      }
      return Response.json({ header: { number: 88_000_010, timestamp: 1_795_000_000_000 }, transactions: [] })
    })

    const payload = (
      await callTool({
        network: 'tron',
        address: WALLET_BASE58,
        timeframe: '10',
        limit_per_type: 1,
        response_format: 'compact',
      })
    ).structuredContent

    assert.equal(payload.tron.trc20_transfers_count, 1)
    assert.equal(payload.fund_flow.summary.trc20_transfer_logs, 1)
    assert.equal(payload.fund_flow.summary.assets_moved, 1)
    assert.equal(payload._pagination.sections.trc20_transfers.returned, 1)
    assert.equal(payload._pagination.sections.trc20_transfers.has_more, false)

    const pivots = payload.fund_flow.next_pivots
    assert.equal(pivots.length, 4)
    assert.deepEqual(pivots[0]?.suggested_arguments, {
      network: 'tron-mainnet',
      from_addresses: [WALLET_BASE58],
      from_block: 88_000_000,
      to_block: 88_000_010,
    })
    assert.deepEqual(pivots[1]?.suggested_arguments, {
      network: 'tron-mainnet',
      to_addresses: [WALLET_BASE58],
      from_block: 88_000_000,
      to_block: 88_000_010,
    })
    assert.deepEqual(pivots[2]?.suggested_arguments, {
      network: 'tron-mainnet',
      event: 'transfer',
      topic1: [WALLET_BASE58],
      from_block: 88_000_000,
      to_block: 88_000_010,
    })
    assert.deepEqual(pivots[3]?.suggested_arguments, {
      network: 'tron-mainnet',
      event: 'transfer',
      topic2: [WALLET_BASE58],
      from_block: 88_000_000,
      to_block: 88_000_010,
    })
  })
})
