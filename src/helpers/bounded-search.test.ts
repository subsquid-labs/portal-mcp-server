import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { scanBoundedBlockRange } from './bounded-search.js'

describe('scanBoundedBlockRange concurrency', () => {
  it('merges chunks in scan order without losing matches when an empty sibling settles second', async () => {
    const result = await scanBoundedBlockRange<string>({
      fromBlock: 1,
      toBlock: 20,
      chunkSize: 10,
      concurrency: 2,
      scanOrder: 'latest',
      shouldContinue: (state) => state.items.length === 0,
      fetchChunk: async (chunk) => {
        if (chunk.fromBlock === 11) {
          // Newer chunk resolves first with a match
          return ['match-in-newest']
        }
        // Older sibling resolves slower and is empty
        await new Promise((resolve) => setTimeout(resolve, 15))
        return []
      },
    })

    assert.deepEqual(result.items, ['match-in-newest'])
    assert.equal(result.scannedFromBlock, 11)
    assert.equal(result.scannedToBlock, 20)
    assert.equal(result.scannedBlocks, 10)
    assert.equal(result.chunkCount, 1)
  })

  it('propagates errors from the first failing chunk in scan order', async () => {
    await assert.rejects(
      () =>
        scanBoundedBlockRange<string>({
          fromBlock: 1,
          toBlock: 20,
          chunkSize: 10,
          concurrency: 2,
          scanOrder: 'latest',
          shouldContinue: (state) => state.items.length === 0,
          fetchChunk: async (chunk) => {
            if (chunk.fromBlock === 11) {
              throw new Error('upstream boom')
            }
            return ['match-in-older']
          },
        }),
      /upstream boom/,
    )
  })
})
