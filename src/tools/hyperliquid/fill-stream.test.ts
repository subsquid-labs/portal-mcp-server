import assert from 'node:assert/strict'
import { afterEach, it } from 'node:test'

import { ActionableError, createTimeoutError } from '../../helpers/errors.js'
import { visitHyperliquidFillBlocks } from './fill-stream.js'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

it('does not count delivered fills again when a large chunk is split', async () => {
  let calls = 0
  const deliveredBlocks: number[] = []
  let totalFills = 0
  globalThis.fetch = async (_url, init) => {
    calls++
    if (calls !== 1) {
      assert.deepEqual(JSON.parse(String(init?.body)).fromBlock, 2)
      return new Response('{"header":{"number":2},"fills":[{}]}\n')
    }
    let reads = 0
    return new Response(
      new ReadableStream({
        pull(controller) {
          if (reads++ === 0) {
            controller.enqueue(new TextEncoder().encode('{"header":{"number":1},"fills":[{}]}\n'))
          } else if (reads === 2) {
            controller.enqueue(new TextEncoder().encode(`${JSON.stringify({ padding: 'x'.repeat(100) })}\n`))
          } else controller.close()
        },
      }),
    )
  }

  const summary = await visitHyperliquidFillBlocks({
    dataset: 'hyperliquid-fills',
    fromBlock: 1,
    toBlock: 2,
    initialChunkSize: 2,
    minChunkSize: 1,
    maxBytes: 80,
    fillFilter: {},
    fillFields: {},
    onBlock: (block) => {
      if (block.header) deliveredBlocks.push(block.header.number ?? 0)
      totalFills += block.fills?.length ?? 0
    },
  })
  assert.equal(calls, 2)
  assert.deepEqual(deliveredBlocks, [1, 2])
  assert.equal(summary.returnedFills, 2)
  assert.equal(summary.chunkSizeReduced, true)
  assert.equal(totalFills, 2)
})

it('resumes after a timed-out fill block without counting its side effects twice', async () => {
  let calls = 0
  let totalFills = 0
  globalThis.fetch = async (_url, init) => {
    calls++
    const query = JSON.parse(String(init?.body))
    if (calls > 1) {
      assert.equal(query.fromBlock, 2)
      return new Response('{"header":{"number":2},"fills":[{},{}]}\n')
    }
    let reads = 0
    return new Response(
      new ReadableStream(
        {
          pull(controller) {
            if (reads++ === 0) controller.enqueue(new TextEncoder().encode('{"header":{"number":1},"fills":[{}]}\n'))
            else controller.error(createTimeoutError(30))
          },
        },
        { highWaterMark: 0 },
      ),
    )
  }
  const result = await visitHyperliquidFillBlocks({
    dataset: 'hyperliquid-fills',
    fromBlock: 1,
    toBlock: 2,
    initialChunkSize: 2,
    minChunkSize: 1,
    fillFilter: {},
    fillFields: {},
    onBlock: (block) => {
      totalFills += block.fills?.length ?? 0
    },
  })
  assert.equal(calls, 2)
  assert.equal(totalFills, 3)
  assert.equal(result.returnedBlocks, 2)
  assert.equal(result.returnedFills, 3)
})

it('stops repeated timeout recovery even when each attempt advances one block', async () => {
  let calls = 0
  const visited: number[] = []
  globalThis.fetch = async (_url, init) => {
    calls++
    const { fromBlock } = JSON.parse(String(init?.body))
    let reads = 0
    return new Response(
      new ReadableStream(
        {
          pull(controller) {
            if (reads++ === 0)
              controller.enqueue(
                new TextEncoder().encode(`${JSON.stringify({ header: { number: fromBlock }, fills: [{}] })}\n`),
              )
            else controller.error(createTimeoutError(30))
          },
        },
        { highWaterMark: 0 },
      ),
    )
  }
  await assert.rejects(
    visitHyperliquidFillBlocks({
      dataset: 'hyperliquid-fills',
      fromBlock: 1,
      toBlock: 20,
      initialChunkSize: 20,
      minChunkSize: 1,
      fillFilter: {},
      fillFields: {},
      onBlock: (block) => {
        visited.push(block.header?.number ?? 0)
      },
    }),
    (error: unknown) => error instanceof ActionableError && error.code === 'incomplete_result',
  )
  assert.equal(calls, 9)
  assert.deepEqual(visited, [1, 2, 3, 4, 5, 6, 7, 8, 9])
})
