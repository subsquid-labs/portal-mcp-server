#!/usr/bin/env tsx

import { TOOL_SPECS, loadToolTestContext } from './tool-manifest.ts'
import {
  assert,
  assertChatSurface,
  callToolWithRetry,
  classifySpeed,
  closeTestClient,
  connectTestClient,
  hasLegacyWording,
  printSection,
  truncateText,
} from './test-helpers.ts'

type QualityWarning = {
  tool: string
  message: string
}

const HARD_LATENCY_BUDGET_MS: Record<string, number> = {
  discover: 4_000,
  lookup: 4_000,
  query: 10_000,
  summary: 12_000,
  analytics: 12_000,
  chart: 12_000,
  debug: 12_000,
}

const SOFT_LATENCY_BUDGET_MS: Record<string, number> = {
  discover: 1_500,
  lookup: 1_500,
  query: 4_000,
  summary: 5_000,
  analytics: 6_000,
  chart: 6_000,
  debug: 6_000,
}

function getIntent(data: any): string {
  return typeof data?._tool_contract?.intent === 'string' ? data._tool_contract.intent : 'query'
}

function getHardLatencyBudget(intent: string) {
  return HARD_LATENCY_BUDGET_MS[intent] ?? 10_000
}

function getSoftLatencyBudget(intent: string) {
  return SOFT_LATENCY_BUDGET_MS[intent] ?? 5_000
}

function getResponseSizeBudget(data: any) {
  const intent = getIntent(data)
  return intent === 'query' || intent === 'debug' ? 90_000 : 45_000
}

function hasExplicitResponseFormat(args: Record<string, unknown>) {
  return Object.prototype.hasOwnProperty.call(args, 'response_format')
}

async function main() {
  const connected = await connectTestClient('quality-test')
  const { client } = connected

  try {
    const context = await loadToolTestContext(client)
    const warnings: QualityWarning[] = []
    const failures: QualityWarning[] = []

    printSection(`Quality audit for ${TOOL_SPECS.length} tools`)

    for (const spec of TOOL_SPECS) {
      try {
        const args = spec.args(context)
        let result = await callToolWithRetry(client, spec.name, args)
        assert(!result.isError, `${spec.name} should succeed in the quality audit`)

        const intent = getIntent(result.data)
        const hardLatencyBudget = getHardLatencyBudget(intent)
        const softLatencyBudget = getSoftLatencyBudget(intent)
        let recoveredFromLatencySpike = false
        let originalSlowElapsedMs: number | undefined

        if (result.elapsedMs > hardLatencyBudget) {
          const retryResult = await callToolWithRetry(client, spec.name, args)
          if (!retryResult.isError) {
            originalSlowElapsedMs = result.elapsedMs
            result = retryResult.elapsedMs <= result.elapsedMs ? retryResult : result
            recoveredFromLatencySpike = retryResult.elapsedMs <= hardLatencyBudget
          }
        }

        const data = result.data
        assertChatSurface(data, `${spec.name} quality audit`, {
          expectNextSteps: Array.isArray(data?._ui?.follow_up_actions) && data._ui.follow_up_actions.length > 0,
        })

        const responseSizeBudget = getResponseSizeBudget(data)
        if (result.text.length > responseSizeBudget) {
          failures.push({ tool: spec.name, message: `response exceeded size budget (${result.text.length} chars > ${responseSizeBudget})` })
        } else if (result.text.length > Math.floor(responseSizeBudget * 0.8)) {
          warnings.push({ tool: spec.name, message: `response is approaching size budget (${result.text.length}/${responseSizeBudget} chars)` })
        }

        if (String(data.answer || '').length > 220) {
          warnings.push({ tool: spec.name, message: `answer is quite long (${String(data.answer).length} chars)` })
        }

        if (data._notice && /truncated/i.test(String(data._notice))) {
          failures.push({ tool: spec.name, message: 'response was truncated' })
        }
        if (Array.isArray(data._notices) && data._notices.some((notice: string) => /truncated/i.test(notice))) {
          failures.push({ tool: spec.name, message: 'response emitted truncation notices' })
        }

        if (hasLegacyWording(JSON.stringify(data.display ?? {})) || hasLegacyWording(String(data.answer ?? ''))) {
          failures.push({ tool: spec.name, message: 'chat surface still uses legacy wording' })
        }

        if (typeof data.display?.network === 'string' && data.display.network.includes('-mainnet')) {
          failures.push({ tool: spec.name, message: `display.network is not humanized (${data.display.network})` })
        }

        if (recoveredFromLatencySpike && originalSlowElapsedMs !== undefined) {
          warnings.push({
            tool: spec.name,
            message: `transient latency spike recovered on retry (${originalSlowElapsedMs}ms -> ${result.elapsedMs}ms)`,
          })
        } else if (result.elapsedMs > hardLatencyBudget) {
          failures.push({ tool: spec.name, message: `latency exceeded budget (${result.elapsedMs}ms > ${hardLatencyBudget}ms)` })
        } else if (result.elapsedMs > softLatencyBudget) {
          warnings.push({ tool: spec.name, message: `slow live response (${result.elapsedMs}ms ${classifySpeed(result.elapsedMs)}; budget ${hardLatencyBudget}ms)` })
        }

        if (
          intent === 'query'
          && !hasExplicitResponseFormat(args)
          && typeof data?._execution?.response_format === 'string'
          && data._execution.response_format === 'full'
        ) {
          failures.push({ tool: spec.name, message: 'default query response_format regressed to full instead of compact' })
        }

        console.log(`PASS  ${spec.name} [${result.elapsedMs}ms ${classifySpeed(result.elapsedMs)}]`)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        failures.push({ tool: spec.name, message: message.slice(0, 320) })
        console.log(`FAIL  ${spec.name}`)
        console.log(`      ${truncateText(message, 8)}`)
      }
    }

    printSection('Quality audit summary')
    console.log(`Warnings: ${warnings.length}`)
    warnings.slice(0, 20).forEach((warning) => console.log(`  - ${warning.tool}: ${warning.message}`))
    console.log(`Failures: ${failures.length}`)
    failures.slice(0, 20).forEach((failure) => console.log(`  - ${failure.tool}: ${failure.message}`))

    process.exit(failures.length > 0 ? 1 : 0)
  } finally {
    await closeTestClient(connected)
  }
}

main().catch((error) => {
  console.error(`Fatal error: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
