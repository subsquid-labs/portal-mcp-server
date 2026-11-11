#!/usr/bin/env tsx
/* A local MCP Apps host for the SQD Explorer. It runs the Portal server in
   memory, serves the shipped App resource inside an iframe through the
   official AppBridge, proxies the App's tool calls to the server, opens
   explorer links in new tabs, and saves downloads. Nothing here is mocked. */

import { createServer } from 'node:http'
import path from 'node:path'

import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport } from '@modelcontextprotocol/server'
import { build } from 'esbuild'

import { ACTIVITY_EXPLORER_RESOURCE_URI } from '../src/apps/activity-explorer.ts'
import { createPortalServer } from '../src/server.ts'

const PORT = Number(process.env.PORT || 4174)

const PRESETS: Array<{ label: string; name: string; arguments: Record<string, unknown> }> = [
  {
    label: 'Recent activity · Base',
    name: 'portal_get_recent_activity',
    arguments: { network: 'base-mainnet', timeframe: '1h', limit: 12 },
  },
  {
    label: 'Wallet · Base',
    name: 'portal_get_wallet_summary',
    arguments: {
      network: 'base-mainnet',
      address: '0x1d7f97d26ae2c01f9b01fc252b73cf0db3397e95',
      timeframe: '1h',
      response_format: 'full',
    },
  },
  {
    label: 'USDC contract · Base',
    name: 'portal_evm_get_contract_activity',
    arguments: {
      network: 'base-mainnet',
      contract_address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
      timeframe: '1h',
    },
  },
  {
    label: 'USDC transfers · Base',
    name: 'portal_evm_query_token_transfers',
    arguments: { network: 'base-mainnet', timeframe: '30m', token_symbols: ['USDC'], limit: 10 },
  },
  {
    label: 'Top contracts · Base',
    name: 'portal_evm_get_analytics',
    arguments: { network: 'base-mainnet', timeframe: '1h', limit: 50 },
  },
  {
    label: 'Transactions 15m · Base',
    name: 'portal_get_time_series',
    arguments: { network: 'base-mainnet', metric: 'transaction_count', duration: '15m', interval: '5m' },
  },
  {
    label: 'BTC candles · Hyperliquid',
    name: 'portal_hyperliquid_get_ohlc',
    arguments: { network: 'hyperliquid-fills', coin: 'BTC', duration: '24h', interval: '1h' },
  },
  {
    label: 'cbETH/WETH · Uniswap v3',
    name: 'portal_evm_get_ohlc',
    arguments: {
      network: 'base-mainnet',
      source: 'uniswap_v3_swap',
      pool_address: '0x10648ba41b8565907cfa1496765fa4d95390aa0d',
      duration: '1h',
      interval: '5m',
      price_in: 'auto',
      token0_symbol: 'cbETH',
      token1_symbol: 'WETH',
    },
  },
]

const hostEntry = `
import { AppBridge, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge'

const presets = window.__SQD_PRESETS__
const frame = document.querySelector('#frame')
const status = document.querySelector('#status')
const picker = document.querySelector('#presets')
const custom = document.querySelector('#custom')
const runCustom = document.querySelector('#run-custom')
const themeToggle = document.querySelector('#theme')
let theme = 'dark'
let displayMode = 'inline'
let bridge
/* Real hosts size the inline card from ui/notifications/size-changed; do the
   same so the local card is exactly as tall as the app's content. */
let inlineHeight = 320
function fitFrame() {
  if (displayMode === 'inline') frame.style.height = inlineHeight + 'px'
  else frame.style.height = ''
}

function context() {
  return { theme, displayMode, availableDisplayModes: ['inline', 'fullscreen'] }
}

function applyMode(mode) {
  displayMode = mode
  document.body.dataset.mode = mode
  fitFrame()
}

function say(text) {
  status.textContent = text
}

async function callTool(params) {
  const response = await fetch('/tool', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(params) })
  return response.json()
}

async function run(name, args) {
  say('Calling ' + name + ' …')
  const started = performance.now()
  await bridge.sendToolInput({ arguments: args })
  const result = await callTool({ name, arguments: args })
  await bridge.sendToolResult(result)
  say(name + ' · ' + Math.round(performance.now() - started) + ' ms' + (result.isError ? ' · error' : ''))
}

async function main() {
  const resource = await (await fetch('/resource')).text()
  bridge = new AppBridge(
    null,
    { name: 'SQD local host', version: '1.0.0' },
    { openLinks: {}, serverTools: {}, downloadFile: {}, logging: {} },
    { hostContext: context() },
  )
  bridge.onrequestdisplaymode = async ({ mode }) => {
    applyMode(mode)
    bridge.setHostContext(context())
    return { mode }
  }
  bridge.oncalltool = async (params) => callTool(params)
  bridge.onsizechange = ({ height }) => {
    if (typeof height !== 'number' || displayMode !== 'inline') return
    inlineHeight = Math.max(120, Math.ceil(height))
    fitFrame()
  }
  bridge.onopenlink = async ({ url }) => {
    window.open(url, '_blank', 'noopener')
    say('Opened ' + url)
    return {}
  }
  bridge.ondownloadfile = async ({ contents }) => {
    for (const item of contents) {
      if (item.type !== 'resource') continue
      const res = item.resource
      const blob = res.blob
        ? new Blob([Uint8Array.from(atob(res.blob), (c) => c.charCodeAt(0))], { type: res.mimeType })
        : new Blob([res.text ?? ''], { type: res.mimeType })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = res.uri.split('/').pop() ?? 'download'
      link.click()
      setTimeout(() => URL.revokeObjectURL(url), 0)
      say('Saved ' + link.download)
    }
    return {}
  }
  bridge.onlog = async () => ({})
  bridge.oninitialized = async () => {
    say('App connected. Pick a query.')
    const first = presets[0]
    await run(first.name, first.arguments)
  }
  const transport = new PostMessageTransport(frame.contentWindow, frame.contentWindow)
  await bridge.connect(transport)
  frame.srcdoc = resource

  for (const preset of presets) {
    const button = document.createElement('button')
    button.textContent = preset.label
    button.addEventListener('click', () => run(preset.name, preset.arguments))
    picker.append(button)
  }
  runCustom.addEventListener('click', () => {
    try {
      const parsed = JSON.parse(custom.value)
      run(parsed.name, parsed.arguments ?? {})
    } catch (error) {
      say('Custom call must be JSON like {"name":"portal_get_head","arguments":{"network":"base"}}')
    }
  })
  themeToggle.addEventListener('click', () => {
    theme = theme === 'dark' ? 'light' : 'dark'
    document.body.dataset.theme = theme
    themeToggle.textContent = theme === 'dark' ? 'Light theme' : 'Dark theme'
    bridge.setHostContext(context())
  })
}

main().catch((error) => say('Host failed: ' + (error instanceof Error ? error.message : String(error))))
`

