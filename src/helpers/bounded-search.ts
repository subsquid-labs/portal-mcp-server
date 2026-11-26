import { applyGuardrail } from './guardrails.js'
import { reportPortalProgress } from './progress.js'

export type BoundedSearchScanOrder = 'earliest' | 'latest'

export type BoundedSearchChunk = {
  fromBlock: number
  toBlock: number
  index: number
}

export type BoundedSearchState<T> = {
  items: T[]
  scannedFromBlock: number
  scannedToBlock: number
  scannedBlocks: number
  chunkCount: number
}

export type BoundedSearchResult<T> = BoundedSearchState<T> & {
  requestedFromBlock: number
  requestedToBlock: number
  maxScanBlocks: number
  scanOrder: BoundedSearchScanOrder
  reachedMaxScanBlocks: boolean
  exhaustedWindow: boolean
  hasUnscannedBlocks: boolean
}

type ScanBoundedBlockRangeOptions<T> = {
  fromBlock: number
  toBlock: number
  chunkSize: number
  concurrency?: number
  scanOrder: BoundedSearchScanOrder
  maxScanBlocks?: number
  fetchChunk: (chunk: BoundedSearchChunk) => Promise<T[]>
  shouldContinue?: (state: BoundedSearchState<T>) => boolean
  mergeChunkItems?: (existing: T[], chunkItems: T[], chunk: BoundedSearchChunk) => T[]
}

