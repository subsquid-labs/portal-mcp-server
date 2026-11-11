#!/usr/bin/env tsx

import { readFile } from 'node:fs/promises'

import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport } from '@modelcontextprotocol/server'

import { EXPLORER_CHART_CAPABILITIES } from '../src/app-ui/capabilities.js'
import { CHAINS, LOGO_CDN, LOGO_ORIGINS } from '../src/app-ui/chains.generated.js'
import { chainLogoUrl, explorerLink } from '../src/app-ui/explorers.js'
import { buildEvidenceExport } from '../src/app-ui/export.js'
import { APP_FIXTURES } from '../src/app-ui/fixtures.js'
import { evidenceArguments, planFollowup, shorterDuration } from '../src/app-ui/followup-state.js'
import { formatValue } from '../src/app-ui/view.js'
import {
  ACTIVITY_EXPLORER_RESOURCE_URI,
  ACTIVITY_EXPLORER_TOOLS,
  MCP_APP_MIME_TYPE,
  RETAINED_ACTIVITY_EXPLORER_RESOURCE_URIS,
  classifyUiCapability,
  recordActivityExplorerResult,
  resolveActivityExplorerSurface,
} from '../src/apps/activity-explorer.js'
import { ACTIVITY_EXPLORER_BYTES, ACTIVITY_EXPLORER_HASH } from '../src/generated/activity-explorer.version.js'
import { buildCandlestickChart, buildTimeSeriesChart } from '../src/helpers/chart-metadata.js'
import { formatResult } from '../src/helpers/format.js'
import { register } from '../src/metrics.js'
import { createPortalServer, getPortalServerInstructions } from '../src/server.js'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function buildAppResult() {
  return formatResult({ items: [{ primary_id: 'fixture-row' }] }, 'Fixture result', {
    toolName: 'portal_get_recent_activity',
    ui: { version: 'portal_ui_v1' },
  })
}

