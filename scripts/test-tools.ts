#!/usr/bin/env tsx

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

import { LEGACY_TOOL_NAMES, TOOL_SPECS, assert, extractJson, getText, loadToolTestContext } from './tool-manifest.ts'

const FIRST_CHOICE_TOOLS = new Set([
  'portal_list_networks',
  'portal_get_network_info',
  'portal_get_head',
  'portal_get_recent_activity',
  'portal_get_wallet_summary',
  'portal_get_time_series',
])

function assertCatalogUx(tools: Array<{ name: string; description?: string }>) {
  const publicTools = tools.filter((tool) => !tool.name.startsWith('portal_debug_'))
  const advancedTools = tools.filter((tool) => tool.name.startsWith('portal_debug_'))

  for (const tool of publicTools) {
    const description = tool.description ?? ''
    assert(description.includes('WHEN TO USE:'), `${tool.name} description should include WHEN TO USE`)
    assert(description.includes('EXAMPLES:'), `${tool.name} description should include EXAMPLES`)
    assert(!/\bdataset\b/i.test(description), `${tool.name} description should avoid old 'dataset' wording`)
    assert(!/\bchain_type\b/i.test(description), `${tool.name} description should avoid old 'chain_type' wording`)

    if (FIRST_CHOICE_TOOLS.has(tool.name)) {
      assert(description.includes('FIRST CHOICE FOR:'), `${tool.name} description should include FIRST CHOICE FOR`)
    }
  }

  for (const tool of advancedTools) {
    const description = tool.description ?? ''
    assert(description.includes('ADVANCED:'), `${tool.name} description should be clearly marked ADVANCED`)
    assert(description.includes('WHEN TO USE:'), `${tool.name} description should include WHEN TO USE`)
    assert(description.includes('EXAMPLES:'), `${tool.name} description should include EXAMPLES`)
  }
}

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
  const publicTools = tools.filter((tool) => !tool.name.startsWith('portal_debug_'))
  const advancedTools = tools.filter((tool) => tool.name.startsWith('portal_debug_'))
  const legacyStillExposed = LEGACY_TOOL_NAMES.filter((name) => actualNames.has(name))

  console.log(`Server reports ${tools.length} tools`)
  console.log(`Manifest covers ${TOOL_SPECS.length} tools\n`)

  assert(missingFromServer.length === 0, `Manifest tools missing from server: ${missingFromServer.join(', ')}`)
  assert(missingFromManifest.length === 0, `Server tools missing from manifest: ${missingFromManifest.join(', ')}`)
  assert(tools.length === 23, `Expected exactly 23 registered tools, got ${tools.length}`)
  assert(publicTools.length === 20, `Expected exactly 20 public tools, got ${publicTools.length}`)
  assert(advancedTools.length === 3, `Expected exactly 3 advanced tools, got ${advancedTools.length}`)
  assert(legacyStillExposed.length === 0, `Legacy tool names are still exposed: ${legacyStillExposed.join(', ')}`)
  assertCatalogUx(tools)

  const context = await loadToolTestContext(client)
  console.log(`Base head: ${context.baseHead}`)
  console.log(`Solana head: ${context.solHead}`)
  console.log(`Hyperliquid fills head: ${context.hlFillsHead}`)
  console.log(`Hyperliquid replica head: ${context.hlReplicaHead}\n`)
  console.log('Catalog UX checks passed\n')

  let passed = 0
  let failed = 0
  const failures: { name: string; error: string }[] = []

  for (const spec of TOOL_SPECS) {
    const args = spec.args(context)
    const serializedArgs = JSON.stringify(args)
    const testLabel = `${spec.name} <- "${spec.prompt}" (${serializedArgs.slice(0, 80)}${serializedArgs.length > 80 ? '...' : ''})`

    try {
      const start = Date.now()
      const result = await client.callTool({ name: spec.name, arguments: args })
      const elapsed = Date.now() - start
      const text = getText(result)

      if (text.startsWith('Error:') || (result as any).isError) {
        if (spec.validateError) {
          spec.validateError(text, context)
          console.log(`  PASS  ${testLabel} [expected error]`)
          passed++
          continue
        }
        throw new Error(`Tool returned error: ${text.slice(0, 240)}`)
      }

      if (spec.validateError) {
        throw new Error('Expected tool to return an error')
      }

      spec.validate(text, context)
      const parsed = extractJson(text)
      assert(parsed?._tool_contract?.name === spec.name, `${spec.name} should include matching _tool_contract metadata`)
      if (parsed?._freshness !== undefined || parsed?._pagination !== undefined || parsed?.chart !== undefined) {
        assert(parsed?._execution !== undefined, `${spec.name} should include _execution metadata for query/chart-style responses`)
      }
      if (spec.validateFollowUp) {
        await spec.validateFollowUp(text, client, context)
      }

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
