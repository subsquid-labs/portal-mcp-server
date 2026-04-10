#!/usr/bin/env tsx

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const POLKADOT_OLD_TIMESTAMP_ISO = '2022-04-23T12:03:06Z'
const POLKADOT_OLD_TIMESTAMP_SECONDS = 1650715386
const POLKADOT_RECENT_TIMESTAMP_MS = 1775790360000
const POLKADOT_SAMPLE_FROM_BLOCK = 30736840
const POLKADOT_SAMPLE_TO_BLOCK = 30736842
const POLKADOT_SAMPLE_ADDRESS = '14GfRJRq8Xg6A8zD6p7q4G7L9z1mHqYdQ6LzKQ9M5mK4VqkS'

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`)
  }
}

function getText(result: any): string {
  return result?.content?.map((entry: any) => entry?.text || '').join('\n') || ''
}

function extractJson(text: string): any {
  const jsonStart = text.search(/[\[{]/)
  if (jsonStart === -1) {
    throw new Error(`No JSON found in response: ${text.slice(0, 240)}`)
  }

  return JSON.parse(text.slice(jsonStart))
}

async function callTool(client: Client, name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args })
  const text = getText(result)
  return {
    result,
    text,
    isError: Boolean((result as any).isError) || text.startsWith('Error:'),
  }
}

async function fetchJson(url: string, options?: RequestInit) {
  const response = await fetch(url, options)
  const text = await response.text()
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${url}: ${text.slice(0, 300)}`)
  }
  return JSON.parse(text)
}

