import { formatTimestamp } from './formatting.js'
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

export interface BucketCoverage {
  kind: 'bucket_window'
  window_complete: boolean
  expected_buckets: number
  returned_buckets: number
  filled_buckets: number
  empty_buckets: number
  anchor: string
}

export interface AnalysisCoverage {
  kind: 'analysis_window'
  window_complete: boolean
  result_complete: boolean
  continuation: 'cursor' | 'none'
  window_from_block: number
  window_to_block: number
  analyzed_from_block: number
  analyzed_to_block: number
  requested_blocks: number
  analyzed_blocks: number
  sampled: boolean
}

export interface SectionCoverage {
  kind: 'section_window'
  window_complete: boolean
  result_complete: boolean
  continuation: 'cursor' | 'none'
  window_from_block: number
  window_to_block: number
  sections: Record<string, { returned: number; has_more: boolean }>
}

export interface BucketGapDiagnosticItem {
  bucket_index: number
  timestamp: number
  timestamp_human: string
  gap_kind: 'no_activity' | 'coverage_gap_likely'
  reason: string
}

export interface BucketGapDiagnostics {
  kind: 'bucket_gap_diagnostics'
  anchor: string
  window_complete: boolean
  empty_bucket_count: number
  no_activity_bucket_count: number
  coverage_gap_likely_bucket_count: number
  sampled_empty_bucket_count: number
  empty_buckets_truncated: boolean
  empty_buckets: BucketGapDiagnosticItem[]
  first_observed_timestamp?: number
  first_observed_timestamp_human?: string
  last_observed_timestamp?: number
  last_observed_timestamp_human?: string
}

export interface ChronologicalPageOrdering {
  kind: 'chronological_page'
  page_order: 'oldest_to_newest' | 'newest_to_oldest'
  sorted_by: string
  direction: 'asc' | 'desc'
  continuation: 'older' | 'newer' | 'none'
  window_focus: 'most_recent_matches' | 'oldest_matches'
  tie_breakers?: string[]
}

