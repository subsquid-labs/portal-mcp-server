import { PORTAL_URL } from '../../constants/index.js'
import { portalFetchStreamVisit } from '../../helpers/fetch.js'

export type HyperliquidFillBlock = {
  header?: {
    number?: number
    timestamp?: number
  }
  fills?: Array<Record<string, any>>
}

interface VisitHyperliquidFillBlocksOptions {
  dataset: string
  fromBlock: number
  toBlock: number
  fillFilter: Record<string, unknown>
  fillFields: Record<string, boolean>
  onBlock: (block: HyperliquidFillBlock) => void | Promise<void>
  initialChunkSize?: number
  minChunkSize?: number
  maxBytes?: number
  concurrency?: number
}

export async function visitHyperliquidFillBlocks({
  dataset,
  fromBlock,
  toBlock,
  fillFilter,
  fillFields,
  onBlock,
  initialChunkSize = 40000,
  minChunkSize = 5000,
  maxBytes = 150 * 1024 * 1024,
  concurrency = 1,
}: VisitHyperliquidFillBlocksOptions): Promise<{
  chunksFetched: number
  chunkSizeReduced: boolean
  returnedBlocks: number
  returnedFills: number
}> {
  const buildRanges = (rangeFrom: number, rangeTo: number, size: number) => {
    const ranges: Array<{ from: number; to: number }> = []
    for (let current = rangeFrom; current <= rangeTo; current += size) {
      ranges.push({
        from: current,
        to: Math.min(current + size - 1, rangeTo),
      })
    }
    return ranges
  }

  const visitRange = async (rangeFrom: number, rangeTo: number) => {
    let currentFrom = rangeFrom
    let chunkSize = Math.min(initialChunkSize, Math.max(1, rangeTo - rangeFrom + 1))
    let chunksFetched = 0
    let returnedBlocks = 0
    let returnedFills = 0
    let chunkSizeReduced = false

    while (currentFrom <= rangeTo) {
      const chunkTo = Math.min(currentFrom + chunkSize - 1, rangeTo)
      let lastReturnedBlock: number | undefined

      try {
        const processedBlocks = await portalFetchStreamVisit(
          `${PORTAL_URL}/datasets/${dataset}/stream`,
          {
            type: 'hyperliquidFills',
            fromBlock: currentFrom,
            toBlock: chunkTo,
            fields: {
              fill: fillFields,
            },
            fills: [fillFilter],
          },
          {
            maxBytes,
            onRecord: async (record) => {
              const block = record as HyperliquidFillBlock
              if (typeof block.header?.number === 'number') {
                lastReturnedBlock = block.header.number
              }
              returnedBlocks += 1
              returnedFills += block.fills?.length || 0
              await onBlock(block)
            },
          },
        )

        if (processedBlocks === 0) {
          break
        }

        chunksFetched += 1

        if (lastReturnedBlock !== undefined && lastReturnedBlock >= currentFrom && lastReturnedBlock < chunkTo) {
          currentFrom = lastReturnedBlock + 1
          continue
        }

        currentFrom = chunkTo + 1
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)

        if (message.includes('Response too large') && chunkSize > minChunkSize) {
          chunkSize = Math.max(minChunkSize, Math.floor(chunkSize / 2))
          chunkSizeReduced = true
          continue
        }

        throw new Error(`Failed to fetch Hyperliquid fills chunk: ${message}`)
      }
    }

    return {
      chunksFetched,
      chunkSizeReduced,
      returnedBlocks,
      returnedFills,
    }
  }

  const initialRanges = buildRanges(
    fromBlock,
    toBlock,
    Math.max(minChunkSize, Math.min(initialChunkSize, Math.max(1, toBlock - fromBlock + 1))),
  )

  let chunksFetched = 0
  let chunkSizeReduced = false
  let returnedBlocks = 0
  let returnedFills = 0

  for (let index = 0; index < initialRanges.length; index += concurrency) {
    const batch = initialRanges.slice(index, index + concurrency)
    const results = await Promise.all(batch.map((range) => visitRange(range.from, range.to)))
    for (const result of results) {
      chunksFetched += result.chunksFetched
      chunkSizeReduced = chunkSizeReduced || result.chunkSizeReduced
      returnedBlocks += result.returnedBlocks
      returnedFills += result.returnedFills
    }
  }

  return {
    chunksFetched,
    chunkSizeReduced,
    returnedBlocks,
    returnedFills,
  }
}
