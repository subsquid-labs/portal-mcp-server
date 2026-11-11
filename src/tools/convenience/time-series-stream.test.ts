import assert from 'node:assert/strict'
import { afterEach, it } from 'node:test'

import type { McpServer } from '@modelcontextprotocol/server'
import type { z } from 'zod'

import { createTimeoutError } from '../../helpers/errors.js'
import { registerGetTimeSeriesDataTool } from './time-series.js'

const originalFetch = globalThis.fetch
const headBlock = 100_000
const headTimestamp = 1_800_000_000

afterEach(() => {
  globalThis.fetch = originalFetch
})

it('resumes a grouped contract scan after a delivered block times out without inflating counts', async () => {
  type Payload = {
    summary: { total_transactions: number; chunk_size_reduced?: boolean }
    top_contracts: Array<{ transaction_count: number }>
    time_series: Array<{ transaction_count: number }>
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
  registerGetTimeSeriesDataTool(server)
  assert.ok(callTool)
  let aggregationRequests = 0
  const requestedStarts: number[] = []
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input))
    if (url.pathname === '/datasets')
      return Response.json(
        ['ethereum-mainnet', 'base-sepolia'].map((dataset) => ({ dataset, aliases: [], metadata: { kind: 'evm' } })),
      )
    if (url.pathname.endsWith('/metadata')) return Response.json({ start_block: 0 })
    if (url.pathname.endsWith('/head') || url.pathname.endsWith('/finalized-head'))
      return Response.json({ number: headBlock })
    if (url.pathname.includes('/timestamps/')) {
      const timestamp = Number(url.pathname.split('/').at(-2)) / 1000
      return Response.json({ block_number: headBlock + Math.floor((timestamp - headTimestamp) / 12) })
    }
    assert.ok(url.pathname.endsWith('/stream'))
    const query = JSON.parse(String(init?.body))
    const blocks = Array.from({ length: query.toBlock - query.fromBlock + 1 }, (_, index) => {
      const number = query.fromBlock + index
      return {
        header: { number, timestamp: headTimestamp + (number - headBlock) * 12 },
        ...(query.transactions ? { transactions: [{ to: '0x1234' }] } : {}),
      }
    })
    if (query.transactions) {
      requestedStarts.push(query.fromBlock)
      if (++aggregationRequests === 2) {
        let reads = 0
        return new Response(
          new ReadableStream(
            {
              pull(controller) {
                if (reads++ === 0) controller.enqueue(new TextEncoder().encode(`${JSON.stringify(blocks[0])}\n`))
                else controller.error(createTimeoutError(30))
              },
            },
            { highWaterMark: 0 },
          ),
        )
      }
    }
    return new Response(blocks.map((block) => JSON.stringify(block)).join('\n'))
  }
  const payload = (
    await callTool({
      network: 'ethereum-mainnet',
      metric: 'transaction_count',
      duration: '15m',
      interval: '5m',
      group_by: 'contract',
    })
  ).structuredContent
  assert.equal(payload.summary.total_transactions, 76)
  assert.equal(payload.top_contracts[0].transaction_count, 76)
  assert.equal(
    payload.time_series.reduce((sum, row) => sum + row.transaction_count, 0),
    76,
  )
  assert.equal(payload.summary.chunk_size_reduced, true)
  assert.deepEqual(requestedStarts, [99_925, 99_925, 99_926])
})

