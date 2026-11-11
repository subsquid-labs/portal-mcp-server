#!/usr/bin/env tsx

import { type Client, Client as McpClient } from '@modelcontextprotocol/client'
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/client/stdio'

export type ConnectedTestClient = {
  client: Client
  transport: StdioClientTransport
}

export type ToolCallResult = {
  result: any
  text: string
  data?: any
  structuredContent?: Record<string, any>
  dataSource?: 'structuredContent' | 'text'
  isError: boolean
  elapsedMs: number
  attempts: number
}

const RETRYABLE_PATTERNS = [
  /timeout/i,
  /timed out/i,
  /gateway timeout/i,
  /worker temporarily unavailable/i,
  /temporarily unavailable/i,
  /internal server error/i,
  /server error/i,
  /upstream/i,
  /portal server error/i,
  /rate limited/i,
  /bucket coverage was incomplete/i,
  /fetch failed/i,
  /failed to fetch/i,
  /socket hang up/i,
  /ECONNRESET/i,
  /ETIMEDOUT/i,
  /502/i,
  /503/i,
  /504/i,
  /429/i,
]

const BOUNDED_RETRYABLE_UPSTREAM_CODES = new Set([
  'incomplete_result',
  'upstream_reorg',
  'rate_limited',
  'upstream_unavailable',
  'upstream_timeout',
  'upstream_error',
])

