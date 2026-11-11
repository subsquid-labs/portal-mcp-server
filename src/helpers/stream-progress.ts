import { ActionableError } from './errors.js'

const MAX_STREAM_RECOVERY_ATTEMPTS = 8
const MAX_STREAM_RECOVERY_WINDOW_MS = 30_000

type StreamFailureReason = 'response_too_large' | 'upstream_timeout' | 'upstream_error' | 'visitor_error'

/** Limit recovery work across every subrange of one scan. */
export class StreamRecoveryBudget {
  private attempts = 0
  private startedAt?: number

  take(): boolean {
    const now = Date.now()
    this.startedAt ??= now
    if (this.attempts >= MAX_STREAM_RECOVERY_ATTEMPTS || now - this.startedAt >= MAX_STREAM_RECOVERY_WINDOW_MS)
      return false
    this.attempts++
    return true
  }
}

/** Tracks completed callbacks separately from callbacks that may have failed halfway. */
export class StreamDelivery {
  deliveredRecords = 0
  visitorFailed = false
  firstBlock?: number
  lastBlock?: number
  private ordered = true

  async deliver(
    record: unknown,
    visitor: (record: unknown) => void | Promise<void>,
    getBlockNumber: (record: unknown) => number | undefined,
  ): Promise<void> {
    const block = getBlockNumber(record)
    this.deliveredRecords++
    try {
      await visitor(record)
    } catch (error) {
      this.visitorFailed = true
      throw error
    }
    if (
      block === undefined ||
      !Number.isSafeInteger(block) ||
      block < 0 ||
      (this.lastBlock !== undefined && block <= this.lastBlock)
    ) {
      this.ordered = false
    }
    this.firstBlock ??= block
    this.lastBlock = block
  }

  get checkpoint(): { first?: number; last?: number } {
    return this.ordered && !this.visitorFailed ? { first: this.firstBlock, last: this.lastBlock } : {}
  }
}

/** Raw causes stay available to code; only bounded metadata reaches tool output. */
export class PortalStreamError extends ActionableError {
  readonly reason: StreamFailureReason
  readonly deliveredRecords: number
  readonly firstDeliveredBlock?: number
  readonly lastDeliveredBlock?: number
  override readonly cause: unknown

  constructor(cause: unknown, delivery: StreamDelivery) {
    const reason: StreamFailureReason = delivery.visitorFailed
      ? 'visitor_error'
      : cause instanceof PortalStreamError
        ? cause.reason
        : cause instanceof ActionableError && (cause.code === 'response_too_large' || cause.code === 'upstream_timeout')
          ? cause.code
          : 'upstream_error'
    const checkpoint = delivery.checkpoint
    super(
      'Portal stream is incomplete after delivering records.',
      [
        'Discard accumulated results unless the scan can resume after its last completed block',
        'Retry with a narrower timeframe or block range',
      ],
      { reason, delivered_records: delivery.deliveredRecords, last_delivered_block: checkpoint.last },
      {
        code: 'incomplete_result',
        origin: reason === 'visitor_error' ? 'server' : cause instanceof ActionableError ? cause.origin : 'upstream',
        retryable: false,
      },
    )
    this.name = 'PortalStreamError'
    this.reason = reason
    this.deliveredRecords = delivery.deliveredRecords
    this.firstDeliveredBlock = checkpoint.first
    this.lastDeliveredBlock = checkpoint.last
    this.cause = cause instanceof PortalStreamError ? cause.cause : cause
  }
}

/** A fresh subrange is safe only after completed, strictly increasing block records. */
export function getStreamRangeRecovery(
  error: unknown,
  fromBlock: number,
  toBlock: number,
  options: { budget: StreamRecoveryBudget; allowTimeout?: boolean; discardDelivered?: boolean },
): { fromBlock: number; deliveredRecords: number } | undefined {
  const reason =
    error instanceof PortalStreamError ? error.reason : error instanceof ActionableError ? error.code : undefined
  if (reason !== 'response_too_large' && !(options.allowTimeout && reason === 'upstream_timeout')) return undefined
  if (!(error instanceof PortalStreamError) || options.discardDelivered) {
    return options.budget.take() ? { fromBlock, deliveredRecords: 0 } : undefined
  }
  if (
    error.firstDeliveredBlock === undefined ||
    error.firstDeliveredBlock < fromBlock ||
    error.lastDeliveredBlock === undefined ||
    error.lastDeliveredBlock > toBlock
  )
    return undefined
  return options.budget.take()
    ? { fromBlock: error.lastDeliveredBlock + 1, deliveredRecords: error.deliveredRecords }
    : undefined
}
