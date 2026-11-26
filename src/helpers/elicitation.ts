import {
  CLIENT_CAPABILITIES_META_KEY,
  type ClientCapabilities,
  type InputRequiredResult,
  type ServerContext,
  acceptedContent,
  inputRequired,
  inputResponse,
} from '@modelcontextprotocol/server'
import type { z } from 'zod'

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

/**
 * Determine whether the caller advertises MCP form-mode elicitation support.
 * Handles both 2026-07-28 per-request capability envelopes and 2025 initialize
 * capabilities, following the spec rule that `elicitation: {}` or
 * `elicitation: { form: ... }` both indicate form elicitation support.
 */
export function supportsFormElicitation(
  context: ServerContext | undefined,
  fallbackCapabilities?: ClientCapabilities | unknown,
): boolean {
  const envelope = asRecord(context?.mcpReq?.envelope)
  const fromEnvelope = asRecord(envelope?.[CLIENT_CAPABILITIES_META_KEY])
  const capabilities = fromEnvelope ?? asRecord(fallbackCapabilities)
  if (!capabilities) return false
  const elicitation = asRecord(capabilities.elicitation)
  if (!elicitation) return false
  if ('form' in elicitation) {
    return Boolean(elicitation.form)
  }
  // Pre-mode rule: `elicitation: {}` (without explicit url-only key) supports form mode.
  return !('url' in elicitation) || Object.keys(elicitation).length === 0
}

export type FormElicitationOutcome<T> =
  | { state: 'missing' }
  | { state: 'accepted'; value: T }
  | { state: 'declined' }
  | { state: 'cancelled' }

/**
 * Read and validate an embedded form-mode elicitation response from a
 * multi-round-trip retry.
 */
export function readFormElicitationOutcome<S extends z.ZodTypeAny>(
  context: ServerContext | undefined,
  key: string,
  schema: S,
): FormElicitationOutcome<z.infer<S>> {
  const responses = context?.mcpReq?.inputResponses
  const view = inputResponse(responses, key)
  if (view.kind !== 'elicit') return { state: 'missing' }
  if (view.action === 'decline') return { state: 'declined' }
  if (view.action === 'cancel') return { state: 'cancelled' }
  const validated = acceptedContent(responses, key, schema)
  if (validated === undefined) return { state: 'missing' }
  return { state: 'accepted', value: validated as z.infer<S> }
}

/**
 * Build a multi-round-trip `inputRequired` form elicitation result.
 * Works natively on 2026-07-28 and automatically via the SDK's legacy shim on 2025.
 */
export function buildFormElicitationResult(
  key: string,
  message: string,
  requestedSchema: z.ZodObject<z.ZodRawShape>,
): InputRequiredResult {
  return inputRequired({
    inputRequests: {
      [key]: inputRequired.elicit({
        message,
        requestedSchema,
      }),
    },
  })
}
