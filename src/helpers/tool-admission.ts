import {
  toolAdmissionActive,
  toolAdmissionActiveByFamily,
  toolAdmissionActiveWeight,
  toolAdmissionQueued,
  toolAdmissionRejectedTotal,
  toolAdmissionWait,
} from '../metrics.js'
import type { RuntimeRequestContext } from '../observability.js'
import { ActionableError, RequestCancelledError } from './errors.js'

export type ToolWorkClass = 'lookup' | 'raw_query' | 'summary' | 'analytics'

export type ToolWorkProfile = {
  class: ToolWorkClass
  weight: number
}

export type ToolAdmissionSnapshot = {
  activeWeight: number
  activeCalls: number
  queuedCalls: number
  maxWeight: number
  maxQueued: number
  maxClientWeight: number
  maxClientQueued: number
  activeCallsByFamily: Record<string, number>
}

/**
 * Who is asking. `key` is the connection identifier alone (a hashed address on
 * HTTP, the literal `stdio` on stdio); it is only ever a map key, never a
 * metric label or a log field. `family` is the bounded client family, used for
 * the metric label only: it is whatever the client calls itself, so keying a
 * share on it let one connection hold a share per name it declared.
 */
export type ToolCaller = {
  key: string
  family: string
  /** A caller that is the only possible caller (stdio) is counted but never share-limited. */
  exempt?: boolean
}

export type ToolAdmissionOptions = {
  /** Share of the global weight budget one caller may hold at once, 0 to 1. Default 0.5. */
  clientWeightShare?: number
  /** Queued calls one caller may hold. Default 16. */
  maxClientQueued?: number
}

type QueueEntry = {
  profile: ToolWorkProfile
  transport: RuntimeRequestContext['transport']
  caller?: ToolCaller
  enqueuedAt: number
  isResume?: boolean
  resolve: (value: ToolAdmissionLease) => void
  reject: (error: Error) => void
  signal?: AbortSignal
  timeoutId: ReturnType<typeof setTimeout>
  abort: () => void
}

export type ToolAdmissionLease = {
  waitMs: number
  /** Temporarily release weighted capacity while this call is sleeping on upstream backoff. */
  suspend: () => void
  /** Re-acquire weighted capacity before issuing the next upstream attempt. */
  resume: (signal?: AbortSignal) => Promise<void>
  release: () => void
}

const PROFILES: Record<ToolWorkClass, ToolWorkProfile> = {
  lookup: { class: 'lookup', weight: 1 },
  raw_query: { class: 'raw_query', weight: 12 },
  summary: { class: 'summary', weight: 8 },
  analytics: { class: 'analytics', weight: 16 },
}

const WALLET_PROFILE: ToolWorkProfile = { class: 'summary', weight: 16 }

const ANALYTICS = new Set([
  'portal_evm_get_analytics',
  'portal_solana_get_analytics',
  'portal_bitcoin_get_analytics',
  'portal_substrate_get_analytics',
  'portal_hyperliquid_get_analytics',
])

const SUMMARIES = new Set([
  'portal_get_recent_activity',
  'portal_get_wallet_summary',
  'portal_get_time_series',
  'portal_evm_get_contract_activity',
  'portal_evm_get_ohlc',
  'portal_hyperliquid_get_ohlc',
])

const LOOKUPS = new Set([
  'portal_list_networks',
  'portal_get_network_info',
  'portal_get_head',
  'portal_resolve_entity',
  'portal_debug_resolve_time_to_block',
])

export function getToolWorkProfile(toolName: string): ToolWorkProfile {
  if (toolName === 'portal_get_wallet_summary') return WALLET_PROFILE
  if (ANALYTICS.has(toolName)) return PROFILES.analytics
  if (SUMMARIES.has(toolName)) return PROFILES.summary
  if (LOOKUPS.has(toolName)) return PROFILES.lookup
  return PROFILES.raw_query
}

function boundedInteger(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(minimum, Math.min(maximum, Math.floor(parsed)))
}

function overloadError(
  reason: 'queue_full' | 'queue_timeout' | 'client_share',
  snapshot: ToolAdmissionSnapshot,
): ActionableError {
  const retryAfterMs = reason === 'queue_full' ? 500 : 250
  return new ActionableError(
    reason === 'client_share'
      ? 'SQD is busy with earlier requests from this client and could not start another one inside its fair share.'
      : 'SQD is busy and could not start this blockchain request inside its bounded wait budget.',
    [
      `Retry this request after ${retryAfterMs}ms`,
      reason === 'client_share'
        ? 'Wait for your earlier requests to finish before starting more'
        : 'Reduce the number of simultaneous analytics or wallet requests',
      'Use a smaller timeframe for expensive analysis',
    ],
    {
      reason,
      active_weight: snapshot.activeWeight,
      queued_calls: snapshot.queuedCalls,
      max_weight: snapshot.maxWeight,
      max_queued_calls: snapshot.maxQueued,
      ...(reason === 'client_share'
        ? { max_client_weight: snapshot.maxClientWeight, max_client_queued_calls: snapshot.maxClientQueued }
        : {}),
    },
    { code: 'overloaded', origin: 'server', retryable: true, retryAfterMs },
  )
}

