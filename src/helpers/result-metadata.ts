import type { BlockAtTimestampResult, ResolvedBlockWindow } from './timeframe.js'

type TimestampBoundarySummary = Pick<
  BlockAtTimestampResult,
  'timestamp' | 'timestamp_human' | 'normalized_input' | 'resolution'
>

export interface QueryFreshness {
  kind: 'query_window'
  finality: 'latest' | 'finalized'
  range_kind: string
  indexed_head_block: number
  window_to_block: number
  lag_blocks: number
  timestamp_bounds?: {
    from?: TimestampBoundarySummary
    to?: TimestampBoundarySummary
  }
}

export interface QueryCoverage {
  kind: 'block_window'
  window_complete: boolean
  result_complete: boolean
  continuation: 'cursor' | 'none'
  window_from_block: number
  window_to_block: number
  page_to_block: number
  returned_items: number
  returned_from_block?: number
  returned_to_block?: number
}

export interface BlockLookupFreshness {
  kind: 'timestamp_lookup'
  resolution: 'exact' | 'estimated'
  requested_timestamp: number
  requested_timestamp_human: string
  normalized_input: string
  resolved_block_number: number
  head_block_number?: number
  head_timestamp?: number
  head_timestamp_human?: string
  estimated_block_time_seconds?: number
}

export function buildQueryFreshness(params: {
  finality: 'latest' | 'finalized'
  headBlockNumber: number
  windowToBlock: number
  resolvedWindow: {
    range_kind: string
    from_lookup?: BlockAtTimestampResult
    to_lookup?: BlockAtTimestampResult
  }
}): QueryFreshness {
  const { finality, headBlockNumber, windowToBlock, resolvedWindow } = params
  const timestampBounds: QueryFreshness['timestamp_bounds'] = {}

  if (resolvedWindow.from_lookup) {
    timestampBounds.from = {
      timestamp: resolvedWindow.from_lookup.timestamp,
      timestamp_human: resolvedWindow.from_lookup.timestamp_human,
      normalized_input: resolvedWindow.from_lookup.normalized_input,
      resolution: resolvedWindow.from_lookup.resolution,
    }
  }

  if (resolvedWindow.to_lookup) {
    timestampBounds.to = {
      timestamp: resolvedWindow.to_lookup.timestamp,
      timestamp_human: resolvedWindow.to_lookup.timestamp_human,
      normalized_input: resolvedWindow.to_lookup.normalized_input,
      resolution: resolvedWindow.to_lookup.resolution,
    }
  }

  return {
    kind: 'query_window',
    finality,
    range_kind: resolvedWindow.range_kind,
    indexed_head_block: headBlockNumber,
    window_to_block: windowToBlock,
    lag_blocks: Math.max(0, headBlockNumber - windowToBlock),
    ...(Object.keys(timestampBounds).length > 0 ? { timestamp_bounds: timestampBounds } : {}),
  }
}

export function buildQueryCoverage<T>(params: {
  windowFromBlock: number
  windowToBlock: number
  pageToBlock: number
  items: T[]
  getBlockNumber: (item: T) => number | undefined
  hasMore: boolean
  windowComplete?: boolean
}): QueryCoverage {
  const blockNumbers = params.items
    .map((item) => params.getBlockNumber(item))
    .filter((value): value is number => typeof value === 'number')

  const returnedFromBlock = blockNumbers.length > 0 ? Math.min(...blockNumbers) : undefined
  const returnedToBlock = blockNumbers.length > 0 ? Math.max(...blockNumbers) : undefined

  return {
    kind: 'block_window',
    window_complete: params.windowComplete ?? true,
    result_complete: !params.hasMore,
    continuation: params.hasMore ? 'cursor' : 'none',
    window_from_block: params.windowFromBlock,
    window_to_block: params.windowToBlock,
    page_to_block: params.pageToBlock,
    returned_items: params.items.length,
    ...(returnedFromBlock !== undefined ? { returned_from_block: returnedFromBlock } : {}),
    ...(returnedToBlock !== undefined ? { returned_to_block: returnedToBlock } : {}),
  }
}

export function buildBlockLookupFreshness(result: BlockAtTimestampResult): BlockLookupFreshness {
  return {
    kind: 'timestamp_lookup',
    resolution: result.resolution,
    requested_timestamp: result.timestamp,
    requested_timestamp_human: result.timestamp_human,
    normalized_input: result.normalized_input,
    resolved_block_number: result.block_number,
    ...(result.head_block_number !== undefined ? { head_block_number: result.head_block_number } : {}),
    ...(result.head_timestamp !== undefined ? { head_timestamp: result.head_timestamp } : {}),
    ...(result.head_timestamp_human ? { head_timestamp_human: result.head_timestamp_human } : {}),
    ...(result.estimated_block_time_seconds !== undefined
      ? { estimated_block_time_seconds: result.estimated_block_time_seconds }
      : {}),
  }
}