const page = (presets: typeof PRESETS) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>SQD Explorer · local host</title>
<style>
  :root { color-scheme: dark light; }
  body { margin: 0; font: 13px/1.4 system-ui, sans-serif; background: #08090a; color: #e7e8ea; min-height: 100vh; }
  body[data-theme='light'] { background: #f4f4f5; color: #111115; }
  header { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 10px 14px; border-bottom: 1px solid #26282c; }
  body[data-theme='light'] header { border-color: #d9dbe0; }
  header strong { margin-right: 6px; }
  button { font: inherit; padding: 5px 10px; border-radius: 6px; border: 1px solid #3a3d44; background: #17191d; color: inherit; cursor: pointer; }
  body[data-theme='light'] button { background: #fff; border-color: #c9ccd3; }
  button:hover { border-color: #818cf8; }
  #custom { font: 12px ui-monospace, monospace; width: 420px; max-width: 100%; padding: 5px 8px; border-radius: 6px; border: 1px solid #3a3d44; background: #0f1114; color: inherit; }
  body[data-theme='light'] #custom { background: #fff; border-color: #c9ccd3; }
  #status { margin-left: auto; opacity: 0.75; font: 12px ui-monospace, monospace; }
  main { padding: 14px; }
  #frame { width: 100%; max-width: 760px; height: 320px; border: 1px solid #26282c; border-radius: 12px; background: transparent; display: block; margin: 0 auto; }
  body[data-theme='light'] #frame { border-color: #d9dbe0; }
  body[data-mode='fullscreen'] #frame { position: fixed; inset: 0; width: 100vw; height: 100vh; max-width: none; border: 0; border-radius: 0; z-index: 10; }
  .hint { max-width: 760px; margin: 0 auto 10px; opacity: 0.7; }
</style></head>
<body data-theme="dark" data-mode="inline">
<header>
  <strong>SQD Explorer · local MCP Apps host</strong>
  <span id="presets"></span>
  <input id="custom" placeholder='{"name":"portal_get_recent_activity","arguments":{"network":"base","timeframe":"1h","limit":5}}'>
  <button id="run-custom">Run JSON</button>
  <button id="theme">Light theme</button>
  <span id="status">Starting …</span>
</header>
<main>
  <p class="hint">Inline card at a 760px host column, exactly as a chat host shows it. Open full screen takes over the window. Links open the public explorer in a new tab; downloads save files.</p>
  <iframe id="frame" title="SQD Explorer" sandbox="allow-scripts"></iframe>
</main>
<script>window.__SQD_PRESETS__ = ${JSON.stringify(presets)}</script>
<script src="/host.js"></script>
</body></html>`

async function main() {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const portal = createPortalServer({ transport: 'stdio', appEnabled: true })
  const client = new Client({ name: 'sqd-local-host', version: '1.0.0' })
  await portal.connect(serverTransport)
  await client.connect(clientTransport)

  const resource = await client.readResource({ uri: ACTIVITY_EXPLORER_RESOURCE_URI })
  const resourceHtml = String((resource.contents[0] as { text?: string }).text ?? '')
  const bundle = await build({
    stdin: { contents: hostEntry, resolveDir: path.resolve('.'), loader: 'js' },
    bundle: true,
    format: 'iife',
    platform: 'browser',
    write: false,
    nodePaths: [path.resolve('node_modules')],
    logLevel: 'silent',
  })
  const hostJs = bundle.outputFiles[0]?.text ?? ''

  const http = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', `http://127.0.0.1:${PORT}`)
    try {
      if (request.method === 'POST' && url.pathname === '/tool') {
        const chunks: Buffer[] = []
        for await (const chunk of request) chunks.push(chunk as Buffer)
        const params = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
          name: string
          arguments?: Record<string, unknown>
        }
        const result = await client.callTool({ name: params.name, arguments: params.arguments ?? {} })
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify(result))
        return
      }
      if (url.pathname === '/resource') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        response.end(resourceHtml)
        return
      }
      if (url.pathname === '/host.js') {
        response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' })
        response.end(hostJs)
        return
      }
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      response.end(page(PRESETS))
    } catch (error) {
      response.writeHead(500, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          isError: true,
          content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
        }),
      )
    }
  })
  http.listen(PORT, '127.0.0.1', () => {
    console.log(`SQD Explorer local host: http://127.0.0.1:${PORT}/`)
  })
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
