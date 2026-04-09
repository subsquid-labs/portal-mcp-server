#!/usr/bin/env tsx

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

import { TOOL_SPECS, getText, loadToolTestContext } from './tool-manifest.ts'

function divider(label: string) {
  console.log(`\n${'='.repeat(70)}`)
  console.log(`  ${label}`)
  console.log(`${'='.repeat(70)}`)
}

function truncate(text: string, maxLines = 40): string {
  const lines = text.split('\n')
  if (lines.length <= maxLines) return text
  return lines.slice(0, maxLines).join('\n') + `\n... (${lines.length - maxLines} more lines)`
}

async function main() {
  const transport = new StdioClientTransport({ command: 'node', args: ['dist/index.js'] })
  const client = new Client({ name: 'data-quality', version: '1.0.0' })
  await client.connect(transport)

  const { tools } = await client.listTools()
  console.log(`Server: ${tools.length} tools\n`)

  const context = await loadToolTestContext(client)

  for (const [index, spec] of TOOL_SPECS.entries()) {
    divider(`${index + 1}. ${spec.name} — "${spec.prompt}"`)

    try {
      const result = await client.callTool({
        name: spec.name,
        arguments: spec.args(context),
      })

      console.log(truncate(getText(result)))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.log(`ERROR: ${message}`)
    }
  }

  console.log(`\n${'='.repeat(70)}`)
  console.log('  DATA QUALITY REVIEW COMPLETE')
  console.log(`${'='.repeat(70)}`)

  await client.close()
}

main().catch((error) => {
  console.error('Fatal error:', error)
  process.exit(1)
})
