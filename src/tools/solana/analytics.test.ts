import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { McpServer } from '@modelcontextprotocol/server'
import type { z } from 'zod'

import { registerSolanaAnalyticsTool } from './analytics.js'

test('Solana analytics reuses results only for the same resolved slot window', async (t) => {
  type Payload = {
    network: { slot_range: string }
    _cache?: { hit: boolean }
    _freshness: { window_to_block: number }
    _coverage: { analyzed_to_block: number }
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
  registerSolanaAnalyticsTool(server)
  assert.ok(callTool)

  const initialTime = 1_800_000_000_000
  let now = initialTime
  let head = 1_000_000
  let aggregationRequests = 0
  t.mock.method(Date, 'now', () => now)
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const json = (value: unknown) => new Response(JSON.stringify(value))
    if (url.pathname === '/datasets') {
      return json([{ dataset: 'solana-mainnet', aliases: [], metadata: { kind: 'solana' } }])
    }
    if (url.pathname.endsWith('/metadata')) return json({ start_block: 0 })
    if (url.pathname.endsWith('/head') || url.pathname.endsWith('/finalized-head')) return json({ number: head })
    if (url.pathname.includes('/timestamps/')) {
      const timestamp = Number(url.pathname.split('/').at(-2))
      return json({ block_number: timestamp - 1_700_000_000 })
    }
    assert.ok(url.pathname.endsWith('/stream'), `Unexpected request: ${url}`)
    const query = JSON.parse(String(init?.body)) as {
      fromBlock: number
      toBlock: number
      transactions?: unknown[]
    }
    if (query.transactions) {
      aggregationRequests += 1
      now += 100
      return json({
        header: { number: query.toBlock, timestamp: 1_700_000_000 + query.toBlock },
        transactions: [{ fee: '5000', feePayer: '11111111111111111111111111111111', err: null }],
      })
    }
    const blocks = Array.from({ length: query.toBlock - query.fromBlock + 1 }, (_, index) => ({
      header: { number: query.fromBlock + index, timestamp: 1_700_000_000 + query.fromBlock + index },
    }))
    return new Response(blocks.map((block) => JSON.stringify(block)).join('\n'))
  })

  const args = { timeframe: '5m', response_format: 'full' }
  const fresh = (await callTool(args)).structuredContent
  const cached = (await callTool(args)).structuredContent
  assert.equal(aggregationRequests, 1)
  assert.equal(cached._cache?.hit, true)
  assert.equal(cached.network.slot_range, fresh.network.slot_range)

  // The head expires before the analytics entry, which was saved after its scan.
  head += 10
  now = initialTime + 30_050
  const moved = (await callTool(args)).structuredContent
  assert.equal(aggregationRequests, 2)
  assert.equal(moved._cache, undefined)
  assert.equal(moved._freshness.window_to_block, head)
  assert.equal(moved._coverage.analyzed_to_block, head)
  assert.equal(moved.network.slot_range, moved._meta.queried_blocks)
  assert.ok(moved.network.slot_range.endsWith(`-${head}`))
})