export interface RankedOrdering {
  kind: 'ranking'
  page_order: 'rank_ascending' | 'rank_descending'
  sorted_by: string
  direction: 'asc' | 'desc'
  rank_field?: string
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

export function buildBucketCoverage(params: {
  expectedBuckets: number
  returnedBuckets: number
  filledBuckets: number
  anchor: string
  windowComplete?: boolean
}): BucketCoverage {
  return {
    kind: 'bucket_window',
    window_complete: params.windowComplete ?? true,
    expected_buckets: params.expectedBuckets,
    returned_buckets: params.returnedBuckets,
    filled_buckets: params.filledBuckets,
    empty_buckets: Math.max(0, params.returnedBuckets - params.filledBuckets),
    anchor: params.anchor,
  }
}

export function buildAnalysisCoverage(params: {
  windowFromBlock: number
  windowToBlock: number
  analyzedFromBlock: number
  analyzedToBlock: number
  hasMore?: boolean
}): AnalysisCoverage {
  return {
    kind: 'analysis_window',
    window_complete: params.analyzedFromBlock <= params.windowFromBlock && params.analyzedToBlock >= params.windowToBlock,
    result_complete: !(params.hasMore ?? false),
    continuation: params.hasMore ? 'cursor' : 'none',
    window_from_block: params.windowFromBlock,
    window_to_block: params.windowToBlock,
    analyzed_from_block: params.analyzedFromBlock,
    analyzed_to_block: params.analyzedToBlock,
    requested_blocks: Math.max(0, params.windowToBlock - params.windowFromBlock + 1),
    analyzed_blocks: Math.max(0, params.analyzedToBlock - params.analyzedFromBlock + 1),
    sampled: params.analyzedFromBlock > params.windowFromBlock || params.analyzedToBlock < params.windowToBlock,
  }
}

export function buildSectionCoverage(params: {
  windowFromBlock: number
  windowToBlock: number
  hasMore: boolean
  sections: Record<string, { returned: number; has_more: boolean }>
}): SectionCoverage {
  return {
    kind: 'section_window',
    window_complete: true,
    result_complete: !params.hasMore,
    continuation: params.hasMore ? 'cursor' : 'none',
    window_from_block: params.windowFromBlock,
    window_to_block: params.windowToBlock,
    sections: params.sections,
  }
}

export function buildChronologicalPageOrdering(params: {
  sortedBy: string
  continuation?: 'older' | 'newer' | 'none'
  pageOrder?: 'oldest_to_newest' | 'newest_to_oldest'
  windowFocus?: 'most_recent_matches' | 'oldest_matches'
  tieBreakers?: string[]
}): ChronologicalPageOrdering {
  return {
    kind: 'chronological_page',
    page_order: params.pageOrder ?? 'oldest_to_newest',
    sorted_by: params.sortedBy,
    direction: params.pageOrder === 'newest_to_oldest' ? 'desc' : 'asc',
    continuation: params.continuation ?? 'older',
    window_focus: params.windowFocus ?? 'most_recent_matches',
    ...(params.tieBreakers && params.tieBreakers.length > 0 ? { tie_breakers: params.tieBreakers } : {}),
  }
}

export function buildRankedOrdering(params: {
  sortedBy: string
  direction: 'asc' | 'desc'
  pageOrder?: 'rank_ascending' | 'rank_descending'
  rankField?: string
}): RankedOrdering {
  return {
    kind: 'ranking',
    page_order: params.pageOrder ?? 'rank_ascending',
    sorted_by: params.sortedBy,
    direction: params.direction,
    ...(params.rankField ? { rank_field: params.rankField } : {}),
  }
}

export function buildBucketGapDiagnostics<T extends { bucket_index: number; timestamp: number; timestamp_human?: string }>(params: {
  buckets: T[]
  intervalSeconds: number
  isFilled: (bucket: T) => boolean
  anchor: string
  windowComplete?: boolean
  firstObservedTimestamp?: number
  lastObservedTimestamp?: number
  maxEmptyBuckets?: number
}): BucketGapDiagnostics {
  const emptyBuckets = params.buckets.filter((bucket) => !params.isFilled(bucket))
  const windowComplete = params.windowComplete ?? true
  const maxEmptyBuckets = params.maxEmptyBuckets ?? 100

  let noActivityBucketCount = 0
  let coverageGapLikelyBucketCount = 0

  const classifyGapKind = (bucket: T) => {
    const bucketEnd = bucket.timestamp + params.intervalSeconds
    const beforeObservedData =
      params.firstObservedTimestamp !== undefined && bucketEnd <= params.firstObservedTimestamp
    const afterObservedData =
      params.lastObservedTimestamp !== undefined && bucket.timestamp > params.lastObservedTimestamp
    return !windowComplete && (beforeObservedData || afterObservedData) ? 'coverage_gap_likely' : 'no_activity'
  }

  emptyBuckets.forEach((bucket) => {
    const gapKind = classifyGapKind(bucket)
    if (gapKind === 'coverage_gap_likely') {
      coverageGapLikelyBucketCount += 1
    } else {
      noActivityBucketCount += 1
    }
  })

  const diagnostics = emptyBuckets.slice(0, maxEmptyBuckets).map((bucket) => {
    const gapKind = classifyGapKind(bucket)

    return {
      bucket_index: bucket.bucket_index,
      timestamp: bucket.timestamp,
      timestamp_human: bucket.timestamp_human ?? formatTimestamp(bucket.timestamp),
      gap_kind: gapKind,
      reason:
        gapKind === 'coverage_gap_likely'
          ? 'This bucket sits outside the observed data span for the requested window, so the gap may come from incomplete coverage rather than zero activity.'
          : 'Observed data covers this bucket, so it appears to be a real zero-activity interval.',
    } satisfies BucketGapDiagnosticItem
  })

  return {
    kind: 'bucket_gap_diagnostics',
    anchor: params.anchor,
    window_complete: windowComplete,
    empty_bucket_count: emptyBuckets.length,
    no_activity_bucket_count: noActivityBucketCount,
    coverage_gap_likely_bucket_count: coverageGapLikelyBucketCount,
    sampled_empty_bucket_count: diagnostics.length,
    empty_buckets_truncated: emptyBuckets.length > diagnostics.length,
    empty_buckets: diagnostics,
    ...(params.firstObservedTimestamp !== undefined
      ? {
          first_observed_timestamp: params.firstObservedTimestamp,
          first_observed_timestamp_human: formatTimestamp(params.firstObservedTimestamp),
        }
      : {}),
    ...(params.lastObservedTimestamp !== undefined
      ? {
          last_observed_timestamp: params.lastObservedTimestamp,
          last_observed_timestamp_human: formatTimestamp(params.lastObservedTimestamp),
        }
      : {}),
  }
}
