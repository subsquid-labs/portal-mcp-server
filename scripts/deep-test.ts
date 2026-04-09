#!/usr/bin/env tsx

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

import { TOOL_SPECS, getText, loadToolTestContext } from './tool-manifest.ts'

async function main() {
  console.log(`Deep testing all ${TOOL_SPECS.length} MCP tools with realistic queries...\n`)

  const transport = new StdioClientTransport({ command: 'node', args: ['dist/index.js'] })
  const client = new Client({ name: 'deep-test', version: '1.0.0' })
  await client.connect(transport)

  const { tools } = await client.listTools()
  console.log(`Server reports ${tools.length} tools\n`)

  const context = await loadToolTestContext(client)
  let passed = 0
  let failed = 0
  const failures: { query: string; error: string }[] = []

  for (const spec of TOOL_SPECS) {
    const label = `[${spec.name}] ${spec.prompt}`

    try {
      const start = Date.now()
      const result = await client.callTool({
        name: spec.name,
        arguments: spec.args(context),
      })
      const elapsed = Date.now() - start
      const text = getText(result)

      if (text.startsWith('Error:') || (result as any).isError) {
        throw new Error(`Tool error: ${text.slice(0, 300)}`)
      }

      spec.validate(text, context)

      const speed = elapsed < 1000 ? 'FAST' : elapsed < 3000 ? 'OK' : elapsed < 10000 ? 'SLOW' : 'VERY SLOW'
      console.log(`  ✓ ${label} [${elapsed}ms ${speed}]`)
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

  await client.close()
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((error) => {
  console.error('Fatal error:', error)
  process.exit(1)
})
