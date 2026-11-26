import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { Client } from '@modelcontextprotocol/client'
import { App } from '@modelcontextprotocol/ext-apps'
import { AppBridge } from '@modelcontextprotocol/ext-apps/app-bridge'
import { CLIENT_CAPABILITIES_META_KEY, InMemoryTransport } from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'

import { createPortalServer } from '../server.js'
import {
  ACTIVITY_EXPLORER_TOOLS,
  MCP_APP_EXTENSION_ID,
  MCP_APP_MIME_TYPE,
  extractDeclaredUiCapabilityFromBody,
  getActivityExplorerDeploymentMode,
  resolveActivityExplorerSurface,
} from './activity-explorer.js'

async function connectedClient() {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const server = createPortalServer({ transport: 'stdio', appEnabled: true })
  const client = new Client({ name: 'sqd-explorer-resource-test', version: '0.0.0' })
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  return { client, server }
}

describe('SQD Explorer resource metadata', () => {
  it('never claims a dedicated origin', async () => {
    // Claude checks _meta.ui.domain against an origin it derives from the
    // connector URL and refuses to render the app on any other value. This
    // server is reached through several URLs and through stdio, so no single
    // origin is correct, and the app needs none: it makes no network calls of
    // its own. The ChatGPT alias carries the same claim, so it is held to the
    // same rule.
    const { client, server } = await connectedClient()
    try {
      const listed = await client.listResources()
      const appResources = listed.resources.filter((entry) => entry.mimeType === MCP_APP_MIME_TYPE)
      assert.ok(appResources.length > 0, 'the app resource is listed when the app is enabled')

      for (const entry of appResources) {
        const listedUi = (entry._meta as Record<string, any> | undefined)?.ui
        assert.equal(listedUi?.domain, undefined, `${entry.uri} lists a ui.domain`)

        const read = await client.readResource({ uri: entry.uri })
        const content = read.contents[0] as Record<string, any> | undefined
        assert.equal(content?._meta?.ui?.domain, undefined, `${entry.uri} reads with a ui.domain`)
        assert.equal(content?._meta?.['openai/widgetDomain'], undefined, `${entry.uri} reads with a widget domain`)
        assert.ok(Array.isArray(content?._meta?.ui?.csp?.resourceDomains), `${entry.uri} keeps its CSP declaration`)
      }
    } finally {
      await client.close()
      await server.close()
    }
  })
})

it('exchanges App data and follow-up requests through the current SDK host bridge', async (t) => {
  const app = new App({ name: 'sqd-explorer-view-test', version: '0.0.0' }, {}, { strict: true, autoResize: false })
  const bridge = new AppBridge(
    null,
    { name: 'sqd-explorer-host-test', version: '0.0.0' },
    { serverTools: {}, openLinks: {}, downloadFile: {} },
    { hostContext: { theme: 'dark', displayMode: 'inline', availableDisplayModes: ['inline', 'fullscreen'] } },
  )
  t.after(async () => {
    await app.close()
    await bridge.close()
  })
  const payload = { content: [{ type: 'text' as const, text: '2 records' }], structuredContent: { count: 2 } }
  let deliveredArgs: unknown
  let deliveredResult: unknown
  let requestedTool: unknown
  let openedUrl: string | undefined
  let downloadedContents: unknown
  let requestedSize: unknown
  app.ontoolinput = ({ arguments: args }) => {
    deliveredArgs = args
  }
  app.ontoolresult = (result) => {
    deliveredResult = result
  }
  bridge.oncalltool = async (params) => {
    requestedTool = { name: params.name, arguments: params.arguments }
    return payload
  }
  bridge.onopenlink = async ({ url }) => {
    openedUrl = url
    return {}
  }
  bridge.ondownloadfile = async ({ contents }) => {
    downloadedContents = contents
    return {}
  }
  bridge.onsizechange = (size) => {
    requestedSize = size
  }
  bridge.onrequestdisplaymode = async ({ mode }) => {
    bridge.setHostContext({ theme: 'light', displayMode: mode })
    return { mode }
  }
  const [viewTransport, hostTransport] = InMemoryTransport.createLinkedPair()
  await bridge.connect(hostTransport)
  await app.connect(viewTransport)
  assert.equal(app.getHostContext()?.theme, 'dark')
  assert.ok(app.getHostCapabilities()?.serverTools)
  const args = { network: 'base', timeframe: '1h' }
  await bridge.sendToolInput({ arguments: args })
  await bridge.sendToolResult(payload)
  assert.deepEqual(deliveredArgs, args)
  assert.deepEqual(deliveredResult, payload)
  const followUp = { name: 'portal_get_recent_activity', arguments: args }
  assert.deepEqual(await app.callServerTool(followUp), payload)
  assert.deepEqual(requestedTool, followUp)
  assert.deepEqual(await app.requestDisplayMode({ mode: 'fullscreen' }), { mode: 'fullscreen' })
  assert.equal(app.getHostContext()?.theme, 'light')
  assert.equal(app.getHostContext()?.displayMode, 'fullscreen')
  await app.sendSizeChanged({ width: 640, height: 480 })
  assert.deepEqual(requestedSize, { width: 640, height: 480 })
  await app.openLink({ url: 'https://example.com/transaction' })
  assert.equal(openedUrl, 'https://example.com/transaction')
  const contents = [{ type: 'resource' as const, resource: { uri: 'file:///evidence.json', text: '{"count":2}' } }]
  await app.downloadFile({ contents })
  assert.deepEqual(downloadedContents, contents)
})

