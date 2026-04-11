#!/usr/bin/env tsx

import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

export type ConnectedTestClient = {
  client: Client
  transport: StdioClientTransport
}

export type ToolCallResult = {
  result: any
  text: string
  data?: any
  isError: boolean
  elapsedMs: number
  attempts: number
}

const RETRYABLE_PATTERNS = [
  /timeout/i,
  /timed out/i,
  /gateway timeout/i,
  /worker temporarily unavailable/i,
  /portal server error/i,
  /rate limited/i,
  /fetch failed/i,
  /socket hang up/i,
  /ECONNRESET/i,
  /ETIMEDOUT/i,
  /502/i,
  /503/i,
  /504/i,
  /429/i,
]

export function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`)
  }
}

export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function getText(result: any): string {
  return result?.content?.map((entry: any) => entry?.text || '').join('\n') || ''
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

export function assertChatSurface(parsed: any, label: string, options?: { expectNextSteps?: boolean }) {
  assert(typeof parsed?.answer === 'string' && parsed.answer.length > 0, `${label} should include answer`)
  assert(parsed?.display !== undefined, `${label} should include display`)
  assert(isFriendlyDisplayTitle(parsed?.display?.title), `${label} display.title should be product-friendly`)
  assert(!hasLegacyWording(JSON.stringify(parsed?.display ?? {})), `${label} display should avoid legacy wording`)
  assert(!hasLegacyWording(String(parsed?.answer ?? '')), `${label} answer should avoid legacy wording`)

  if (options?.expectNextSteps) {
    assert(parsed?.next_steps !== undefined, `${label} should include next_steps`)
  }
}

export function assertErrorQuality(text: string, label: string) {
  assert(text.length > 0, `${label} error should not be empty`)
  assert(!/TypeError|ReferenceError|SyntaxError|at .*:\d+:\d+/i.test(text), `${label} should not leak stack traces`)
  assert(
    /Suggestions:|supported|required|Unknown network|does not support network|Invalid|cannot be used together/i.test(text),
    `${label} should explain the problem clearly`,
  )
}

export async function connectTestClient(name: string): Promise<ConnectedTestClient> {
  const transport = new StdioClientTransport({
    command: 'node',
    args: ['dist/index.js'],
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
  },
): Promise<ToolCallResult> {
  const retries = options?.retries ?? 3
  const retryDelayMs = options?.retryDelayMs ?? 800

  let lastError: Error | undefined

  for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
    const start = Date.now()

    try {
      const result = await client.callTool({ name, arguments: args })
      const text = getText(result)
      const isError = Boolean((result as any).isError) || text.startsWith('Error:')
      const elapsedMs = Date.now() - start

      if (isError && attempt <= retries && isRetryableError(text)) {
        await sleep(retryDelayMs * attempt)
        continue
      }

      const data = !isError && options?.parseJson !== false ? extractJson(text) : undefined

      return {
        result,
        text,
        data,
        isError,
        elapsedMs,
        attempts: attempt,
      }
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))

      if (attempt <= retries && isRetryableError(lastError.message)) {
        await sleep(retryDelayMs * attempt)
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
