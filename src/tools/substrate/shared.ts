import type { TimestampInput } from '../../helpers/timeframe.js'

export const SUBSTRATE_INDEXING_NOTICE =
  'Substrate datasets are currently indexed without a real-time tail; use _freshness to judge how current the indexed head is.'

export type SubstrateEventRequest = {
  timeframe?: string
  from_timestamp?: TimestampInput
  to_timestamp?: TimestampInput
  limit: number
  finalized_only: boolean
  event_names?: string[]
  include_extrinsic: boolean
  include_call: boolean
  include_stack: boolean
  response_format: 'full' | 'compact' | 'summary'
}

export type SubstrateCallRequest = {
  timeframe?: string
  from_timestamp?: TimestampInput
  to_timestamp?: TimestampInput
  limit: number
  finalized_only: boolean
  call_names?: string[]
  include_subcalls: boolean
  include_extrinsic: boolean
  include_stack: boolean
  include_events: boolean
  response_format: 'full' | 'compact' | 'summary'
}

type RecordLike = Record<string, unknown>

type SubstrateHeader = {
  number?: number
  hash?: string
  timestamp?: number
}

type SubstrateBlockRecord = {
  header?: SubstrateHeader
  extrinsics?: RecordLike[]
  calls?: RecordLike[]
  events?: RecordLike[]
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

function normalizeCallAddress(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined

  const parts = value
    .map((entry) => toNumber(entry))
    .filter((entry): entry is number => typeof entry === 'number')

  return parts.length === value.length ? parts : undefined
}

export function substrateCallAddressLabel(value: unknown): string | undefined {
  if (value === null) return undefined

  if (Array.isArray(value)) {
    const normalized = normalizeCallAddress(value)
    if (!normalized) return undefined
    return normalized.length === 0 ? 'root' : normalized.join('.')
  }

  if (typeof value === 'string') {
    return value.length === 0 ? 'root' : value
  }

  return undefined
}

function buildCallAddressKey(value: unknown): string | undefined {
  const normalized = normalizeCallAddress(value)
  if (!normalized) return undefined
  return normalized.join('.')
}

function isDescendantAddress(child: unknown, parent: unknown): boolean {
  const childParts = normalizeCallAddress(child)
  const parentParts = normalizeCallAddress(parent)
  if (!childParts || !parentParts) return false
  if (childParts.length <= parentParts.length) return false

  return parentParts.every((part, index) => childParts[index] === part)
}

function buildParentAddressKeys(value: unknown): string[] {
  const normalized = normalizeCallAddress(value)
  if (!normalized || normalized.length === 0) return []

  const keys: string[] = []
  for (let length = 0; length < normalized.length; length++) {
    keys.push(normalized.slice(0, length).join('.'))
  }
  return keys
}

function decorateSubstrateCall(call: RecordLike): RecordLike {
  return {
    ...call,
    ...(substrateCallAddressLabel(call.address) ? { call_address: substrateCallAddressLabel(call.address) } : {}),
  }
}

function decorateSubstrateEvent(event: RecordLike): RecordLike {
  return {
    ...event,
    ...(substrateCallAddressLabel(event.callAddress) ? { call_address: substrateCallAddressLabel(event.callAddress) } : {}),
  }
}

export function buildSubstrateWindowLabel(params: {
  timeframe?: string
  from_timestamp?: TimestampInput
  to_timestamp?: TimestampInput
  from_block: number
  to_block: number
  resolvedWindow: {
    range_kind: string
    from_lookup?: { normalized_input: string }
    to_lookup?: { normalized_input: string }
  }
}): string {
  const { timeframe, from_timestamp, to_timestamp, from_block, to_block, resolvedWindow } = params

  if (from_timestamp !== undefined || to_timestamp !== undefined) {
    const fromLabel = resolvedWindow.from_lookup?.normalized_input ?? (from_timestamp !== undefined ? String(from_timestamp) : 'start')
    const toLabel = resolvedWindow.to_lookup?.normalized_input ?? (to_timestamp !== undefined ? String(to_timestamp) : 'now')
    return `${fromLabel} -> ${toLabel}`
  }

  if (timeframe) {
    return timeframe
  }

  return `${from_block}-${to_block}`
}

export function flattenSubstrateEvents(
  blocks: unknown[],
  options: {
    include_extrinsic: boolean
    include_call: boolean
    include_stack: boolean
  },
): RecordLike[] {
  const rows: RecordLike[] = []

  for (const rawBlock of blocks) {
    const block = rawBlock as SubstrateBlockRecord
    const header = block.header ?? {}
    const blockNumber = header.number
    const blockHash = header.hash
    const timestamp = header.timestamp

    const extrinsicsByIndex = new Map<number, RecordLike>()
    for (const extrinsic of block.extrinsics ?? []) {
      const index = toNumber(extrinsic.index)
      if (index !== undefined) {
        extrinsicsByIndex.set(index, extrinsic)
      }
    }

    const callsByAddress = new Map<string, RecordLike>()
    for (const rawCall of block.calls ?? []) {
      const call = decorateSubstrateCall(rawCall)
      const addressKey = buildCallAddressKey(call.address)
      if (addressKey !== undefined) {
        callsByAddress.set(addressKey, call)
      }
    }

    for (const rawEvent of block.events ?? []) {
      const event = decorateSubstrateEvent(rawEvent)
      const extrinsicIndex = toNumber(event.extrinsicIndex)
      const callAddressKey = buildCallAddressKey(event.callAddress)

      rows.push({
        ...event,
        ...(blockNumber !== undefined ? { block_number: blockNumber } : {}),
        ...(blockHash ? { block_hash: blockHash } : {}),
        ...(timestamp !== undefined ? { timestamp } : {}),
        ...(options.include_extrinsic && extrinsicIndex !== undefined
          ? { extrinsic: extrinsicsByIndex.get(extrinsicIndex) }
          : {}),
        ...(options.include_call && callAddressKey !== undefined
          ? { call: callsByAddress.get(callAddressKey) }
          : {}),
        ...(options.include_stack && callAddressKey !== undefined
          ? {
              call_stack: buildParentAddressKeys(event.callAddress)
                .map((parentKey) => callsByAddress.get(parentKey))
                .filter((entry): entry is RecordLike => Boolean(entry)),
            }
          : {}),
      })
    }
  }

  return rows
}

export function flattenSubstrateCalls(
  blocks: unknown[],
  options: {
    include_subcalls: boolean
    include_extrinsic: boolean
    include_stack: boolean
    include_events: boolean
  },
): RecordLike[] {
  const rows: RecordLike[] = []

  for (const rawBlock of blocks) {
    const block = rawBlock as SubstrateBlockRecord
    const header = block.header ?? {}
    const blockNumber = header.number
    const blockHash = header.hash
    const timestamp = header.timestamp

    const extrinsicsByIndex = new Map<number, RecordLike>()
    for (const extrinsic of block.extrinsics ?? []) {
      const index = toNumber(extrinsic.index)
      if (index !== undefined) {
        extrinsicsByIndex.set(index, extrinsic)
      }
    }

    const decoratedCalls = (block.calls ?? []).map((call) => decorateSubstrateCall(call))
    const callsByAddress = new Map<string, RecordLike>()
    for (const call of decoratedCalls) {
      const addressKey = buildCallAddressKey(call.address)
      if (addressKey !== undefined) {
        callsByAddress.set(addressKey, call)
      }
    }

    const decoratedEvents = (block.events ?? []).map((event) => decorateSubstrateEvent(event))

    for (const call of decoratedCalls) {
      const extrinsicIndex = toNumber(call.extrinsicIndex)
      const callAddressKey = buildCallAddressKey(call.address)

      rows.push({
        ...call,
        ...(blockNumber !== undefined ? { block_number: blockNumber } : {}),
        ...(blockHash ? { block_hash: blockHash } : {}),
        ...(timestamp !== undefined ? { timestamp } : {}),
        ...(options.include_extrinsic && extrinsicIndex !== undefined
          ? { extrinsic: extrinsicsByIndex.get(extrinsicIndex) }
          : {}),
        ...(options.include_stack && callAddressKey !== undefined
          ? {
              call_stack: buildParentAddressKeys(call.address)
                .map((parentKey) => callsByAddress.get(parentKey))
                .filter((entry): entry is RecordLike => Boolean(entry)),
            }
          : {}),
        ...(options.include_subcalls
          ? {
              subcalls: decoratedCalls.filter((candidate) => isDescendantAddress(candidate.address, call.address)),
            }
          : {}),
        ...(options.include_events
          ? {
              events: decoratedEvents.filter((event) => buildCallAddressKey(event.callAddress) === callAddressKey),
            }
          : {}),
      })
    }
  }

  return rows
}

export function getSubstrateEventIndex(item: RecordLike): number {
  return toNumber(item.index) ?? toNumber(item.event_index) ?? 0
}

export function getSubstrateCallSortKey(item: RecordLike): string {
  const fromAlias = typeof item.call_address === 'string' ? item.call_address : undefined
  return fromAlias ?? substrateCallAddressLabel(item.address) ?? String(item.name ?? '')
}

