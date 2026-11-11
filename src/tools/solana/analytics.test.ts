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

test('Solana analytics publishes only completed program samples', async (t) => {
  for (const [responseFormat, interruptStream] of [
    ['full', true],
    ['compact', true],
    ['summary', true],
    ['full', false],
  ] as const) {
    await t.test(`${responseFormat}: ${interruptStream ? 'interrupted' : 'complete'}`, async (t) => {
      type Payload = {
        throughput?: { total_transactions: number }
        overview?: { total_transactions: number }
        top_programs?: {
          status?: string
          programs?: unknown[]
          slots_sampled?: number
          total_instructions?: number
        }
        _notice?: string
        _notices?: string[]
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

      t.mock.method(Date, 'now', () => 1_900_000_000_000)
      let instructionRequests = 0
      t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input))
        const json = (value: unknown) => new Response(JSON.stringify(value))
        if (url.pathname === '/datasets') {
          return json([{ dataset: 'solana-mainnet', aliases: [], metadata: { kind: 'solana' } }])
        }
        if (url.pathname.endsWith('/metadata')) return json({ start_block: 0 })
        if (url.pathname.endsWith('/head') || url.pathname.endsWith('/finalized-head')) {
          return json({ number: 2_000_000 })
        }
        if (url.pathname.includes('/timestamps/')) {
          const timestamp = Number(url.pathname.split('/').at(-2))
          return json({ block_number: timestamp - 1_700_000_000 })
        }
        assert.ok(url.pathname.endsWith('/stream'), `Unexpected request: ${url}`)
        const query = JSON.parse(String(init?.body)) as {
          fromBlock: number
          toBlock: number
          transactions?: unknown[]
          instructions?: unknown[]
        }
        if (query.instructions) {
          instructionRequests++
          if (!interruptStream) {
            return json({
              header: { number: query.toBlock },
              instructions: [
                { programId: '11111111111111111111111111111111', computeUnitsConsumed: 200 },
                { programId: '11111111111111111111111111111111', computeUnitsConsumed: 400 },
              ],
            })
          }
          let delivered = false
          return new Response(
            new ReadableStream<Uint8Array>({
              pull(controller) {
                if (delivered) {
                  controller.error(new Error('Instruction stream interrupted'))
                  return
                }
                delivered = true
                controller.enqueue(
                  new TextEncoder().encode(
                    JSON.stringify({
                      header: { number: query.fromBlock },
                      instructions: [{ programId: '11111111111111111111111111111111', computeUnitsConsumed: 200 }],
                    }) + '\n',
                  ),
                )
              },
            }),
          )
        }
        if (query.transactions) {
          return json({
            header: { number: query.toBlock },
            transactions: [{ fee: '5000', feePayer: '11111111111111111111111111111111', err: null }],
          })
        }
        const blocks = Array.from({ length: query.toBlock - query.fromBlock + 1 }, (_, index) => ({
          header: { number: query.fromBlock + index, timestamp: 1_700_000_000 + query.fromBlock + index },
        }))
        return new Response(blocks.map((block) => JSON.stringify(block)).join('\n'))
      })

      const payload = (await callTool({ timeframe: '5m', include_programs: true, response_format: responseFormat }))
        .structuredContent
      assert.equal(instructionRequests, 1)
      assert.equal(payload.throughput?.total_transactions ?? payload.overview?.total_transactions, 1)
      if (!interruptStream) {
        assert.equal(payload.top_programs?.status, undefined)
        assert.equal(payload.top_programs?.slots_sampled, 1)
        assert.equal(payload.top_programs?.total_instructions, 2)
        assert.deepEqual(payload.top_programs?.programs, [
          {
            rank: 1,
            program_id: '11111111111111111111111111111111',
            program_name: 'System Program',
            instruction_count: 2,
            instruction_count_formatted: '2.00',
            share: '100.0%',
            avg_compute_units: 300,
          },
        ])
        return
      }
      assert.equal(payload.top_programs?.status, 'unavailable')
      assert.equal(payload.top_programs?.programs, undefined)
      assert.equal(payload.top_programs?.slots_sampled, undefined)
      assert.equal(payload.top_programs?.total_instructions, undefined)
      const notices = [payload._notice, ...(payload._notices ?? [])].filter(Boolean).join(' ')
      assert.match(notices, /instruction sample could not be completed/)
      assert.match(notices, /Partial instruction counts were discarded/)
    })
  }
})
