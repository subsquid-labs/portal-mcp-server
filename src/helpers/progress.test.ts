import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { ServerContext } from '@modelcontextprotocol/server'

import { hasPortalProgressReporter, reportPortalProgress, runWithPortalProgress } from './progress.js'

function mockContext(token: string | number | undefined, sent: unknown[], signal?: AbortSignal): ServerContext {
  return {
    mcpReq: {
      _meta: token !== undefined ? { progressToken: token } : undefined,
      signal: signal ?? new AbortController().signal,
      notify: async (notification: unknown) => {
        sent.push(notification)
      },
    },
  } as unknown as ServerContext
}

describe('notifications/progress helper', () => {
  it('is a no-op when the caller omits progressToken', async () => {
    const sent: unknown[] = []
    await runWithPortalProgress(mockContext(undefined, sent), async () => {
      assert.equal(hasPortalProgressReporter(), false)
      reportPortalProgress({ progress: 1, total: 10, message: 'ignored' })
    })
    assert.equal(sent.length, 0)
  })

  it('emits throttled progress notifications and always emits phase transitions and completion', async () => {
    const sent: Array<{ method: string; params: Record<string, unknown> }> = []
    await runWithPortalProgress(
      mockContext('tok-1', sent),
      async () => {
        assert.equal(hasPortalProgressReporter(), true)
        reportPortalProgress({ phase: 'resolve_window', progress: 0, message: 'Resolving window' })
        // Within throttle window on same phase -> suppressed
        reportPortalProgress({ phase: 'resolve_window', progress: 1, message: 'Suppressed' })
        // New phase -> emitted immediately
        reportPortalProgress({ phase: 'scan', progress: 50, total: 100, message: 'Halfway' })
        // Completion -> emitted immediately
        reportPortalProgress({ phase: 'scan', progress: 100, total: 100, message: 'Done' })
      },
      { minIntervalMs: 60_000 },
    )
    assert.equal(sent.length, 3)
    assert.equal(sent[0]?.method, 'notifications/progress')
    assert.equal(sent[0]?.params.progressToken, 'tok-1')
    assert.equal(sent[1]?.params.progress, 50)
    assert.equal(sent[2]?.params.progress, 100)
  })
})