describe('SQD Explorer auto mode and tool coverage', () => {
  it('activates automatically for hosts that declare io.modelcontextprotocol/ui and respects opt-out', () => {
    const previous = process.env.MCP_APP_ENABLED
    try {
      delete process.env.MCP_APP_ENABLED
      assert.equal(getActivityExplorerDeploymentMode(), 'auto')
      assert.equal(resolveActivityExplorerSurface({ url: 'https://portal.sqd.dev/mcp' }, { uiDeclared: false }), false)
      assert.equal(resolveActivityExplorerSurface({ url: 'https://portal.sqd.dev/mcp' }, { uiDeclared: true }), true)
      assert.equal(
        resolveActivityExplorerSurface({ url: 'https://portal.sqd.dev/mcp?app=0' }, { uiDeclared: true }),
        false,
      )

      process.env.MCP_APP_ENABLED = 'false'
      assert.equal(getActivityExplorerDeploymentMode(), 'disabled')
      assert.equal(resolveActivityExplorerSurface({ url: 'https://portal.sqd.dev/mcp' }, { uiDeclared: true }), false)

      const envelopeBody = {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {
          _meta: {
            [CLIENT_CAPABILITIES_META_KEY]: {
              extensions: {
                [MCP_APP_EXTENSION_ID]: { mimeTypes: [MCP_APP_MIME_TYPE] },
              },
            },
          },
        },
      }
      assert.equal(extractDeclaredUiCapabilityFromBody(envelopeBody), true)
      assert.equal(
        extractDeclaredUiCapabilityFromBody({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
        false,
      )
    } finally {
      if (previous === undefined) delete process.env.MCP_APP_ENABLED
      else process.env.MCP_APP_ENABLED = previous
    }
  })

  it('includes Tron query tools and EVM traces in ACTIVITY_EXPLORER_TOOLS', () => {
    assert.ok(ACTIVITY_EXPLORER_TOOLS.has('portal_tron_query_transactions'))
    assert.ok(ACTIVITY_EXPLORER_TOOLS.has('portal_tron_query_logs'))
    assert.ok(ACTIVITY_EXPLORER_TOOLS.has('portal_evm_query_traces'))
  })

  it('auto-enables SQD Explorer on both legacy and modern 2026-07-28 stdio when io.modelcontextprotocol/ui is declared', async () => {
    const previous = process.env.MCP_APP_ENABLED
    delete process.env.MCP_APP_ENABLED
    try {
      for (const mode of ['legacy', 'modern'] as const) {
        const [uiClientTransport, uiServerTransport] = InMemoryTransport.createLinkedPair()
        const [plainClientTransport, plainServerTransport] = InMemoryTransport.createLinkedPair()
        const uiHandle = serveStdio(() => createPortalServer({ transport: 'stdio' }), {
          legacy: 'serve',
          transport: uiServerTransport,
        })
        const plainHandle = serveStdio(() => createPortalServer({ transport: 'stdio' }), {
          legacy: 'serve',
          transport: plainServerTransport,
        })
        const negotiation =
          mode === 'modern' ? { versionNegotiation: { mode: 'auto' as const, probe: { timeoutMs: 5_000 } } } : {}
        const uiClient = new Client(
          { name: `sqd-stdio-ui-host-${mode}`, version: '1.0.0' },
          {
            ...negotiation,
            capabilities: {
              extensions: {
                [MCP_APP_EXTENSION_ID]: { mimeTypes: [MCP_APP_MIME_TYPE] },
              },
            } as any,
          },
        )
        const plainClient = new Client({ name: `sqd-stdio-plain-host-${mode}`, version: '1.0.0' }, negotiation)
        await Promise.all([uiClient.connect(uiClientTransport), plainClient.connect(plainClientTransport)])
        try {
          if (mode === 'modern') {
            assert.equal(uiClient.getProtocolEra(), 'modern')
            assert.equal(uiClient.getNegotiatedProtocolVersion(), '2026-07-28')
          }
          const uiTools = (await uiClient.listTools()).tools.filter((tool) =>
            Boolean((tool._meta as Record<string, any> | undefined)?.ui?.resourceUri),
          )
          assert.equal(uiTools.length, ACTIVITY_EXPLORER_TOOLS.size, `${mode} stdio should attach Explorer metadata`)
          assert.ok(uiTools.some((tool) => tool.name === 'portal_tron_query_transactions'))
          assert.ok(uiTools.some((tool) => tool.name === 'portal_evm_query_traces'))

          const plainTools = (await plainClient.listTools()).tools.filter((tool) =>
            Boolean((tool._meta as Record<string, any> | undefined)?.ui?.resourceUri),
          )
          assert.equal(plainTools.length, 0, `${mode} plain stdio client should not receive Explorer metadata`)
        } finally {
          await Promise.all([uiClient.close(), plainClient.close(), uiHandle.close(), plainHandle.close()])
        }
      }
    } finally {
      if (previous === undefined) delete process.env.MCP_APP_ENABLED
      else process.env.MCP_APP_ENABLED = previous
    }
  })
})
