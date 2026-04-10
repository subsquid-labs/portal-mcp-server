#!/usr/bin/env tsx

import { TOOL_SPECS, loadToolTestContext } from './tool-manifest.ts'
import { callToolWithRetry, closeTestClient, connectTestClient, printSection, truncateText } from './test-helpers.ts'

async function main() {
  const connected = await connectTestClient('data-quality')
  const { client } = connected

  try {
    const { tools } = await client.listTools()
    console.log(`Server: ${tools.length} tools\n`)

    const context = await loadToolTestContext(client)

    for (const [index, spec] of TOOL_SPECS.entries()) {
      printSection(`${index + 1}. ${spec.name} — "${spec.prompt}"`)

      try {
        const result = await callToolWithRetry(client, spec.name, spec.args(context))
        console.log(truncateText(result.text))
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.log(`ERROR: ${message}`)
      }
    }

    printSection('DATA QUALITY REVIEW COMPLETE')

  } finally {
    await closeTestClient(connected)
  }
}

main().catch((error) => {
  console.error('Fatal error:', error)
  process.exit(1)
})