export class WeightedToolAdmissionController {
  private activeWeight = 0
  private activeCalls = 0
  private readonly activeByKey = new Map<string, number>()
  private readonly queuedByKey = new Map<string, number>()
  private readonly activeWeightByCaller = new Map<string, number>()
  private readonly queuedByCaller = new Map<string, number>()
  private readonly activeCallsByFamily = new Map<string, number>()
  private readonly queue: QueueEntry[] = []
  readonly maxClientWeight: number
  readonly maxClientQueued: number

  constructor(
    readonly maxWeight: number,
    readonly maxQueued: number,
    readonly queueTimeoutMs: number,
    private readonly emitMetrics = true,
    options: ToolAdmissionOptions = {},
  ) {
    if (!Number.isInteger(maxWeight) || maxWeight < 1) throw new Error('maxWeight must be a positive integer')
    if (!Number.isInteger(maxQueued) || maxQueued < 0) throw new Error('maxQueued must be a non-negative integer')
    if (!Number.isFinite(queueTimeoutMs) || queueTimeoutMs < 1) throw new Error('queueTimeoutMs must be positive')
    const share = options.clientWeightShare ?? 0.5
    if (!Number.isFinite(share) || share <= 0 || share > 1) throw new Error('clientWeightShare must be in (0, 1]')
    // One caller never gets more than its share, but a share below the heaviest
    // single profile would make that profile unschedulable, so the floor is the
    // heaviest weight.
    const heaviest = Math.max(...Object.values(PROFILES).map((profile) => profile.weight), WALLET_PROFILE.weight)
    this.maxClientWeight = Math.min(maxWeight, Math.max(heaviest, Math.floor(maxWeight * share)))
    this.maxClientQueued = options.maxClientQueued ?? 16
    if (!Number.isInteger(this.maxClientQueued) || this.maxClientQueued < 0) {
      throw new Error('maxClientQueued must be a non-negative integer')
    }
    this.syncMetrics()
  }

  snapshot(): ToolAdmissionSnapshot {
    return {
      activeWeight: this.activeWeight,
      activeCalls: this.activeCalls,
      queuedCalls: this.queue.length,
      maxWeight: this.maxWeight,
      maxQueued: this.maxQueued,
      maxClientWeight: this.maxClientWeight,
      maxClientQueued: this.maxClientQueued,
      activeCallsByFamily: Object.fromEntries(this.activeCallsByFamily),
    }
  }

  async acquire(
    profile: ToolWorkProfile,
    transport: RuntimeRequestContext['transport'],
    signal?: AbortSignal,
    caller?: ToolCaller,
  ): Promise<ToolAdmissionLease> {
    if (profile.weight > this.maxWeight) throw new Error(`Tool weight ${profile.weight} exceeds the scheduler budget`)
    if (signal?.aborted) throw new RequestCancelledError()
    const now = Date.now()
    if (this.canGrant(profile.weight, caller) && this.queue.length === 0) {
      return this.grant(profile, transport, now, caller)
    }
    const freshQueued = this.queue.reduce((count, entry) => count + (entry.isResume ? 0 : 1), 0)
    if (freshQueued >= this.maxQueued) {
      this.rejectMetric(profile, transport, 'queue_full')
      throw overloadError('queue_full', this.snapshot())
    }
    if (caller && !caller.exempt && (this.queuedByCaller.get(caller.key) ?? 0) >= this.maxClientQueued) {
      // This caller already holds its fair share of the queue; others keep flowing.
      this.rejectMetric(profile, transport, 'client_share')
      throw overloadError('client_share', this.snapshot())
    }
    return new Promise<ToolAdmissionLease>((resolve, reject) => {
      const entry = {} as QueueEntry
      entry.profile = profile
      entry.transport = transport
      entry.caller = caller
      entry.enqueuedAt = now
      entry.resolve = resolve
      entry.reject = reject
      entry.signal = signal
      entry.abort = () => {
        if (!this.removeQueued(entry)) return
        reject(new RequestCancelledError())
        this.promote()
      }
      entry.timeoutId = setTimeout(() => {
        if (!this.removeQueued(entry)) return
        this.rejectMetric(profile, transport, 'queue_timeout')
        reject(overloadError('queue_timeout', this.snapshot()))
        this.promote()
      }, this.queueTimeoutMs)
      signal?.addEventListener('abort', entry.abort, { once: true })
      this.queue.push(entry)
      this.adjustMap(this.queuedByKey, this.key(profile, transport), 1)
      if (caller) this.adjustMap(this.queuedByCaller, caller.key, 1)
      this.syncMetrics(profile, transport)
      this.promote()
    })
  }