export function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`)
  }
}

export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function isBoundedUpstreamToolError(result: ToolCallResult): boolean {
  if (!result.isError) return false

  const error = result.structuredContent?.error
  if (error && typeof error === 'object') {
    if (error.retryable !== true || typeof error.code !== 'string') return false
    if (error.origin === 'upstream' && BOUNDED_RETRYABLE_UPSTREAM_CODES.has(error.code)) return true
    if (error.origin === 'server' && error.code === 'overloaded') return true
    return false
  }

  return /Portal server error \((?:429|5\d\d)\)|rate limit|service is overloaded|Request timeout after \d+ms/i.test(
    result.text,
  )
}

export function getText(result: any): string {
  return result?.content?.map((entry: any) => entry?.text || '').join('\n') || ''
}

export function getStructuredContent(result: any): Record<string, any> | undefined {
  const structuredContent = result?.structuredContent
  return typeof structuredContent === 'object' && structuredContent !== null && !Array.isArray(structuredContent)
    ? structuredContent
    : undefined
}

export function getToolErrorCode(result: any): string | undefined {
  const error = getStructuredContent(result)?.error
  return error && typeof error === 'object' && typeof error.code === 'string' ? error.code : undefined
}

export function parseToolResultData(result: any): { data: any; source: 'structuredContent' | 'text' } {
  const structuredContent = getStructuredContent(result)
  if (structuredContent) {
    return { data: structuredContent, source: 'structuredContent' }
  }

  return { data: extractJson(getText(result)), source: 'text' }
}

export function extractJson(text: string): any {
  const jsonStart = text.search(/[\[{]/)
  if (jsonStart === -1) {
    throw new Error(`No JSON found in response: ${text.slice(0, 240)}`)
  }

  return JSON.parse(text.slice(jsonStart))
}

export function classifySpeed(elapsedMs: number): 'FAST' | 'OK' | 'SLOW' | 'VERY SLOW' {
  if (elapsedMs < 1000) return 'FAST'
  if (elapsedMs < 3000) return 'OK'
  if (elapsedMs < 10000) return 'SLOW'
  return 'VERY SLOW'
}

export function hasLegacyWording(text: string): boolean {
  return /\bdataset\b|\bchain_type\b/i.test(text)
}

export function isFriendlyDisplayTitle(title: unknown): boolean {
  return typeof title === 'string' && title.length > 0 && !title.includes('portal_')
}

function assertRecord(value: unknown, label: string): asserts value is Record<string, any> {
  assert(typeof value === 'object' && value !== null && !Array.isArray(value), `${label} should be an object`)
}

function assertNonEmptyString(value: unknown, label: string) {
  assert(typeof value === 'string' && value.trim().length > 0, `${label} should be a non-empty string`)
}

function assertStringArray(value: unknown, label: string, options?: { nonEmpty?: boolean }) {
  assert(Array.isArray(value), `${label} should be an array`)
  if (options?.nonEmpty) {
    assert(value.length > 0, `${label} should not be empty`)
  }
  assert(
    value.every((item) => typeof item === 'string' && item.length > 0),
    `${label} should contain only non-empty strings`,
  )
}

function assertSafeExecutableArguments(value: unknown, label: string) {
  assertRecord(value, label)
  const text = JSON.stringify(value)
  assert(!/\bhttps?:\/\//i.test(text), `${label} should not contain raw URLs`)
  assert(
    !/"[^"]*(secret|token|api[_-]?key|authorization|password|cookie|url)[^"]*"\s*:/i.test(text),
    `${label} should not expose secret-like argument keys`,
  )
}

function assertFollowUpActions(value: unknown, label: string, options?: { requireExecutableArguments?: boolean }) {
  assert(Array.isArray(value), `${label} should be an array`)
  assert(value.length <= 6, `${label} should include at most 6 actions`)

  value.forEach((action, index) => {
    assertRecord(action, `${label}[${index}]`)
    assertNonEmptyString(action.label, `${label}[${index}].label`)
    assert(typeof action.executable === 'boolean', `${label}[${index}].executable should be boolean`)

    if (action.executable) {
      assertNonEmptyString(action.tool, `${label}[${index}].tool`)
      if (options?.requireExecutableArguments ?? true) {
        assertSafeExecutableArguments(action.arguments, `${label}[${index}].arguments`)
      } else if (action.arguments !== undefined) {
        assertSafeExecutableArguments(action.arguments, `${label}[${index}].arguments`)
      }
      if (action.cursor_path !== undefined) {
        assertNonEmptyString(action.cursor_path, `${label}[${index}].cursor_path`)
      }
    } else {
      assert(action.tool === undefined, `${label}[${index}] should omit tool when not executable`)
      assert(action.arguments === undefined, `${label}[${index}] should omit arguments when not executable`)
    }
  })
}

export function assertChatSurface(parsed: any, label: string, options?: { expectNextSteps?: boolean }) {
  const requiredTopLevelKeys = [
    'answer',
    'display',
    'next_steps',
    'investigation',
    '_llm',
    '_freshness',
    '_pagination',
    '_coverage',
    '_ordering',
    '_tool_contract',
    '_execution',
    '_evidence',
  ]

  assertRecord(parsed, `${label} response`)
  for (const key of requiredTopLevelKeys) {
    assert(Object.prototype.hasOwnProperty.call(parsed, key), `${label} should include ${key}`)
  }

  assertNonEmptyString(parsed.answer, `${label} answer`)
  assertRecord(parsed.display, `${label} display`)
  assertRecord(parsed.next_steps, `${label} next_steps`)
  assertFollowUpActions(parsed.next_steps.actions, `${label} next_steps.actions`)
  assert(isFriendlyDisplayTitle(parsed?.display?.title), `${label} display.title should be product-friendly`)
  assert(!hasLegacyWording(JSON.stringify(parsed?.display ?? {})), `${label} display should avoid legacy wording`)
  assert(!hasLegacyWording(String(parsed?.answer ?? '')), `${label} answer should avoid legacy wording`)

  assertRecord(parsed._tool_contract, `${label} _tool_contract`)
  assertNonEmptyString(parsed._tool_contract.name, `${label} _tool_contract.name`)
  assertNonEmptyString(parsed._tool_contract.intent, `${label} _tool_contract.intent`)
  assert(Array.isArray(parsed._tool_contract.vm), `${label} _tool_contract.vm should be an array`)

  assertRecord(parsed._freshness, `${label} _freshness`)
  assertNonEmptyString(parsed._freshness.kind, `${label} _freshness.kind`)
  assertRecord(parsed._pagination, `${label} _pagination`)
  if (parsed._pagination.has_more !== undefined) {
    assert(typeof parsed._pagination.has_more === 'boolean', `${label} _pagination.has_more should be boolean`)
  }
  if (parsed._pagination.has_more === true) {
    assertNonEmptyString(parsed._pagination.next_cursor, `${label} _pagination.next_cursor`)
  }
  if (parsed._pagination.next_cursor !== undefined) {
    assert(
      parsed._pagination.has_more === true,
      `${label} should set _pagination.has_more when it returns a continuation cursor`,
    )
  }
  assertRecord(parsed._coverage, `${label} _coverage`)
  assertNonEmptyString(parsed._coverage.kind, `${label} _coverage.kind`)
  if (parsed._coverage.window_complete !== undefined) {
    assert(
      typeof parsed._coverage.window_complete === 'boolean',
      `${label} _coverage.window_complete should be boolean`,
    )
  }
  if (parsed._coverage.result_complete !== undefined) {
    assert(
      typeof parsed._coverage.result_complete === 'boolean',
      `${label} _coverage.result_complete should be boolean`,
    )
  }
  if (parsed._coverage.continuation === 'cursor') {
    assert(
      parsed._pagination.has_more === true && typeof parsed._pagination.next_cursor === 'string',
      `${label} should return the cursor promised by _coverage.continuation`,
    )
  }
  if (parsed._pagination.continuation_scope === 'remaining_results') {
    assert(
      parsed._coverage.result_complete === false,
      `${label} should mark a result incomplete while remaining results are available`,
    )
  }
  assertRecord(parsed._ordering, `${label} _ordering`)
  assertNonEmptyString(parsed._ordering.kind, `${label} _ordering.kind`)
  assertRecord(parsed._execution, `${label} _execution`)
  assert(
    parsed._execution.kind !== undefined ||
      parsed._execution.range_kind !== undefined ||
      parsed._execution.scan_window !== undefined ||
      parsed._execution.timestamp !== undefined ||
      parsed._execution.resolution !== undefined,
    `${label} _execution should describe either its query window or why execution metadata is not applicable`,
  )

  assertRecord(parsed._evidence, `${label} _evidence`)
  assert(parsed._evidence.version === 'sqd_evidence_v1', `${label} _evidence.version should be sqd_evidence_v1`)
  assert(parsed._evidence.tool === parsed._tool_contract.name, `${label} evidence tool should match the tool contract`)
  assertRecord(parsed._evidence.source, `${label} _evidence.source`)
  assert(
    parsed._evidence.source.provider === 'SQD Portal',
    `${label} should identify SQD Portal as the evidence source`,
  )
  assertRecord(parsed._evidence.request, `${label} _evidence.request`)
  assertRecord(parsed._evidence.request.arguments, `${label} _evidence.request.arguments`)
  assertNonEmptyString(parsed._evidence.request.arguments_sha256, `${label} arguments digest`)
  assertRecord(parsed._evidence.result, `${label} _evidence.result`)
  assertNonEmptyString(parsed._evidence.result.exact_data_sha256, `${label} exact-data digest`)
  assert(
    ['complete', 'partial', 'unknown'].includes(parsed._evidence.result.completeness),
    `${label} should classify evidence completeness`,
  )
  assertRecord(parsed._evidence.replay, `${label} _evidence.replay`)
  assert(
    parsed._evidence.replay.arguments_path === '_evidence.request.arguments',
    `${label} replay should point to canonical arguments without duplicating them`,
  )

  assertRecord(parsed.investigation, `${label} investigation`)
  assert(parsed.investigation.version === 'portal_investigation_v1', `${label} should include investigation guide`)
  assertNonEmptyString(parsed.investigation.status, `${label} investigation.status`)
  assertRecord(parsed.investigation.evidence, `${label} investigation.evidence`)
  assertNonEmptyString(
    parsed.investigation.evidence.primary_path,
    `${label} investigation guide should point to the primary evidence path`,
  )
  assert(Array.isArray(parsed.investigation.pivots), `${label} investigation.pivots should be an array`)
  assert(
    Array.isArray(parsed.investigation.follow_up_filters),
    `${label} investigation guide should expose follow-up filters`,
  )
  assert(Array.isArray(parsed.investigation.limitations), `${label} investigation.limitations should be an array`)

  assertRecord(parsed._llm, `${label} _llm`)
  assert(parsed._llm.version === 'portal_llm_v1', `${label} _llm.version should be portal_llm_v1`)
  assertNonEmptyString(parsed._llm.primary_path, `${label} _llm.primary_path`)
  assertNonEmptyString(parsed._llm.primary_kind, `${label} _llm.primary_kind`)
  assertStringArray(parsed._llm.answer_sequence, `${label} _llm.answer_sequence`, { nonEmpty: true })
  assert(Array.isArray(parsed._llm.sections), `${label} _llm.sections should be an array`)
  assert(Array.isArray(parsed._llm.recommended_views), `${label} _llm.recommended_views should be an array`)
  if (parsed._llm.follow_up?.actions !== undefined) {
    assertFollowUpActions(parsed._llm.follow_up.actions, `${label} _llm.follow_up.actions`, {
      requireExecutableArguments: false,
    })
  }

  if (options?.expectNextSteps) {
    assert(
      Array.isArray(parsed?.next_steps?.actions) && parsed.next_steps.actions.length > 0,
      `${label} should include actionable next_steps`,
    )
  }
}

export function assertErrorQuality(text: string, label: string) {
  assert(text.length > 0, `${label} error should not be empty`)
  assert(!/TypeError|ReferenceError|SyntaxError|at .*:\d+:\d+/i.test(text), `${label} should not leak stack traces`)
  assert(
    /Suggestions:|supported|required|Unknown network|does not support network|Invalid|cannot be used together/i.test(
      text,
    ),
    `${label} should explain the problem clearly`,
  )
}

export async function connectTestClient(
  name: string,
  options?: { cwd?: string; env?: Record<string, string> },
): Promise<ConnectedTestClient> {
  const transport = new StdioClientTransport({
    command: 'node',
    args: ['dist/index.js'],
    ...(options?.cwd ? { cwd: options.cwd } : {}),
    ...(options?.env ? { env: { ...getDefaultEnvironment(), ...options.env } } : {}),
  })

  const client = new McpClient({ name, version: '1.0.0' })
  await client.connect(transport)
  return { client, transport }
}

export async function closeTestClient(connected: ConnectedTestClient | undefined) {
  if (!connected) return
  await connected.client.close()
}

function isRetryableError(text: string): boolean {
  return RETRYABLE_PATTERNS.some((pattern) => pattern.test(text))
}

export async function callToolWithRetry(
  client: Client,
  name: string,
  args: Record<string, unknown>,
  options?: {
    retries?: number
    retryDelayMs?: number
    parseJson?: boolean
    requestTimeoutMs?: number
    totalBudgetMs?: number
  },
): Promise<ToolCallResult> {
  const retries = options?.retries ?? 3
  const retryDelayMs = options?.retryDelayMs ?? 2_000
  const requestTimeoutMs = options?.requestTimeoutMs ?? 45_000
  const totalBudgetMs = options?.totalBudgetMs ?? 90_000
  const budgetStartedAt = Date.now()

  let lastError: Error | undefined

  for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
    const remainingBudgetMs = totalBudgetMs - (Date.now() - budgetStartedAt)
    if (remainingBudgetMs <= 0) {
      throw lastError ?? new Error(`Tool call exceeded the ${totalBudgetMs}ms test budget for ${name}`)
    }
    const start = Date.now()

    try {
      const result = await client.callTool(
        { name, arguments: args },
        { timeout: Math.max(1, Math.min(requestTimeoutMs, remainingBudgetMs)) },
      )
      const text = getText(result)
      const structuredContent = getStructuredContent(result)
      const structuredError = structuredContent?.error
      const isError = Boolean((result as any).isError) || text.startsWith('Error:')
      const elapsedMs = Date.now() - start

      if (
        isError &&
        attempt <= retries &&
        (isRetryableError(text) ||
          (structuredError && typeof structuredError === 'object' && structuredError.retryable === true))
      ) {
        const declaredRetryAfterMs =
          structuredError && typeof structuredError === 'object' && typeof structuredError.retry_after_ms === 'number'
            ? structuredError.retry_after_ms
            : 0
        const retryDelay = Math.max(retryDelayMs * attempt, declaredRetryAfterMs)
        if (Date.now() - budgetStartedAt + retryDelay >= totalBudgetMs)
          return {
            result,
            text,
            structuredContent,
            isError,
            elapsedMs,
            attempts: attempt,
          }
        await sleep(retryDelay)
        continue
      }

      const parsedData = !isError && options?.parseJson !== false ? parseToolResultData(result) : undefined

      return {
        result,
        text,
        data: parsedData?.data,
        structuredContent,
        dataSource: parsedData?.source,
        isError,
        elapsedMs,
        attempts: attempt,
      }
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))

      if (attempt <= retries && isRetryableError(lastError.message)) {
        const retryDelay = retryDelayMs * attempt
        if (Date.now() - budgetStartedAt + retryDelay >= totalBudgetMs) throw lastError
        await sleep(retryDelay)
        continue
      }

      throw lastError
    }
  }

  throw lastError ?? new Error(`Tool call failed for ${name}`)
}

export function printSection(title: string) {
  console.log(`\n${'='.repeat(72)}`)
  console.log(title)
  console.log(`${'='.repeat(72)}`)
}

export function truncateText(text: string, maxLines = 40): string {
  const lines = text.split('\n')
  if (lines.length <= maxLines) return text
  return `${lines.slice(0, maxLines).join('\n')}\n... (${lines.length - maxLines} more lines)`
}