export async function scanBoundedBlockRange<T>({
  fromBlock,
  toBlock,
  chunkSize,
  concurrency = 1,
  scanOrder,
  maxScanBlocks,
  fetchChunk,
  shouldContinue,
  mergeChunkItems,
}: ScanBoundedBlockRangeOptions<T>): Promise<BoundedSearchResult<T>> {
  const requestedBlocks = Math.max(0, toBlock - fromBlock + 1)
  const effectiveChunkSize = Math.max(1, Math.floor(chunkSize))
  const effectiveConcurrency = Math.max(1, Math.floor(concurrency))
  /* An operator ceiling sits above whatever the tool asked for. Clamping here
     rather than refusing means the scan still runs and still reports what it
     covered: reachedMaxScanBlocks and hasUnscannedBlocks already drive
     _coverage.result_complete, so a capped scan tells the truth by the same
     path a scan that hit its compiled bound does. */
  const guarded = applyGuardrail('max_scan_blocks', Math.floor(maxScanBlocks ?? requestedBlocks))
  const effectiveMaxScanBlocks = Math.max(1, Math.min(guarded.value, requestedBlocks))
  let items: T[] = []
  let scannedFromBlock = scanOrder === 'earliest' ? fromBlock : toBlock
  let scannedToBlock = scanOrder === 'earliest' ? fromBlock : toBlock
  let scannedBlocks = 0
  let chunkCount = 0

  const continueScanning = () =>
    scannedBlocks < effectiveMaxScanBlocks &&
    (!shouldContinue ||
      shouldContinue({
        items,
        scannedFromBlock,
        scannedToBlock,
        scannedBlocks,
        chunkCount,
      }))

  if (requestedBlocks > 0 && scanOrder === 'earliest') {
    for (let chunkFrom = fromBlock; chunkFrom <= toBlock && continueScanning(); chunkFrom += effectiveChunkSize) {
      const chunkTo = Math.min(toBlock, chunkFrom + effectiveChunkSize - 1, fromBlock + effectiveMaxScanBlocks - 1)
      const chunk = { fromBlock: chunkFrom, toBlock: chunkTo, index: chunkCount }
      const chunkItems = await fetchChunk(chunk)
      scannedFromBlock = chunkCount === 0 ? chunkFrom : Math.min(scannedFromBlock, chunkFrom)
      scannedToBlock = chunkTo
      scannedBlocks += chunkTo - chunkFrom + 1
      chunkCount += 1
      items = mergeChunkItems ? mergeChunkItems(items, chunkItems, chunk) : [...items, ...chunkItems]
      reportPortalProgress({
        phase: 'scan',
        progress: scannedBlocks,
        total: effectiveMaxScanBlocks,
        message: `Scanned ${scannedBlocks.toLocaleString('en-US')} / ${effectiveMaxScanBlocks.toLocaleString('en-US')} blocks`,
      })
    }
  } else if (requestedBlocks > 0 && effectiveConcurrency === 1) {
    for (let chunkTo = toBlock; chunkTo >= fromBlock && continueScanning(); chunkTo -= effectiveChunkSize) {
      const chunkFrom = Math.max(fromBlock, chunkTo - effectiveChunkSize + 1, toBlock - effectiveMaxScanBlocks + 1)
      const chunk = { fromBlock: chunkFrom, toBlock: chunkTo, index: chunkCount }
      const chunkItems = await fetchChunk(chunk)
      scannedFromBlock = chunkFrom
      scannedToBlock = chunkCount === 0 ? chunkTo : Math.max(scannedToBlock, chunkTo)
      scannedBlocks += chunkTo - chunkFrom + 1
      chunkCount += 1
      items = mergeChunkItems ? mergeChunkItems(items, chunkItems, chunk) : [...items, ...chunkItems]
      reportPortalProgress({
        phase: 'scan',
        progress: scannedBlocks,
        total: effectiveMaxScanBlocks,
        message: `Scanned ${scannedBlocks.toLocaleString('en-US')} / ${effectiveMaxScanBlocks.toLocaleString('en-US')} blocks`,
      })
    }
  } else if (requestedBlocks > 0) {
    let nextChunkTo = toBlock

    while (nextChunkTo >= fromBlock && continueScanning()) {
      const batch: BoundedSearchChunk[] = []
      let plannedBlocks = 0

      while (batch.length < effectiveConcurrency && nextChunkTo >= fromBlock) {
        const remainingBudget = effectiveMaxScanBlocks - scannedBlocks - plannedBlocks
        if (remainingBudget <= 0) break

        const chunkFrom = Math.max(
          fromBlock,
          nextChunkTo - effectiveChunkSize + 1,
          nextChunkTo - remainingBudget + 1,
          toBlock - effectiveMaxScanBlocks + 1,
        )
        const chunk = { fromBlock: chunkFrom, toBlock: nextChunkTo, index: chunkCount + batch.length }
        batch.push(chunk)
        plannedBlocks += nextChunkTo - chunkFrom + 1
        nextChunkTo = chunkFrom - 1
      }

      if (batch.length === 0) break

      const fetched = await Promise.allSettled(batch.map((chunk) => fetchChunk(chunk)))
      for (let index = 0; index < batch.length && continueScanning(); index += 1) {
        const outcome = fetched[index]
        if (outcome.status === 'rejected') throw outcome.reason

        const chunk = batch[index]
        scannedFromBlock = chunk.fromBlock
        scannedToBlock = chunkCount === 0 ? chunk.toBlock : Math.max(scannedToBlock, chunk.toBlock)
        scannedBlocks += chunk.toBlock - chunk.fromBlock + 1
        chunkCount += 1
        items = mergeChunkItems ? mergeChunkItems(items, outcome.value, chunk) : [...items, ...outcome.value]
      }
      reportPortalProgress({
        phase: 'scan',
        progress: scannedBlocks,
        total: effectiveMaxScanBlocks,
        message: `Scanned ${scannedBlocks.toLocaleString('en-US')} / ${effectiveMaxScanBlocks.toLocaleString('en-US')} blocks`,
      })
    }
  }

  const exhaustedWindow =
    requestedBlocks === 0 || (scanOrder === 'earliest' ? scannedToBlock >= toBlock : scannedFromBlock <= fromBlock)
  const reachedMaxScanBlocks = scannedBlocks >= effectiveMaxScanBlocks && !exhaustedWindow

  return {
    items,
    requestedFromBlock: fromBlock,
    requestedToBlock: toBlock,
    scannedFromBlock,
    scannedToBlock,
    scannedBlocks,
    chunkCount,
    maxScanBlocks: effectiveMaxScanBlocks,
    scanOrder,
    reachedMaxScanBlocks,
    exhaustedWindow,
    hasUnscannedBlocks: !exhaustedWindow,
  }
}

export function buildBoundedSearchExecution(result: BoundedSearchResult<unknown>) {
  return {
    scanned_from_block: result.scannedFromBlock,
    scanned_to_block: result.scannedToBlock,
    scanned_blocks: result.scannedBlocks,
    max_scan_blocks: result.maxScanBlocks,
    scan_order: result.scanOrder,
    scan_chunks: result.chunkCount,
  }
}

/* A scan leaves blocks unread for one of two reasons, and only one of them
   is cured by a bigger cap. When the scan stopped because it had what the
   page needed, the unread rest is reached through the cursor, and telling the
   caller to raise max_scan_blocks would send them the wrong way. */
export function buildBoundedSearchNotice(result: BoundedSearchResult<unknown>, label: string): string | undefined {
  if (!result.hasUnscannedBlocks) return undefined
  const scanned = `${label} searched only blocks ${result.scannedFromBlock}-${result.scannedToBlock} of requested window ${result.requestedFromBlock}-${result.requestedToBlock}`
  return result.reachedMaxScanBlocks
    ? `${scanned}; narrow filters or raise max_scan_blocks for deeper coverage.`
    : `${scanned}; the scan stopped once it had what this page needed.`
}