async function fetchNdjson(url: string, body: Record<string, unknown>) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${url}: ${text.slice(0, 300)}`)
  }

  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

function assertClearUnsupported(text: string, toolName: string) {
  assert(text.includes(toolName), `${toolName} unsupported response should mention the tool name`)
  assert(/does not support dataset 'polkadot'/i.test(text), `${toolName} unsupported response should mention polkadot clearly`)
  assert(!text.includes("table 'transactions' does not exist"), `${toolName} should not leak raw Portal transactions parse errors`)
  assert(!text.includes("table 'fills' does not exist"), `${toolName} should not leak raw Portal fills parse errors`)
}

async function main() {
  console.log('Starting focused Substrate QA...\n')

  const transport = new StdioClientTransport({
    command: 'node',
    args: ['dist/index.js'],
  })

  const client = new Client({ name: 'substrate-test-runner', version: '1.0.0' })
  await client.connect(transport)

  try {
    const { tools } = await client.listTools()
    const names = new Set(tools.map((tool) => tool.name))
    const substrateNamedTools = tools.filter((tool) => tool.name.includes('substrate')).map((tool) => tool.name)

    console.log(`Server reports ${tools.length} tools`)
    console.log(`Registered Substrate-named tools: ${substrateNamedTools.length > 0 ? substrateNamedTools.join(', ') : '(none)'}\n`)

    for (const requiredTool of [
      'portal_list_networks',
      'portal_get_network_info',
      'portal_get_head',
      'portal_substrate_query_events',
      'portal_substrate_query_calls',
      'portal_substrate_get_analytics',
      'portal_debug_query_blocks',
      'portal_debug_resolve_time_to_block',
    ]) {
      assert(names.has(requiredTool), `Expected ${requiredTool} to be registered`)
    }
    assert(substrateNamedTools.length === 3, 'Expected exactly 3 Substrate-named public tools')

    const listNetworks = await callTool(client, 'portal_list_networks', { vm: 'substrate', network_type: 'mainnet', limit: 10 })
    assert(!listNetworks.isError, 'portal_list_networks should succeed for vm=substrate')
    const listData = extractJson(listNetworks.text)
    assert(Array.isArray(listData.items) && listData.items.length > 0, 'portal_list_networks should return substrate items')
    assert(listData.items.every((item: any) => item.vm === 'substrate'), 'Substrate list filter should only return substrate networks')
    assert(listData.items.every((item: any) => item.real_time === false), 'Current Substrate list results should advertise non-real-time indexing')
    assert(listData.items.some((item: any) => String(item.network).includes('polkadot')), 'Substrate list should include at least one polkadot-family network')
    console.log('PASS  portal_list_networks -> substrate discovery works')

    const networkInfo = await callTool(client, 'portal_get_network_info', { network: 'polkadot' })
    assert(!networkInfo.isError, 'portal_get_network_info should succeed for polkadot')
    const infoData = extractJson(networkInfo.text)
    assert(infoData.vm === 'substrate', 'polkadot should resolve to vm=substrate')
    assert(infoData.real_time === false, 'polkadot should advertise non-real-time indexing')
    console.log('PASS  portal_get_network_info -> substrate metadata is correct')

    const head = await callTool(client, 'portal_get_head', { network: 'polkadot' })
    assert(!head.isError, 'portal_get_head should succeed for polkadot')
    const headData = extractJson(head.text)
    assert(typeof headData.number === 'number' && headData.number > 1_000_000, 'polkadot head should be a recent block number')
    console.log(`PASS  portal_get_head -> head ${headData.number}`)

    const olderLookup = await callTool(client, 'portal_debug_resolve_time_to_block', {
      network: 'polkadot',
      timestamp: POLKADOT_OLD_TIMESTAMP_ISO,
    })
    assert(!olderLookup.isError, 'older Substrate timestamp lookup should succeed')
    const olderLookupData = extractJson(olderLookup.text)
    assert(olderLookupData.resolution === 'exact', 'older Substrate timestamp lookup should be exact')
    assert(olderLookupData.block_number === 9992550, 'older Substrate timestamp lookup should resolve expected block')
    console.log('PASS  portal_debug_resolve_time_to_block -> older ISO timestamp resolves exactly')

    const millisLookup = await callTool(client, 'portal_debug_resolve_time_to_block', {
      network: 'polkadot',
      timestamp: POLKADOT_RECENT_TIMESTAMP_MS,
    })
    assert(!millisLookup.isError, 'millisecond Substrate timestamp lookup should succeed')
    const millisLookupData = extractJson(millisLookup.text)
    assert(millisLookupData.resolution === 'exact', 'millisecond Substrate timestamp lookup should stay exact after normalization')
    assert(millisLookupData.timestamp === 1775790360, 'millisecond timestamp input should normalize to seconds')
    console.log('PASS  portal_debug_resolve_time_to_block -> millisecond input is normalized correctly')

    const blockQuery = await callTool(client, 'portal_debug_query_blocks', {
      network: 'polkadot',
      from_block: POLKADOT_SAMPLE_FROM_BLOCK,
      to_block: POLKADOT_SAMPLE_TO_BLOCK,
      limit: 3,
    })
    assert(!blockQuery.isError, 'portal_debug_query_blocks should succeed for polkadot')
    const blockData = extractJson(blockQuery.text)
    assert(Array.isArray(blockData.items) && blockData.items.length === 3, 'Substrate block query should return the requested sample blocks')
    assert(blockData.items[0]?.header?.number === POLKADOT_SAMPLE_FROM_BLOCK, 'Substrate block query should preserve the first requested block number')
    assert(blockData.items[0]?.header?.timestamp > 1_000_000_000_000, 'Substrate block query should now use native millisecond timestamps')
    console.log('PASS  portal_debug_query_blocks -> substrate blocks use the native substrate query path')

    const eventsResult = await callTool(client, 'portal_substrate_query_events', {
      network: 'polkadot',
      from_block: POLKADOT_SAMPLE_FROM_BLOCK,
      to_block: POLKADOT_SAMPLE_TO_BLOCK,
      event_names: ['ParaInclusion.CandidateIncluded'],
      include_extrinsic: true,
      include_call: true,
      limit: 3,
    })
    assert(!eventsResult.isError, 'portal_substrate_query_events should succeed for polkadot')
    const eventsData = extractJson(eventsResult.text)
    assert(Array.isArray(eventsData.items) && eventsData.items.length > 0, 'portal_substrate_query_events should return rows')
    assert(eventsData.items.every((item: any) => item.event_name === 'ParaInclusion.CandidateIncluded' || item.name === 'ParaInclusion.CandidateIncluded'), 'event filter should be respected')
    assert(eventsData._execution?.response_format === 'compact', 'portal_substrate_query_events should now default to compact mode')
    assert(eventsData.items[0]?.extrinsic !== undefined, 'portal_substrate_query_events should attach inline extrinsic context')
    assert(eventsData.items[0]?.call !== undefined, 'portal_substrate_query_events should attach inline call context')
    assert(eventsData._ordering?.kind === 'chronological_page', 'portal_substrate_query_events should include chronological ordering metadata')
    console.log('PASS  portal_substrate_query_events -> filtered events and inline context work')

    const eventsSummary = await callTool(client, 'portal_substrate_query_events', {
      network: 'polkadot',
      from_block: POLKADOT_SAMPLE_FROM_BLOCK,
      to_block: POLKADOT_SAMPLE_TO_BLOCK,
      response_format: 'summary',
      limit: 10,
    })
    assert(!eventsSummary.isError, 'portal_substrate_query_events summary mode should succeed')
    const eventsSummaryData = extractJson(eventsSummary.text)
    assert(eventsSummaryData.total_events > 0, 'portal_substrate_query_events summary should report total_events')
    console.log('PASS  portal_substrate_query_events -> summary mode is useful')

    const callsResult = await callTool(client, 'portal_substrate_query_calls', {
      network: 'polkadot',
      from_block: POLKADOT_SAMPLE_FROM_BLOCK,
      to_block: POLKADOT_SAMPLE_TO_BLOCK,
      call_names: ['ParaInherent.enter'],
      include_extrinsic: true,
      include_events: true,
      limit: 3,
    })
    assert(!callsResult.isError, 'portal_substrate_query_calls should succeed for polkadot')
    const callsData = extractJson(callsResult.text)
    assert(Array.isArray(callsData.items) && callsData.items.length > 0, 'portal_substrate_query_calls should return rows')
    assert(callsData.items.every((item: any) => item.call_name === 'ParaInherent.enter' || item.name === 'ParaInherent.enter'), 'call filter should be respected')
    assert(callsData._execution?.response_format === 'compact', 'portal_substrate_query_calls should now default to compact mode')
    assert(callsData.items[0]?.extrinsic !== undefined, 'portal_substrate_query_calls should attach inline extrinsic context')
    assert(Array.isArray(callsData.items[0]?.events) && callsData.items[0].events.length > 0, 'portal_substrate_query_calls should attach emitted events')
    console.log('PASS  portal_substrate_query_calls -> filtered calls and emitted events work')

    const callsCompact = await callTool(client, 'portal_substrate_query_calls', {
      network: 'polkadot',
      from_block: POLKADOT_SAMPLE_FROM_BLOCK,
      to_block: POLKADOT_SAMPLE_TO_BLOCK,
      response_format: 'compact',
      limit: 3,
    })
    assert(!callsCompact.isError, 'portal_substrate_query_calls compact mode should succeed')
    const callsCompactData = extractJson(callsCompact.text)
    assert(Array.isArray(callsCompactData.items) && callsCompactData.items.length > 0, 'portal_substrate_query_calls compact mode should still return rows')
    assert(callsCompactData.items[0]?.call_name !== undefined, 'compact Substrate call rows should keep call_name')
    console.log('PASS  portal_substrate_query_calls -> compact mode stays readable')

    const analyticsResult = await callTool(client, 'portal_substrate_get_analytics', {
      network: 'polkadot',
      from_block: POLKADOT_SAMPLE_FROM_BLOCK,
      to_block: POLKADOT_SAMPLE_TO_BLOCK,
    })
    assert(!analyticsResult.isError, 'portal_substrate_get_analytics should succeed for polkadot')
    const analyticsData = extractJson(analyticsResult.text)
    assert(analyticsData.overview?.network === 'polkadot', 'portal_substrate_get_analytics should report the network')
    assert(Array.isArray(analyticsData.top_events) && analyticsData.top_events.length > 0, 'portal_substrate_get_analytics should rank top events')
    assert(Array.isArray(analyticsData.top_calls) && analyticsData.top_calls.length > 0, 'portal_substrate_get_analytics should rank top calls')
    assert(Array.isArray(analyticsData.tables) && analyticsData.tables.some((table: any) => table?.id === 'top_events'), 'portal_substrate_get_analytics should expose top_events table metadata')
    assert(Array.isArray(analyticsData.tables) && analyticsData.tables.some((table: any) => table?.id === 'top_calls'), 'portal_substrate_get_analytics should expose top_calls table metadata')
    console.log('PASS  portal_substrate_get_analytics -> dashboard payload is live')

    const analyticsSummary = await callTool(client, 'portal_substrate_get_analytics', {
      network: 'polkadot',
      from_block: POLKADOT_SAMPLE_FROM_BLOCK,
      to_block: POLKADOT_SAMPLE_TO_BLOCK,
      response_format: 'summary',
    })
    assert(!analyticsSummary.isError, 'portal_substrate_get_analytics summary mode should succeed')
    const analyticsSummaryData = extractJson(analyticsSummary.text)
    assert(analyticsSummaryData.overview?.total_events > 0, 'portal_substrate_get_analytics summary should report event totals')
    console.log('PASS  portal_substrate_get_analytics -> summary mode is useful')

    for (const [toolName, args] of [
      ['portal_get_recent_activity', { network: 'polkadot', timeframe: '100', limit: 5 }],
      ['portal_get_time_series', { network: 'polkadot', metric: 'transaction_count', duration: '24h', interval: '1h' }],
      ['portal_get_wallet_summary', { network: 'polkadot', address: POLKADOT_SAMPLE_ADDRESS, timeframe: '24h' }],
    ] as const) {
      const response = await callTool(client, toolName, args)
      assert(response.isError, `${toolName} should still fail clearly on Substrate for now`)
      assertClearUnsupported(response.text, toolName)
      console.log(`PASS  ${toolName} -> unsupported flow still fails clearly`)
    }

    const directTimestamp = await fetchJson(
      `https://portal.sqd.dev/datasets/polkadot/timestamps/${POLKADOT_OLD_TIMESTAMP_SECONDS}/block`,
    )
    assert(directTimestamp.block_number === 9992550, 'direct substrate timestamp endpoint should resolve the older sample block')
    console.log('PASS  direct Portal timestamp lookup -> backend substrate timestamps are live')

    const directEvents = await fetchNdjson('https://portal.sqd.dev/datasets/polkadot/stream', {
      type: 'substrate',
      fromBlock: POLKADOT_SAMPLE_FROM_BLOCK,
      toBlock: POLKADOT_SAMPLE_TO_BLOCK,
      fields: {
        block: { number: true, timestamp: true },
        event: { name: true },
      },
      events: [{}],
    })
    assert(directEvents.length > 0, 'direct substrate events query should return blocks')
    assert(directEvents.some((block: any) => Array.isArray(block.events) && block.events.length > 0), 'direct substrate events query should return at least one event')
    console.log('PASS  direct Portal events query -> substrate events are available')

    const directCalls = await fetchNdjson('https://portal.sqd.dev/datasets/polkadot/stream', {
      type: 'substrate',
      fromBlock: POLKADOT_SAMPLE_FROM_BLOCK,
      toBlock: POLKADOT_SAMPLE_TO_BLOCK,
      fields: {
        block: { number: true, timestamp: true },
        call: { name: true, success: true },
      },
      calls: [{}],
    })
    assert(directCalls.length > 0, 'direct substrate calls query should return blocks')
    assert(directCalls.some((block: any) => Array.isArray(block.calls) && block.calls.length > 0), 'direct substrate calls query should return at least one call')
    console.log('PASS  direct Portal calls query -> substrate calls are available')

    console.log('\nSubstrate QA passed.')
  } finally {
    await client.close()
  }
}

main().catch((error) => {
  console.error(`FAIL: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