it('keeps the reduced chunk size for the second grouped-contract pass', async () => {
  type Payload = {
    summary: { total_transactions: number; chunk_size_reduced?: boolean }
    top_contracts: Array<{ transaction_count: number }>
    time_series: Array<{ transaction_count: number }>
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
  registerGetTimeSeriesDataTool(server)
  assert.ok(callTool)
  const fromBlock = headBlock - 1800
  let failures = 0
  const passStartingSizes: number[] = []
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input))
    if (url.pathname === '/datasets')
      return Response.json(
        ['ethereum-mainnet', 'base-sepolia'].map((dataset) => ({ dataset, aliases: [], metadata: { kind: 'evm' } })),
      )
    if (url.pathname.endsWith('/metadata')) return Response.json({ start_block: 0 })
    if (url.pathname.endsWith('/head') || url.pathname.endsWith('/finalized-head'))
      return Response.json({ number: headBlock })
    if (url.pathname.includes('/timestamps/')) {
      const timestamp = Number(url.pathname.split('/').at(-2)) / 1000
      return Response.json({ block_number: headBlock + Math.floor((timestamp - headTimestamp) / 12) })
    }
    assert.ok(url.pathname.endsWith('/stream'))
    const query = JSON.parse(String(init?.body))
    const size = query.toBlock - query.fromBlock + 1
    const blocks = Array.from({ length: size }, (_, index) => ({
      header: {
        number: query.fromBlock + index,
        timestamp: headTimestamp + (query.fromBlock + index - headBlock) * 12,
      },
      ...(query.transactions ? { transactions: [{ to: '0x1234' }] } : {}),
    }))
    if (query.transactions) {
      if (query.fromBlock === fromBlock) passStartingSizes.push(size)
      if (size > 50) {
        failures += 1
        let reads = 0
        return new Response(
          new ReadableStream(
            {
              pull(controller) {
                if (reads++ === 0) controller.enqueue(new TextEncoder().encode(`${JSON.stringify(blocks[0])}\n`))
                else controller.error(createTimeoutError(30))
              },
            },
            { highWaterMark: 0 },
          ),
        )
      }
    }
    return new Response(blocks.map((block) => JSON.stringify(block)).join('\n'))
  }
  const result = await callTool({
    network: 'ethereum-mainnet',
    metric: 'transaction_count',
    duration: '6h',
    interval: '1h',
    group_by: 'contract',
  })
  const payload = result.structuredContent
  assert.deepEqual(passStartingSizes, [1500, 50])
  assert.equal(failures, 5)
  assert.equal(payload.summary.total_transactions, 1801)
  assert.equal(payload.top_contracts[0].transaction_count, 1801)
  assert.equal(
    payload.time_series.reduce((sum, row) => sum + row.transaction_count, 0),
    1801,
  )
  assert.equal(payload.summary.chunk_size_reduced, true)
})

it('defaults Base Sepolia charts to a scannable 15-minute window', async () => {
  let callTool:
    | ((args: Record<string, unknown>) => Promise<{ structuredContent: { summary: { duration: string } } }>)
    | undefined
  const server = {
    registerTool: (
      _name: string,
      config: { inputSchema: z.ZodType<Record<string, unknown>> },
      handler: (
        args: Record<string, unknown>,
        context: unknown,
      ) => Promise<{ structuredContent: { summary: { duration: string } } }>,
    ) => {
      callTool = (args) => handler(config.inputSchema.parse(args), {})
    },
  } as unknown as McpServer
  registerGetTimeSeriesDataTool(server)
  assert.ok(callTool)
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input))
    if (url.pathname === '/datasets')
      return Response.json(
        ['ethereum-mainnet', 'base-sepolia'].map((dataset) => ({ dataset, aliases: [], metadata: { kind: 'evm' } })),
      )
    if (url.pathname.endsWith('/metadata')) return Response.json({ start_block: 0 })
    if (url.pathname.endsWith('/head') || url.pathname.endsWith('/finalized-head'))
      return Response.json({ number: headBlock })
    if (url.pathname.includes('/timestamps/')) {
      const timestamp = Number(url.pathname.split('/').at(-2)) / 1000
      return Response.json({ block_number: headBlock + Math.floor((timestamp - headTimestamp) / 0.2) })
    }
    assert.ok(url.pathname.endsWith('/stream'))
    const query = JSON.parse(String(init?.body))
    const blocks = Array.from({ length: query.toBlock - query.fromBlock + 1 }, (_, index) => {
      const number = query.fromBlock + index
      return { header: { number, timestamp: headTimestamp + (number - headBlock) * 0.2, gasUsed: '0x1' } }
    })
    return new Response(blocks.map((block) => JSON.stringify(block)).join('\n'))
  }
  const payload = (await callTool({ network: 'base-sepolia', metric: 'gas_used', interval: '5m' })).structuredContent
  assert.equal(payload.summary.duration, '15m')
})
