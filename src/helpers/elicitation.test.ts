import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { CLIENT_CAPABILITIES_META_KEY, type ServerContext } from '@modelcontextprotocol/server'
import { z } from 'zod'

import { buildFormElicitationResult, readFormElicitationOutcome, supportsFormElicitation } from './elicitation.js'

describe('MCP form elicitation helper', () => {
  it('detects form elicitation capability across 2026 envelope and 2025 initialize shapes', () => {
    const modernCtx = {
      mcpReq: {
        envelope: {
          [CLIENT_CAPABILITIES_META_KEY]: { elicitation: { form: {} } },
        },
      },
    } as unknown as ServerContext
    assert.equal(supportsFormElicitation(modernCtx), true)
    assert.equal(supportsFormElicitation(undefined, { elicitation: {} }), true)
    assert.equal(supportsFormElicitation(undefined, { elicitation: { url: {} } }), false)
    assert.equal(supportsFormElicitation(undefined, { elicitation: { futureMode: {} } }), false)
    assert.equal(supportsFormElicitation(undefined, {}), false)

    // When a 2026 per-request envelope is present, it is authoritative and must not fall back.
    const envelopeWithoutElicitation = {
      mcpReq: {
        envelope: {
          [CLIENT_CAPABILITIES_META_KEY]: {},
        },
      },
    } as unknown as ServerContext
    assert.equal(supportsFormElicitation(envelopeWithoutElicitation, { elicitation: { form: {} } }), false)
  })

  it('builds inputRequired form requests and parses accepted/declined/cancelled/invalid outcomes', () => {
    const schema = z.object({ duration: z.enum(['30m', '15m']) })
    const result = buildFormElicitationResult('series_duration', 'Pick a duration', schema)
    assert.equal(result.resultType, 'input_required')
    assert.ok(result.inputRequests?.series_duration)

    const acceptedCtx = {
      mcpReq: {
        inputResponses: {
          series_duration: { action: 'accept', content: { duration: '30m' } },
        },
      },
    } as unknown as ServerContext
    const accepted = readFormElicitationOutcome(acceptedCtx, 'series_duration', schema)
    assert.deepEqual(accepted, { state: 'accepted', value: { duration: '30m' } })

    const declinedCtx = {
      mcpReq: {
        inputResponses: {
          series_duration: { action: 'decline' },
        },
      },
    } as unknown as ServerContext
    assert.deepEqual(readFormElicitationOutcome(declinedCtx, 'series_duration', schema), { state: 'declined' })

    const cancelledCtx = {
      mcpReq: {
        inputResponses: {
          series_duration: { action: 'cancel' },
        },
      },
    } as unknown as ServerContext
    assert.deepEqual(readFormElicitationOutcome(cancelledCtx, 'series_duration', schema), { state: 'cancelled' })

    const invalidCtx = {
      mcpReq: {
        inputResponses: {
          series_duration: { action: 'accept', content: { duration: '999d' } },
        },
      },
    } as unknown as ServerContext
    assert.deepEqual(readFormElicitationOutcome(invalidCtx, 'series_duration', schema), { state: 'invalid' })
  })
})
