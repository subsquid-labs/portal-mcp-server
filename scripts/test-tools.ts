#!/usr/bin/env tsx

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

import { TOOL_SPECS, assert, getText, loadToolTestContext } from './tool-manifest.ts'

async function main() {
  console.log('Starting MCP tool tests...\n')

  const transport = new StdioClientTransport({
    command: 'node',
    args: ['dist/index.js'],
  })

  const client = new Client({ name: 'test-runner', version: '1.0.0' })
  await client.connect(transport)

  const { tools } = await client.listTools()
  const actualNames = new Set(tools.map((tool) => tool.name))
  const manifestNames = new Set(TOOL_SPECS.map((tool) => tool.name))
  const missingFromServer = TOOL_SPECS.map((tool) => tool.name).filter((name) => !actualNames.has(name))
  const missingFromManifest = tools.map((tool) => tool.name).filter((name) => !manifestNames.has(name))

  console.log(`Server reports ${tools.length} tools`)
  console.log(`Manifest covers ${TOOL_SPECS.length} tools\n`)

  assert(missingFromServer.length === 0, `Manifest tools missing from server: ${missingFromServer.join(', ')}`)
  assert(missingFromManifest.length === 0, `Server tools missing from manifest: ${missingFromManifest.join(', ')}`)

  const context = await loadToolTestContext(client)
  console.log(`Base head: ${context.baseHead}`)
  console.log(`Solana head: ${context.solHead}`)
  console.log(`Hyperliquid fills head: ${context.hlFillsHead}`)
  console.log(`Hyperliquid replica head: ${context.hlReplicaHead}\n`)

  let passed = 0
  let failed = 0
  const failures: { name: string; error: string }[] = []

  for (const spec of TOOL_SPECS) {
    const args = spec.args(context)
    const serializedArgs = JSON.stringify(args)
    const testLabel = `${spec.name} (${serializedArgs.slice(0, 80)}${serializedArgs.length > 80 ? '...' : ''})`

    try {
      const start = Date.now()
      const result = await client.callTool({ name: spec.name, arguments: args })
      const elapsed = Date.now() - start
      const text = getText(result)

      if (text.startsWith('Error:') || (result as any).isError) {
        throw new Error(`Tool returned error: ${text.slice(0, 240)}`)
      }

      spec.validate(text, context)

      const speed = elapsed < 1000 ? 'FAST' : elapsed < 3000 ? 'OK' : elapsed < 10000 ? 'SLOW' : 'VERY SLOW'
      console.log(`  PASS  ${testLabel} [${elapsed}ms ${speed}]`)
      passed++
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.log(`  FAIL  ${testLabel}`)
      console.log(`        ${message.slice(0, 240)}`)
      failed++
      failures.push({ name: spec.name, error: message.slice(0, 240) })
    }
  }

  console.log(`\n${'='.repeat(60)}`)
  console.log(`Results: ${passed} passed, ${failed} failed out of ${TOOL_SPECS.length} tests`)

  if (failures.length > 0) {
    console.log('\nFailures:')
    failures.forEach((failure) => {
      console.log(`  - ${failure.name}: ${failure.error}`)
    })
  }

  console.log(`${'='.repeat(60)}`)

  await client.close()
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((error) => {
  console.error('Fatal error:', error)
  process.exit(1)
})
