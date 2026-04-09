import { Buffer } from 'node:buffer'

import { ActionableError } from './errors.js'

const CURSOR_VERSION = 1

type CursorPayload = {
  version?: number
  tool?: unknown
  [key: string]: unknown
}

export interface PaginationInfo {
  [key: string]: unknown
  type: 'cursor'
  page_size: number
  returned: number
  has_more: boolean
  next_cursor?: string
}

export interface BlockBoundaryCursor {
  page_to_block: number
  skip_inclusive_block: number
}

export interface RecentPageCursor<TRequest extends Record<string, unknown>> extends BlockBoundaryCursor {
  [key: string]: unknown
  tool: string
  dataset: string
  request: TRequest
  window_from_block: number
  window_to_block: number
}

export function encodeCursor(payload: Record<string, unknown>): string {
  return Buffer.from(
    JSON.stringify({
      version: CURSOR_VERSION,
      ...payload,
    }),
    'utf8',
  ).toString('base64url')
}

export function decodeCursor<T extends CursorPayload>(cursor: string, expectedTool: string): T {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as T
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('Cursor payload must be an object')
    }

    if ((parsed.version ?? CURSOR_VERSION) !== CURSOR_VERSION) {
      throw new Error(`Unsupported cursor version: ${String(parsed.version)}`)
    }

    if (parsed.tool !== expectedTool) {
      throw new Error(`Cursor is for ${String(parsed.tool ?? 'another tool')}, not ${expectedTool}`)
    }

    return parsed
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new ActionableError('Invalid pagination cursor.', [
      'Use the exact next_cursor value from the previous response.',
      'Do not edit or truncate the cursor string.',
      'Start a fresh query without cursor if you want a new preview window.',
    ], { expected_tool: expectedTool, detail })
  }
}

export function trimBoundaryItemsFromEnd<T>(
  items: T[],
  cursor: BlockBoundaryCursor | undefined,
  getBlockNumber: (item: T) => number | undefined,
): T[] {
  if (!cursor || cursor.skip_inclusive_block <= 0) {
    return items.slice()
  }

  const trimmed = items.slice()
  let remainingToSkip = cursor.skip_inclusive_block

  while (remainingToSkip > 0 && trimmed.length > 0) {
    const lastItem = trimmed[trimmed.length - 1]
    if (getBlockNumber(lastItem) !== cursor.page_to_block) {
      break
    }
    trimmed.pop()
    remainingToSkip--
  }

  return trimmed
}

export function buildNextBoundaryCursor<T>(
  pageItems: T[],
  getBlockNumber: (item: T) => number | undefined,
): BlockBoundaryCursor | undefined {
  if (pageItems.length === 0) {
    return undefined
  }

  const boundaryBlock = getBlockNumber(pageItems[0])
  if (boundaryBlock === undefined) {
    return undefined
  }

  const skip_inclusive_block = pageItems.filter((item) => getBlockNumber(item) === boundaryBlock).length
  if (skip_inclusive_block <= 0) {
    return undefined
  }

  return {
    page_to_block: boundaryBlock,
    skip_inclusive_block,
  }
}

export function paginateAscendingItems<T>(
  items: T[],
  limit: number,
  getBlockNumber: (item: T) => number | undefined,
  cursor?: BlockBoundaryCursor,
): {
  pageItems: T[]
  hasMore: boolean
  nextBoundary?: BlockBoundaryCursor
} {
  const remainingItems = trimBoundaryItemsFromEnd(items, cursor, getBlockNumber)
  const hasMore = remainingItems.length > limit
  const pageItems = remainingItems.slice(Math.max(0, remainingItems.length - limit))

  return {
    pageItems,
    hasMore,
    nextBoundary: hasMore ? buildNextBoundaryCursor(pageItems, getBlockNumber) : undefined,
  }
}

export function buildPaginationInfo(pageSize: number, returned: number, nextCursor?: string): PaginationInfo {
  return {
    type: 'cursor',
    page_size: pageSize,
    returned,
    has_more: Boolean(nextCursor),
    ...(nextCursor ? { next_cursor: nextCursor } : {}),
  }
}

export function decodeRecentPageCursor<TRequest extends Record<string, unknown>>(
  cursor: string,
  expectedTool: string,
): RecentPageCursor<TRequest> {
  return decodeCursor<RecentPageCursor<TRequest>>(cursor, expectedTool)
}

export function encodeRecentPageCursor<TRequest extends Record<string, unknown>>(
  params: RecentPageCursor<TRequest>,
): string {
  return encodeCursor(params)
}