  private canGrant(weight: number, caller?: ToolCaller): boolean {
    if (this.activeWeight + weight > this.maxWeight) return false
    if (!caller || caller.exempt) return true
    return (this.activeWeightByCaller.get(caller.key) ?? 0) + weight <= this.maxClientWeight
  }

  private key(profile: ToolWorkProfile, transport: RuntimeRequestContext['transport']): string {
    return `${profile.class}:${transport}`
  }

  private adjustMap(map: Map<string, number>, key: string, delta: number) {
    const next = Math.max(0, (map.get(key) ?? 0) + delta)
    if (next === 0) map.delete(key)
    else map.set(key, next)
  }

  private removeQueued(entry: QueueEntry): boolean {
    const index = this.queue.indexOf(entry)
    if (index < 0) return false
    this.queue.splice(index, 1)
    clearTimeout(entry.timeoutId)
    entry.signal?.removeEventListener('abort', entry.abort)
    this.adjustMap(this.queuedByKey, this.key(entry.profile, entry.transport), -1)
    if (entry.caller && !entry.isResume) this.adjustMap(this.queuedByCaller, entry.caller.key, -1)
    this.syncMetrics(entry.profile, entry.transport)
    return true
  }

  private activateLease(profile: ToolWorkProfile, transport: RuntimeRequestContext['transport'], caller?: ToolCaller) {
    this.activeWeight += profile.weight
    this.activeCalls += 1
    this.adjustMap(this.activeByKey, this.key(profile, transport), 1)
    if (caller) {
      this.adjustMap(this.activeWeightByCaller, caller.key, profile.weight)
      this.adjustMap(this.activeCallsByFamily, caller.family, 1)
      if (this.emitMetrics) {
        toolAdmissionActiveByFamily.set(
          { client_family: caller.family },
          this.activeCallsByFamily.get(caller.family) ?? 0,
        )
      }
    }
    this.syncMetrics(profile, transport)
  }

  private deactivateLease(
    profile: ToolWorkProfile,
    transport: RuntimeRequestContext['transport'],
    caller?: ToolCaller,
  ) {
    this.activeWeight = Math.max(0, this.activeWeight - profile.weight)
    this.activeCalls = Math.max(0, this.activeCalls - 1)
    this.adjustMap(this.activeByKey, this.key(profile, transport), -1)
    if (caller) {
      this.adjustMap(this.activeWeightByCaller, caller.key, -profile.weight)
      this.adjustMap(this.activeCallsByFamily, caller.family, -1)
      if (this.emitMetrics) {
        toolAdmissionActiveByFamily.set(
          { client_family: caller.family },
          this.activeCallsByFamily.get(caller.family) ?? 0,
        )
      }
    }
    this.syncMetrics(profile, transport)
  }

  private grant(
    profile: ToolWorkProfile,
    transport: RuntimeRequestContext['transport'],
    enqueuedAt: number,
    caller?: ToolCaller,
  ): ToolAdmissionLease {
    const waitMs = Math.max(0, Date.now() - enqueuedAt)
    this.activateLease(profile, transport, caller)
    if (this.emitMetrics) toolAdmissionWait.observe({ tool_class: profile.class, transport }, waitMs / 1000)
    let released = false
    let suspended = false
    let pendingResume: { entry: QueueEntry; promise: Promise<void> } | undefined

    const cancelPendingResume = () => {
      if (!pendingResume) return
      const { entry } = pendingResume
      pendingResume = undefined
      if (this.removeQueued(entry)) {
        entry.reject(new RequestCancelledError())
        this.promote()
      }
    }

    const lease: ToolAdmissionLease = {
      waitMs,
      suspend: () => {
        if (released || suspended) return
        suspended = true
        this.deactivateLease(profile, transport, caller)
        this.promote()
      },
      resume: (signal?: AbortSignal) => {
        if (released || !suspended) return Promise.resolve()
        if (signal?.aborted) return Promise.reject(new RequestCancelledError())
        if (pendingResume) return pendingResume.promise

        if (this.canGrant(profile.weight, caller)) {
          suspended = false
          this.activateLease(profile, transport, caller)
          return Promise.resolve()
        }

        const resumeTimeoutMs = Math.max(this.queueTimeoutMs, 30_000)
        const entry = {} as QueueEntry
        const promise = new Promise<void>((resolve, reject) => {
          entry.profile = profile
          entry.transport = transport
          entry.caller = caller
          entry.enqueuedAt = Date.now()
          entry.isResume = true
          entry.signal = signal
          entry.resolve = () => {
            pendingResume = undefined
            if (released) {
              this.deactivateLease(profile, transport, caller)
              this.promote()
              resolve()
              return
            }
            suspended = false
            resolve()
          }
          entry.reject = (error: Error) => {
            pendingResume = undefined
            reject(error)
          }
          entry.abort = () => {
            if (!this.removeQueued(entry)) return
            pendingResume = undefined
            reject(new RequestCancelledError())
            this.promote()
          }
          entry.timeoutId = setTimeout(() => {
            if (!this.removeQueued(entry)) return
            pendingResume = undefined
            this.rejectMetric(profile, transport, 'queue_timeout')
            reject(overloadError('queue_timeout', this.snapshot()))
            this.promote()
          }, resumeTimeoutMs)

          signal?.addEventListener('abort', entry.abort, { once: true })
          /* Already-admitted calls resuming after backoff jump ahead of fresh
             requests so they finish instead of timing out behind new arrivals. */
          this.queue.unshift(entry)
          this.adjustMap(this.queuedByKey, this.key(profile, transport), 1)
          this.syncMetrics(profile, transport)
          this.promote()
        })

        if (suspended && this.queue.includes(entry)) {
          pendingResume = { entry, promise }
        }
        return promise
      },
      release: () => {
        if (released) return
        released = true
        cancelPendingResume()
        if (suspended) return
        this.deactivateLease(profile, transport, caller)
        this.promote()
      },
    }

    return lease
  }

