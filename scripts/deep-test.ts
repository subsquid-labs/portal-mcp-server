#!/usr/bin/env tsx

import { TOOL_SPECS, loadToolTestContext } from './tool-manifest.ts'
import { callToolWithRetry, classifySpeed, closeTestClient, connectTestClient } from './test-helpers.ts'

async function main() {
  console.log(`Deep testing all ${TOOL_SPECS.length} MCP tools with realistic queries...\n`)

  const connected = await connectTestClient('deep-test')
  const { client } = connected

  try {
    const { tools } = await client.listTools()
    console.log(`Server reports ${tools.length} tools\n`)

    const context = await loadToolTestContext(client)
    let passed = 0
    let failed = 0
    const failures: { query: string; error: string }[] = []

    for (const spec of TOOL_SPECS) {
      const label = `[${spec.name}] ${spec.prompt}`

      try {
        const result = await callToolWithRetry(client, spec.name, spec.args(context))

        if (result.isError) {
          throw new Error(`Tool error: ${result.text.slice(0, 300)}`)
        }

        spec.validate(result.text, context)

        console.log(`  ✓ ${label} [${result.elapsedMs}ms ${classifySpeed(result.elapsedMs)}]`)
        passed++
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.log(`  ✗ ${label}`)
        console.log(`    ${message.slice(0, 300)}`)
        failed++
        failures.push({ query: label, error: message.slice(0, 300) })
      }
    }

    console.log(`\n${'='.repeat(70)}`)
    console.log(`Deep test results: ${passed} passed, ${failed} failed`)

    if (failures.length > 0) {
      console.log('\nFailures:')
      failures.forEach((failure) => console.log(`  - ${failure.query}: ${failure.error}`))
    }

    console.log(`${'='.repeat(70)}`)

    process.exit(failed > 0 ? 1 : 0)
  } finally {
    await closeTestClient(connected)
  }
}

main().catch((error) => {
  console.error('Fatal error:', error)
  process.exit(1)
})
