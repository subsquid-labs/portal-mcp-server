/**
 * Smoke test: build, boot the MCP server, call 3 fast tools, assert results.
 * Usage: npm test
 */
import { execSync, spawn } from 'node:child_process'

const TIMEOUT_MS = 15_000
let child: ReturnType<typeof spawn> | null = null
let msgId = 0

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`)
  child?.kill()
  process.exit(1)
}

function send(method: string, params: Record<string, unknown> = {}): string {
  const id = String(++msgId)
  const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params })
  child!.stdin!.write(msg + '\n')
  return id
}

async function readResponse(expectedId: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timeout waiting for response')), 8000)

    const onData = (chunk: Buffer) => {
      const lines = chunk.toString().split('\n').filter(Boolean)
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line)
          if (parsed.id === expectedId) {
            clearTimeout(timer)
            child!.stdout!.off('data', onData)
            resolve(parsed)
            return
          }
        } catch {
          // not JSON, skip
        }
      }
    }

    child!.stdout!.on('data', onData)
  })
}

async function main() {
  const start = Date.now()

  // Step 1: Build
  console.log('Building...')
  try {
    execSync('npm run build', { stdio: 'pipe', cwd: process.cwd() })
  } catch (e: any) {
    fail(`Build failed: ${e.stderr?.toString() || e.message}`)
  }
  console.log('Build OK')

  // Step 2: Boot server via stdio
  child = spawn('node', ['dist/index.js'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: process.cwd(),
  })

  child.on('error', (err) => fail(`Server failed to start: ${err.message}`))
  child.stderr!.on('data', () => {
    // stderr is for logs, ignore unless debugging
  })

  // Step 3: Initialize MCP
  const initId = send('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'smoke-test', version: '1.0.0' },
  })
  const initResp = await readResponse(initId)
  if (initResp.error) fail(`Initialize error: ${JSON.stringify(initResp.error)}`)
  console.log(`Server: ${initResp.result?.serverInfo?.name} v${initResp.result?.serverInfo?.version}`)

  // Send initialized notification
  child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')

  // Step 4: List tools
  const listId = send('tools/list')
  const listResp = await readResponse(listId)
  if (listResp.error) fail(`tools/list error: ${JSON.stringify(listResp.error)}`)
  const toolCount = listResp.result?.tools?.length ?? 0
  console.log(`Tools registered: ${toolCount}`)
  if (toolCount < 20) fail(`Expected at least 20 tools, got ${toolCount}`)

  // Step 5: Call portal_list_datasets
  const dsId = send('tools/call', {
    name: 'portal_list_datasets',
    arguments: { network_type: 'mainnet' },
  })
  const dsResp = await readResponse(dsId)
  if (dsResp.error) fail(`portal_list_datasets error: ${JSON.stringify(dsResp.error)}`)
  const dsContent = dsResp.result?.content?.[0]?.text
  if (!dsContent || !dsContent.includes('ethereum-mainnet')) {
    fail(`portal_list_datasets: expected ethereum-mainnet in results`)
  }
  console.log('portal_list_datasets OK')

  // Step 6: Call portal_get_dataset_info
  const infoId = send('tools/call', {
    name: 'portal_get_dataset_info',
    arguments: { dataset: 'ethereum-mainnet' },
  })
  const infoResp = await readResponse(infoId)
  if (infoResp.error) fail(`portal_get_dataset_info error: ${JSON.stringify(infoResp.error)}`)
  const infoContent = infoResp.result?.content?.[0]?.text
  if (!infoContent || !infoContent.includes('ethereum')) {
    fail(`portal_get_dataset_info: expected ethereum in results`)
  }
  console.log('portal_get_dataset_info OK')

  // Step 7: Call portal_get_block_number
  const blockId = send('tools/call', {
    name: 'portal_get_block_number',
    arguments: { dataset: 'ethereum-mainnet' },
  })
  const blockResp = await readResponse(blockId)
  if (blockResp.error) fail(`portal_get_block_number error: ${JSON.stringify(blockResp.error)}`)
  const blockContent = blockResp.result?.content?.[0]?.text
  if (!blockContent) fail(`portal_get_block_number: empty response`)
  const parsed = JSON.parse(blockContent)
  const blockNum = parsed.number ?? parsed.block_number
  if (typeof blockNum !== 'number' || blockNum < 1_000_000) {
    fail(`portal_get_block_number: unexpected block number ${blockNum}`)
  }
  console.log(`portal_get_block_number OK (block ${blockNum})`)

  // Done
  child.kill()
  const elapsed = ((Date.now() - start) / 1000).toFixed(1)
  console.log(`\nAll smoke tests passed in ${elapsed}s`)
}

const timer = setTimeout(() => fail('Global timeout'), TIMEOUT_MS)
main()
  .then(() => {
    clearTimeout(timer)
    process.exit(0)
  })
  .catch((err) => {
    clearTimeout(timer)
    fail(err.message)
  })