  private promote() {
    let promoted = true
    while (promoted && this.queue.length > 0) {
      promoted = false
      const index = this.queue.findIndex((entry) => this.canGrant(entry.profile.weight, entry.caller))
      if (index < 0) break
      const entry = this.queue.splice(index, 1)[0]!
      clearTimeout(entry.timeoutId)
      entry.signal?.removeEventListener('abort', entry.abort)
      this.adjustMap(this.queuedByKey, this.key(entry.profile, entry.transport), -1)
      if (entry.caller && !entry.isResume) this.adjustMap(this.queuedByCaller, entry.caller.key, -1)
      this.syncMetrics(entry.profile, entry.transport)
      if (entry.signal?.aborted) {
        entry.reject(new RequestCancelledError())
        promoted = true
        continue
      }
      if (entry.isResume) {
        this.activateLease(entry.profile, entry.transport, entry.caller)
        if (this.emitMetrics) {
          toolAdmissionWait.observe(
            { tool_class: entry.profile.class, transport: entry.transport },
            Math.max(0, Date.now() - entry.enqueuedAt) / 1000,
          )
        }
        entry.resolve(undefined as unknown as ToolAdmissionLease)
      } else {
        entry.resolve(this.grant(entry.profile, entry.transport, entry.enqueuedAt, entry.caller))
      }
      promoted = true
    }
  }

  private rejectMetric(profile: ToolWorkProfile, transport: RuntimeRequestContext['transport'], reason: string) {
    if (this.emitMetrics) toolAdmissionRejectedTotal.inc({ tool_class: profile.class, transport, reason })
  }

  private syncMetrics(profile?: ToolWorkProfile, transport?: RuntimeRequestContext['transport']) {
    if (!this.emitMetrics) return
    toolAdmissionActiveWeight.set(this.activeWeight)
    const pairs =
      profile && transport
        ? [[profile, transport] as const]
        : Object.values(PROFILES).flatMap((candidate) =>
            (['stdio', 'http'] as const).map((candidateTransport) => [candidate, candidateTransport] as const),
          )
    for (const [candidate, candidateTransport] of pairs) {
      const key = this.key(candidate, candidateTransport)
      toolAdmissionActive.set(
        { tool_class: candidate.class, transport: candidateTransport },
        this.activeByKey.get(key) ?? 0,
      )
      toolAdmissionQueued.set(
        { tool_class: candidate.class, transport: candidateTransport },
        this.queuedByKey.get(key) ?? 0,
      )
    }
  }
}

export const DEFAULT_TOOL_WEIGHT_BUDGET = 32

export const toolAdmission = new WeightedToolAdmissionController(
  boundedInteger(process.env.MCP_TOOL_WEIGHT_BUDGET, DEFAULT_TOOL_WEIGHT_BUDGET, 16, 256),
  boundedInteger(process.env.MCP_TOOL_MAX_QUEUE, 64, 0, 1024),
  boundedInteger(process.env.MCP_TOOL_QUEUE_TIMEOUT_MS, 5_000, 50, 30_000),
  true,
  {
    clientWeightShare: boundedInteger(process.env.MCP_TOOL_CLIENT_WEIGHT_SHARE, 50, 1, 100) / 100,
    maxClientQueued: boundedInteger(process.env.MCP_TOOL_CLIENT_MAX_QUEUE, 16, 0, 1024),
  },
)