async function main() {
  const packageVersion = String(JSON.parse(await readFile('package.json', 'utf8')).version || '')
  delete process.env.MCP_APP_ENABLED
  const defaultResult = buildAppResult()
  assert(
    defaultResult.structuredContent?._server?.name === 'SQD' &&
      defaultResult.structuredContent?._server?.version === packageVersion,
    'every App-capable result must preserve the observable SQD server identity and exact package version',
  )
  assert(
    defaultResult.structuredContent?._app === undefined,
    'the beta app must not announce itself to hosts unless the deployment opts in',
  )
  assert(
    defaultResult.structuredContent?._ui !== undefined,
    'opting out of the beta app must not change the presentation metadata in the payload',
  )
  process.env.MCP_APP_ENABLED = 'true'
  const appResult = buildAppResult()
  assert(
    appResult.structuredContent?._app?.name === 'SQD Explorer' &&
      appResult.structuredContent?._app?.stage === 'beta' &&
      appResult.structuredContent?._app?.server_delivery_state === 'ready' &&
      appResult.structuredContent?._app?.host_render_state === 'not_observable_from_tool_result' &&
      appResult.structuredContent?._app?.required_host_extension === 'io.modelcontextprotocol/ui' &&
      appResult.structuredContent?._app?.host_render_confirmed === undefined,
    'App-enabled results must expose the canonical product name and delivery state without inventing a host render verdict',
  )
  const inferredAppResult = formatResult(
    [{ primary_id: 'fixture-transaction', hash: `0x${'1'.repeat(64)}` }],
    'Fixture transaction',
    { toolName: 'portal_evm_query_transactions' },
  )
  assert(
    inferredAppResult.structuredContent?._ui === undefined &&
      inferredAppResult.structuredContent?._app?.name === 'SQD Explorer',
    'every advertised App tool must return the App identity even when the renderer uses its exact-row fallback',
  )
  for (const toolName of ACTIVITY_EXPLORER_TOOLS) {
    const toolResult = formatResult([{ primary_id: `${toolName}-fixture` }], 'Fixture result', { toolName })
    assert(
      toolResult.structuredContent?._app?.name === 'SQD Explorer',
      `${toolName} must return the App identity whenever it advertises the App`,
    )
  }
  delete process.env.MCP_APP_ENABLED
  assert(shorterDuration('in last 38 mins') === '19m', 'natural-language chart windows should narrow deterministically')
  assert(
    evidenceArguments({ _evidence: { request: { arguments: { duration: '1h', coin: 'BTC' } } } }, { coin: 'BTC' })
      .duration === '1h',
    'follow-ups should recover schema defaults from the factual evidence receipt',
  )
  assert(
    planFollowup({
      intent: 'zoom_in',
      currentArgs: evidenceArguments(
        { _evidence: { request: { arguments: { duration: '1h', coin: 'BTC' } } } },
        { coin: 'BTC' },
      ),
    }).callArgs?.duration === '30m',
    'default one-hour chart windows should narrow to thirty minutes',
  )
  const continuationPlan = planFollowup({
    intent: 'continue',
    currentArgs: { network: 'hyperliquid-fills', coin: 'BTC', duration: '1h', cursor: 'old' },
    nextCursor: 'next',
  })
  assert(
    JSON.stringify(continuationPlan.callArgs) === JSON.stringify({ cursor: 'next' }) &&
      JSON.stringify(continuationPlan.persistedArgs) ===
        JSON.stringify({ network: 'hyperliquid-fills', coin: 'BTC', duration: '1h' }),
    'continuation should call by cursor while preserving the investigation arguments for later follow-ups',
  )
  const timeSeriesContract = buildTimeSeriesChart({ interval: '1m', totalPoints: 12 })
  const candleContract = buildCandlestickChart({ interval: '1m', totalCandles: 12 })
  for (const [name, chart] of [
    ['time series', timeSeriesContract],
    ['candlestick', candleContract],
  ] as const) {
    /* The contract may only name controls the app has actually built. For two
       releases it offered a PNG export and a visual switch that did not exist;
       the app now publishes what it implements and the declaration is held
       against that list rather than against a comment. */
    assert(
      chart.interactions?.hover?.enabled === EXPLORER_CHART_CAPABILITIES.hover &&
        chart.interactions?.hover?.crosshair === EXPLORER_CHART_CAPABILITIES.crosshair &&
        chart.interactions?.hover?.snap_to_data === EXPLORER_CHART_CAPABILITIES.snapToData,
      `${name} charts should declare exactly the hover behaviour the app implements`,
    )
    assert(
      chart.interactions?.zoom?.enabled === true &&
        chart.interactions?.zoom?.axis === EXPLORER_CHART_CAPABILITIES.zoomAxis &&
        chart.interactions?.zoom?.brush === EXPLORER_CHART_CAPABILITIES.brush,
      `${name} charts should declare the range focus the app implements`,
    )
    assert(chart.interactions?.toolbar?.enabled === true, `${name} charts should expose the implemented range controls`)
    assert(
      JSON.stringify(chart.interactions?.toolbar?.actions) ===
        JSON.stringify([...EXPLORER_CHART_CAPABILITIES.toolbarActions]),
      `${name} charts must name every toolbar control the app builds and no others (got ${JSON.stringify(chart.interactions?.toolbar?.actions)})`,
    )
    assert(
      chart.interactions?.legend?.toggle_series === undefined ||
        chart.interactions.legend.toggle_series === EXPLORER_CHART_CAPABILITIES.legendToggle,
      `${name} charts should declare series toggling only where the app implements it`,
    )
  }
  const shortChart = buildTimeSeriesChart({
    interval: '1m',
    totalPoints: EXPLORER_CHART_CAPABILITIES.minimumPointsForZoom - 1,
  })
  assert(
    shortChart.interactions?.zoom?.enabled === false && shortChart.interactions.toolbar?.actions.length === 0,
    'short charts should not advertise unnecessary range controls',
  )
  const zoomableChart = buildTimeSeriesChart({
    interval: '1m',
    totalPoints: EXPLORER_CHART_CAPABILITIES.minimumPointsForZoom,
  })
  assert(
    zoomableChart.interactions?.zoom?.enabled === true,
    'a chart at the app minimum should advertise the controls the app draws',
  )

  const jsonExport = buildEvidenceExport(APP_FIXTURES.hyperliquid, 'json')
  const csvExport = buildEvidenceExport(APP_FIXTURES.hyperliquid, 'csv')
  const hyperliquidRows = (APP_FIXTURES.hyperliquid.ohlc as unknown[]).length
  assert(
    jsonExport.filename.endsWith('.json') && jsonExport.rowCount === hyperliquidRows,
    'JSON evidence export should include all candles',
  )
  assert(
    csvExport.filename.endsWith('.csv') && csvExport.rowCount === hyperliquidRows,
    'CSV evidence export should include all candles',
  )
  assert(csvExport.content.includes('sqd_evidence_sha256'), 'CSV evidence export should preserve receipt identity')
  assert(
    csvExport.content.split('\r\n').length === hyperliquidRows + 2,
    'CSV export should contain one header and every exact row',
  )
  const activityJson = buildEvidenceExport(APP_FIXTURES.activity, 'json')
  const activityCsv = buildEvidenceExport(APP_FIXTURES.activity, 'csv')
  const exactActivityHash = String((APP_FIXTURES.activity.items as Record<string, unknown>[])[0]?.tx_hash)
  for (const exported of [activityJson, activityCsv]) {
    assert(
      exported.content.includes(exactActivityHash),
      'evidence exports should keep transaction hashes byte-for-byte exact',
    )
  }
  assert(
    ACTIVITY_EXPLORER_HASH !== 'unbuilt' && /^[a-f0-9]{12}$/.test(ACTIVITY_EXPLORER_HASH),
    'app resource needs a content hash',
  )
  assert(
    ACTIVITY_EXPLORER_RESOURCE_URI.includes(ACTIVITY_EXPLORER_HASH),
    'resource URI must use the bundle hash as its cache key',
  )
  for (const tool of [
    'portal_list_networks',
    'portal_get_network_info',
    'portal_get_head',
    'portal_debug_resolve_time_to_block',
  ]) {
    assert(!ACTIVITY_EXPLORER_TOOLS.has(tool), `${tool} is metadata evidence and must not advertise a data explorer`)
  }

  const [defaultClientTransport, defaultServerTransport] = InMemoryTransport.createLinkedPair()
  const defaultServer = createPortalServer({ transport: 'stdio' })
  const defaultClient = new Client({ name: 'sqd-app-contract-default', version: '1.0.0' })
  await defaultServer.connect(defaultServerTransport)
  await defaultClient.connect(defaultClientTransport)
  try {
    const listedTools = await defaultClient.listTools()
    assert(listedTools.tools.length === 31, 'opting out of the beta app must not change the 31-tool catalog')
    for (const tool of listedTools.tools) {
      const meta = tool._meta as Record<string, any> | undefined
      assert(
        meta?.ui?.resourceUri === undefined &&
          meta?.['ui/resourceUri'] === undefined &&
          meta?.['openai/outputTemplate'] === undefined,
        `${tool.name} must not ask a host to render the beta app by default`,
      )
      assert(
        !tool.description?.includes('MCP APP:'),
        `${tool.name} must not promise an app surface the host was never offered`,
      )
    }
    assert(
      !getPortalServerInstructions().includes('MCP App'),
      'default server instructions must not point the model at a beta app the host was never offered',
    )
    const resources = await defaultClient.listResources()
    assert(
      resources.resources.some((entry) => entry.uri === ACTIVITY_EXPLORER_RESOURCE_URI),
      'the beta app resource should stay readable for hosts that opt in',
    )
  } finally {
    await defaultClient.close()
    await defaultServer.close()
  }

  delete process.env.MCP_APP_ENABLED
  assert(
    resolveActivityExplorerSurface({ url: 'https://portal.sqd.dev/mcp?app=1' }) === true &&
      resolveActivityExplorerSurface({ url: 'https://portal.sqd.dev/mcp?app=true' }) === true,
    'a connection should be able to opt into the beta app without enabling it for the deployment',
  )
  assert(
    resolveActivityExplorerSurface({ url: 'https://portal.sqd.dev/mcp' }) === false &&
      resolveActivityExplorerSurface(undefined) === false,
    'a connection without the opt-in should stay on the data-only default',
  )
  process.env.MCP_APP_ENABLED = 'true'
  assert(
    resolveActivityExplorerSurface({ url: 'https://portal.sqd.dev/mcp?app=0' }) === false &&
      resolveActivityExplorerSurface({ url: 'https://portal.sqd.dev/mcp' }) === true,
    'an explicit connection choice should override the deployment default in both directions',
  )
  delete process.env.MCP_APP_ENABLED

  const [optInClientTransport, optInServerTransport] = InMemoryTransport.createLinkedPair()
  const optInServer = createPortalServer({ transport: 'http', appEnabled: true })
  const optInClient = new Client({ name: 'sqd-app-contract-opt-in', version: '1.0.0' })
  await optInServer.connect(optInServerTransport)
  await optInClient.connect(optInClientTransport)
  try {
    const optedIn = (await optInClient.listTools()).tools.find((tool) => tool.name === 'portal_hyperliquid_get_ohlc')
    const meta = optedIn?._meta as Record<string, any> | undefined
    assert(
      meta?.['ui/resourceUri'] === ACTIVITY_EXPLORER_RESOURCE_URI,
      'a connection that opted in should receive the app metadata even when the deployment default is off',
    )
    assert(
      (optInClient.getInstructions() ?? '').includes('SQD Explorer'),
      'an opted-in connection should be told the app exists',
    )
  } finally {
    await optInClient.close()
    await optInServer.close()
  }

  process.env.MCP_APP_ENABLED = 'true'
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const server = createPortalServer({ transport: 'stdio' })
  const client = new Client({ name: 'sqd-app-contract', version: '1.0.0' })
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  try {
    const listedTools = await client.listTools()
    assert(listedTools.tools.length === 31, 'the MCP App must not change the 31-tool catalog')
    const advertisedAppTools = listedTools.tools
      .filter((tool) => Boolean((tool._meta as Record<string, any> | undefined)?.['ui/resourceUri']))
      .map((tool) => tool.name)
      .sort()
    assert(
      JSON.stringify(advertisedAppTools) === JSON.stringify([...ACTIVITY_EXPLORER_TOOLS].sort()),
      'the advertised App tool set must exactly match the formatter App tool set',
    )
    for (const tool of listedTools.tools) {
      const meta = tool._meta as Record<string, any> | undefined
      if (ACTIVITY_EXPLORER_TOOLS.has(tool.name)) {
        assert(
          meta?.ui?.resourceUri === ACTIVITY_EXPLORER_RESOURCE_URI,
          `${tool.name} should advertise standard UI metadata`,
        )
        assert(
          meta?.['ui/resourceUri'] === ACTIVITY_EXPLORER_RESOURCE_URI,
          `${tool.name} should retain the MCP Apps compatibility alias`,
        )
        assert(
          meta?.['openai/outputTemplate'] === ACTIVITY_EXPLORER_RESOURCE_URI,
          `${tool.name} should expose the ChatGPT output template alias`,
        )
      } else {
        assert(meta?.ui?.resourceUri === undefined, `${tool.name} should not open the explorer for a non-visual lookup`)
      }
      assert(tool.annotations?.readOnlyHint === true, `${tool.name} must remain read-only`)
    }
    const fillsTool = listedTools.tools.find((tool) => tool.name === 'portal_hyperliquid_query_fills')
    const walletTool = listedTools.tools.find((tool) => tool.name === 'portal_get_wallet_summary')
    const serverSchema = (walletTool?.outputSchema as Record<string, any> | undefined)?.properties?._server
    assert(
      serverSchema?.properties?.name?.type === 'string' &&
        serverSchema?.properties?.version?.type === 'string' &&
        serverSchema?.required?.includes('name') &&
        serverSchema?.required?.includes('version'),
      'the public output schema must keep the exact required _server name and version fields',
    )
    assert(
      fillsTool?.inputSchema?.properties?.limit?.maximum === 200,
      'fills should accept the retained installed-client limit and adapt it to a safe page',
    )
    assert(
      walletTool?.inputSchema?.properties?.limit_per_type?.maximum === 10,
      'wallet summary should accept the retained installed-client category limit and adapt it to a safe page',
    )

    const resources = await client.listResources()
    const resource = resources.resources.find((entry) => entry.uri === ACTIVITY_EXPLORER_RESOURCE_URI)
    assert(resource?.mimeType === MCP_APP_MIME_TYPE, 'resources/list should advertise the standard MCP App MIME type')
    const read = await client.readResource({ uri: ACTIVITY_EXPLORER_RESOURCE_URI })
    const content = read.contents[0] as Record<string, any> | undefined
    assert(content?.mimeType === MCP_APP_MIME_TYPE, 'resources/read should retain the app MIME type')
    assert(
      typeof content?.text === 'string' && Buffer.byteLength(content.text) === ACTIVITY_EXPLORER_BYTES,
      'resource bytes must match the generated artifact',
    )
    assert(
      content.text.includes('SQD Explorer') &&
        content.text.includes(`version:${JSON.stringify(packageVersion)}`) &&
        content.text.includes('viewBox="0 0 306 306"') &&
        content.text.includes('#08090a') &&
        content.text.includes('#818cf8') &&
        content.text.includes('JetBrains Mono SQD') &&
        // The sans face is the host's to supply; only the mono face ships.
        !content.text.includes('Inter SQD'),
      'the app should contain the official SQD mark, dark product tokens, and the embedded mono face only',
    )
    assert(
      !content.text.includes('<script src=') && !content.text.includes('<link rel='),
      'the app must be self-contained',
    )
    assert(
      content.text.includes('https://www.tradingview.com/'),
      'the bundled market chart must retain the required TradingView product-creator link',
    )
    /* Every module the reader can end up looking at. The Explorer was one
       file; it is now `view.ts` over `masthead.ts`, `charts/`, `tables.ts`,
       `panels.ts`, `states.ts` and `common.ts`, and copy can hide in any of
       them. */
    const APP_COPY_MODULES = [
      'src/app-ui/view.ts',
      'src/app-ui/index.ts',
      'src/app-ui/fixtures.ts',
      'src/app-ui/common.ts',
      'src/app-ui/masthead.ts',
      'src/app-ui/tables.ts',
      'src/app-ui/panels.ts',
      'src/app-ui/states.ts',
      'src/app-ui/charts/range.ts',
      'src/app-ui/charts/terminal.ts',
    ]
    const publicCopySources = await Promise.all(APP_COPY_MODULES.map((path) => readFile(path, 'utf8')))
    for (const [index, source] of publicCopySources.entries()) {
      assert(!source.includes('—'), `public app copy must not contain em dashes (${APP_COPY_MODULES[index]})`)
    }
    const appBridgeSource = publicCopySources[1]
    const chartSource = publicCopySources[APP_COPY_MODULES.indexOf('src/app-ui/charts/terminal.ts')]
    assert(
      chartSource.includes("'Charts by TradingView'") &&
        chartSource.includes("attribution.href = 'https://www.tradingview.com/'"),
      'the market chart must keep the required TradingView attribution visible',
    )
    assert(
      appBridgeSource.includes("from '@modelcontextprotocol/ext-apps'") &&
        appBridgeSource.includes('new App(') &&
        appBridgeSource.includes('{ strict: true, autoResize: true }') &&
        appBridgeSource.includes('app.callServerTool') &&
        appBridgeSource.includes('app.requestDisplayMode'),
      'the app should use the strict portable MCP Apps bridge for results, follow-ups, and display mode',
    )
    assert(
      !appBridgeSource.includes('localStorage') && !appBridgeSource.includes('sessionStorage'),
      'the app should keep ephemeral history in the active UI instance instead of browser storage',
    )
    assert(content._meta?.ui?.csp?.connectDomains?.length === 0, 'the app must not make external network requests')
    assert(
      JSON.stringify(content._meta?.ui?.csp?.resourceDomains) ===
        JSON.stringify(['https://cdn.subsquid.io', 'https://sqd.dev']),
      'the app loads chain logos only from SQD domains',
    )
    assert(
      JSON.stringify(content._meta?.['openai/widgetCSP']?.resource_domains) ===
        JSON.stringify(content._meta?.ui?.csp?.resourceDomains),
      'the ChatGPT CSP alias must allow the same logo origins as the standard declaration',
    )
    const cspOrigins: string[] = content._meta?.ui?.csp?.resourceDomains ?? []
    assert(
      LOGO_ORIGINS.every((origin) => cspOrigins.includes(origin)) && LOGO_CDN.startsWith(`${LOGO_ORIGINS[0]}/`),
      'the generated chain map must only name origins the CSP allows',
    )
    const logoUrls = Object.values(CHAINS)
      .map((chain) => chainLogoUrl(chain))
      .filter(Boolean)
    assert(
      logoUrls.length > 100 && logoUrls.every((url) => cspOrigins.some((origin) => url.startsWith(`${origin}/`))),
      'every chain logo must load from an origin the App CSP allows',
    )
    const testnetsWithExplorer = Object.entries(CHAINS).filter(
      ([dataset, chain]) =>
        chain.explorer && /testnet|sepolia|devnet|holesky|hoodi|amoy|alfajores|moonbase|cardona/.test(dataset),
    )
    assert(
      testnetsWithExplorer.length === 0,
      `testnet datasets must not link to a mainnet explorer: ${testnetsWithExplorer.map(([d]) => d).join(', ')}`,
    )
    assert(
      explorerLink('ethereum-sepolia', 'address', '0x1111111111111111111111111111111111111111') === undefined,
      'testnets have no explorer link',
    )
    const hash = `0x${'ab'.repeat(32)}`
    assert(
      explorerLink('ethereum-mainnet', 'tx', `${hash}:12`)?.url === `https://etherscan.io/tx/${hash}`,
      'a hash:logIndex composite links to its transaction',
    )
    assert(
      explorerLink('polkadot', 'tx', '23456789:3') === undefined,
      'a Substrate block:eventIndex id is not a transaction',
    )
    assert(
      explorerLink('hyperliquid-mainnet', 'tx', '812345678:4') === undefined,
      'a replica block:actionIndex id is not a transaction',
    )
    assert(
      explorerLink('polkadot', 'block', '23456789')?.url === 'https://polkadot.subscan.io/block/23456789',
      'block links stay numeric',
    )
    const signature = '5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW'
    assert(
      explorerLink('solana-mainnet', 'tx', signature)?.url.endsWith(`/tx/${signature}`) === true,
      'a base58 Solana signature links as a transaction',
    )
    assert(
      formatValue('9007199254740993', 'integer') === '9,007,199,254,740,993' &&
        formatValue('43841943497649594000.000000000000000001', 'decimal', 'USDC') ===
          '43,841,943,497,649,594,000.000000000000000001 USDC' &&
        formatValue('0.30000003', 'btc') === '0.30000003 BTC' &&
        formatValue('0.000000009', 'decimal') === '0.000000009' &&
        formatValue(9e-9, 'decimal') === '0.000000009' &&
        formatValue('1234.5', 'decimal') === '1,234.5',
      'App cells must keep exact decimal strings and never show exponent notation',
    )
    assert(
      planFollowup({ intent: 'widen', currentArgs: { network: 'base-mainnet', timeframe: '1h' } }).callArgs
        ?.timeframe === '2h',
      'widen must double a timeframe window with the same argument key',
    )
    assert(
      planFollowup({ intent: 'zoom_in', currentArgs: { network: 'base-mainnet', duration: '24h' } }).callArgs
        ?.duration === '12h',
      'zoom_in must halve a duration window with the same argument key',
    )
    assert(
      content._meta?.ui?.domain === undefined && content._meta?.['openai/widgetDomain'] === undefined,
      'the app must not claim a dedicated origin: a host validates it against its own connector URL and refuses to render on a mismatch',
    )
    for (const retainedUri of RETAINED_ACTIVITY_EXPLORER_RESOURCE_URIS) {
      assert(
        resources.resources.some((entry) => entry.uri === retainedUri),
        `resources/list should retain installed-client App URI ${retainedUri}`,
      )
      const retained = await client.readResource({ uri: retainedUri })
      const retainedContent = retained.contents[0] as Record<string, any> | undefined
      assert(
        retainedContent?.uri === retainedUri &&
          retainedContent.mimeType === MCP_APP_MIME_TYPE &&
          typeof retainedContent.text === 'string' &&
          Buffer.byteLength(retainedContent.text) === ACTIVITY_EXPLORER_BYTES,
        `retained App URI ${retainedUri} should resolve to the current factual App artifact`,
      )
    }

    assert(
      getPortalServerInstructions().includes('SQD Explorer'),
      'an opted-in deployment should tell the model the app exists',
    )

    const declared = classifyUiCapability(
      {
        'io.modelcontextprotocol/clientCapabilities': {
          extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: [MCP_APP_MIME_TYPE] } },
        },
      },
      undefined,
    )
    const unsupported = classifyUiCapability(
      { 'io.modelcontextprotocol/clientCapabilities': { extensions: {} } },
      undefined,
    )
    assert(
      declared === 'declared' &&
        unsupported === 'unsupported' &&
        classifyUiCapability(undefined, undefined) === 'undeclared',
      'capability states should be deterministic and client-name independent',
    )

    recordActivityExplorerResult({
      toolName: 'portal_hyperliquid_get_analytics',
      result: { structuredContent: { answer: 'fixture', overview: { total_fills: 3 } } },
      transport: 'stdio',
      uiCapability: 'declared',
      resultState: 'success',
    })

    const metrics = await register.metrics()
    for (const name of [
      'mcp_app_resource_reads_total',
      'mcp_app_resource_size_bytes',
      'mcp_tool_admission_active_weight',
      'mcp_app_render_payload_bytes',
    ]) {
      assert(metrics.includes(`# HELP ${name} `), `metrics surface should expose ${name}`)
    }
    assert(
      metrics.includes('mcp_app_resource_reads_total{transport="stdio"'),
      'resource reads should complete the app render funnel',
    )
    assert(
      metrics.includes(
        'mcp_app_tool_results_total{tool="portal_hyperliquid_get_analytics",transport="stdio",ui_capability="declared",result_state="success"} 1',
      ),
      'app-enabled results should record capability and outcome',
    )
  } finally {
    await client.close()
    await server.close()
    delete process.env.MCP_APP_ENABLED
  }

  console.log('PASS  the beta app stays opt-in and silent in a default deployment')
  console.log('PASS  a single connection can opt in or out without changing the deployment')
  console.log('PASS  28 tool contracts remain intact with selective app metadata')
  console.log('PASS  versioned self-contained resource exposes exact standard and ChatGPT metadata')
  console.log('PASS  capability states and app runtime metrics are bounded and deterministic')
  console.log('PASS  chart contracts name exactly the interactions the app implements')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
