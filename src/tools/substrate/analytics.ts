import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { resolveDataset, validateBlockRange } from '../../cache/datasets.js'
import { PORTAL_URL } from '../../constants/index.js'
import { detectChainType } from '../../helpers/chain.js'
import { buildTableDescriptor } from '../../helpers/chart-metadata.js'
import { createUnsupportedChainError } from '../../helpers/errors.js'
import { portalFetchStreamRangeVisit } from '../../helpers/fetch.js'
import { formatResult } from '../../helpers/format.js'
import { buildAnalysisCoverage, buildQueryFreshness } from '../../helpers/result-metadata.js'
import { resolveTimeframeOrBlocks, type TimestampInput } from '../../helpers/timeframe.js'
import { buildExecutionMetadata, buildToolDescription } from '../../helpers/tool-ux.js'
import { buildMetricCard, buildPortalUi, buildRankedBarsPanel, buildTablePanel } from '../../helpers/ui-metadata.js'

import { buildSubstrateBlockFields, buildSubstrateCallFields, buildSubstrateEventFields, buildSubstrateExtrinsicFields } from '../../helpers/fields.js'
import type { ResponseFormat } from '../../helpers/response-modes.js'
import { SUBSTRATE_INDEXING_NOTICE, buildSubstrateWindowLabel } from './shared.js'

type RankedCountRow = {
  rank: number
  name: string
  count: number
  percentage: number
}

const FAST_MODE_MAX_BLOCKS = 1_500
const DEEP_MODE_MAX_BLOCKS = 6_000
const DEFAULT_TIMEFRAME = '1h'

function toBigInt(value: unknown): bigint {
  if (typeof value === 'bigint') return value
  if (typeof value === 'number' && Number.isFinite(value)) return BigInt(Math.trunc(value))
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return BigInt(value.trim())
  return 0n
}

function pct(part: number, total: number): number {
  if (total <= 0) return 0
  return Number(((part / total) * 100).toFixed(2))
}

function rankCounts(counts: Map<string, number>, total: number, limit: number): RankedCountRow[] {
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, limit)
    .map(([name, count], index) => ({
      rank: index + 1,
      name,
      count,
      percentage: pct(count, total),
    }))
}

function formatSubstrateAnalyticsResponse(response: Record<string, any>, responseFormat: ResponseFormat) {
  if (responseFormat === 'full') {
    return response
  }

  if (responseFormat === 'summary') {
    return {
      overview: {
        network: response.overview?.network,
        mode: response.overview?.mode,
        blocks_analyzed: response.overview?.blocks_analyzed,
        sampled: response.overview?.sampled,
        total_events: response.activity?.total_events,
        total_calls: response.activity?.total_calls,
        total_extrinsics: response.extrinsics?.total_extrinsics,
        successful_calls: response.activity?.successful_calls,
        successful_extrinsics: response.extrinsics?.successful_extrinsics,
      },
      ...(response.top_events?.[0] ? { top_event: response.top_events[0] } : {}),
      ...(response.top_calls?.[0] ? { top_call: response.top_calls[0] } : {}),
    }
  }

  return {
    overview: response.overview,
    activity: response.activity,
    extrinsics: response.extrinsics,
    top_events: response.top_events,
    top_calls: response.top_calls,
  }
}

function decoratePresentation(response: Record<string, any>, dataset: string, windowLabel: string) {
  const tables = []

  if (Array.isArray(response.top_events)) {
    tables.push(buildTableDescriptor({
      id: 'top_events',
      dataKey: 'top_events',
      rowCount: response.top_events.length,
      title: 'Top events',
      subtitle: 'Ranked by event count in the selected window',
      keyField: 'name',
      defaultSort: { key: 'rank', direction: 'asc' },
      dense: true,
      columns: [
        { key: 'rank', label: 'Rank', kind: 'rank', format: 'integer', align: 'right' },
        { key: 'name', label: 'Event', kind: 'dimension' },
        { key: 'count', label: 'Count', kind: 'metric', format: 'integer', align: 'right' },
        { key: 'percentage', label: 'Share', kind: 'metric', format: 'percent', unit: '%', align: 'right' },
      ],
    }))
  }

  if (Array.isArray(response.top_calls)) {
    tables.push(buildTableDescriptor({
      id: 'top_calls',
      dataKey: 'top_calls',
      rowCount: response.top_calls.length,
      title: 'Top calls',
      subtitle: 'Ranked by call count in the selected window',
      keyField: 'name',
      defaultSort: { key: 'rank', direction: 'asc' },
      dense: true,
      columns: [
        { key: 'rank', label: 'Rank', kind: 'rank', format: 'integer', align: 'right' },
        { key: 'name', label: 'Call', kind: 'dimension' },
        { key: 'count', label: 'Count', kind: 'metric', format: 'integer', align: 'right' },
        { key: 'percentage', label: 'Share', kind: 'metric', format: 'percent', unit: '%', align: 'right' },
      ],
    }))
  }

  return {
    response: {
      ...response,
      ...(tables.length > 0 ? { tables } : {}),
    },
    ui: buildPortalUi({
      version: 'portal_ui_v1',
      layout: 'dashboard',
      density: 'compact',
      design_intent: 'analytics_dashboard',
      headline: {
        title: `Substrate analytics on ${dataset}`,
        subtitle: windowLabel,
      },
      metric_cards: [
        buildMetricCard({ id: 'events', label: 'Events', value_path: 'activity.total_events', format: 'integer', emphasis: 'primary' }),
        buildMetricCard({ id: 'calls', label: 'Calls', value_path: 'activity.total_calls', format: 'integer' }),
        buildMetricCard({ id: 'extrinsics', label: 'Extrinsics', value_path: 'extrinsics.total_extrinsics', format: 'integer' }),
        buildMetricCard({ id: 'call-success', label: 'Call success', value_path: 'activity.call_success_rate', format: 'percent', unit: '%' }),
      ],
      panels: [
        ...(Array.isArray(response.top_events)
          ? [buildRankedBarsPanel({
              id: 'event-bars',
              kind: 'ranked_bars_panel',
              title: 'Top events',
              subtitle: 'Highest-frequency event names in the selected window.',
              data_key: 'top_events',
              category_key: 'name',
              value_key: 'count',
              rank_key: 'rank',
              value_format: 'integer',
              emphasis: 'primary',
            })]
          : []),
        ...(Array.isArray(response.top_calls)
          ? [buildRankedBarsPanel({
              id: 'call-bars',
              kind: 'ranked_bars_panel',
              title: 'Top calls',
              subtitle: 'Highest-frequency call names in the selected window.',
              data_key: 'top_calls',
              category_key: 'name',
              value_key: 'count',
              rank_key: 'rank',
              value_format: 'integer',
            })]
          : []),
        ...tables.map((table) => buildTablePanel({
          id: `${table.id}-panel`,
          kind: 'table_panel',
          title: table.title ?? table.id,
          subtitle: table.subtitle,
          table_id: table.id,
        })),
      ],
      follow_up_actions: [
        { label: 'Show ranked event rows', intent: 'show_raw', target: 'top_events' },
        { label: 'Show ranked call rows', intent: 'show_raw', target: 'top_calls' },
      ],
    }),
  }
}

export function registerSubstrateAnalyticsTool(server: McpServer) {
  server.tool(
    'portal_substrate_get_analytics',
    buildToolDescription('portal_substrate_get_analytics'),
    {
      network: z.string().default('polkadot').describe('Substrate network name (default: polkadot)'),
      timeframe: z.string().optional().describe("Time range like '1h', '6h', or '24h'. Default: '1h'"),
      mode: z.enum(['fast', 'deep']).optional().default('fast').describe('fast = cap the scanned block window for responsiveness, deep = analyze a larger recent window'),
      from_block: z.number().optional().describe('Starting block number (use this OR timeframe)'),
      to_block: z.number().optional().describe('Ending block number'),
      from_timestamp: z
        .union([z.number(), z.string()])
        .optional()
        .describe('Natural start time like "6h ago", ISO datetime, or Unix timestamp'),
      to_timestamp: z
        .union([z.number(), z.string()])
        .optional()
        .describe('Natural end time like "now", ISO datetime, or Unix timestamp'),
      response_format: z.enum(['full', 'compact', 'summary']).optional().default('full').describe("Response format: 'summary' (headline metrics only), 'compact' (core sections), 'full' (full dashboard payload)"),
      section_limit: z.number().optional().default(10).describe('Max rows to keep in ranked event and call sections'),
    },
    async ({ network, timeframe, mode, from_block, to_block, from_timestamp, to_timestamp, response_format, section_limit }) => {
      const queryStartTime = Date.now()
      let dataset = await resolveDataset(network)
      const chainType = detectChainType(dataset)

      if (chainType !== 'substrate') {
        throw createUnsupportedChainError({
          toolName: 'portal_substrate_get_analytics',
          dataset,
          actualChainType: chainType,
          supportedChains: ['substrate'],
          suggestions: [
            'Use portal_solana_get_analytics for Solana snapshots.',
            'Use portal_bitcoin_get_analytics for Bitcoin snapshots.',
            'Use portal_evm_get_analytics for EVM network analytics.',
          ],
        })
      }

      if (!timeframe && from_block === undefined && from_timestamp === undefined) {
        timeframe = DEFAULT_TIMEFRAME
      }

      const resolvedWindow = await resolveTimeframeOrBlocks({
        dataset,
        timeframe,
        from_block,
        to_block,
        from_timestamp: from_timestamp as TimestampInput | undefined,
        to_timestamp: to_timestamp as TimestampInput | undefined,
      })
      const requestedFromBlock = resolvedWindow.from_block

      const { validatedToBlock: endBlock, head } = await validateBlockRange(
        dataset,
        requestedFromBlock,
        resolvedWindow.to_block ?? Number.MAX_SAFE_INTEGER,
        false,
      )

      const requestedBlocks = endBlock - requestedFromBlock + 1
      const maxBlocks = mode === 'deep' ? DEEP_MODE_MAX_BLOCKS : FAST_MODE_MAX_BLOCKS
      const effectiveFrom = requestedBlocks > maxBlocks ? endBlock - maxBlocks + 1 : requestedFromBlock
      const sampled = effectiveFrom > requestedFromBlock
      const notices = [SUBSTRATE_INDEXING_NOTICE]
      if (sampled) {
        notices.push(`Requested ${requestedBlocks.toLocaleString()} blocks, so ${mode} mode analyzed the most recent ${maxBlocks.toLocaleString()} blocks.`)
      }

      const eventCounts = new Map<string, number>()
      const callCounts = new Map<string, number>()
      let totalEvents = 0
      let totalCalls = 0
      let successfulCalls = 0
      const extrinsicKeys = new Set<string>()
      let successfulExtrinsics = 0
      let failedExtrinsics = 0
      let totalFees = 0n

      const eventQuery = {
        type: 'substrate',
        fromBlock: effectiveFrom,
        toBlock: endBlock,
        includeAllBlocks: true,
        fields: {
          block: buildSubstrateBlockFields(),
          event: buildSubstrateEventFields(),
        },
        events: [{}],
      }
      const callQuery = {
        type: 'substrate',
        fromBlock: effectiveFrom,
        toBlock: endBlock,
        includeAllBlocks: true,
        fields: {
          block: buildSubstrateBlockFields(),
          call: buildSubstrateCallFields(),
          extrinsic: buildSubstrateExtrinsicFields(),
        },
        calls: [{ extrinsic: true }],
      }

      await Promise.all([
        portalFetchStreamRangeVisit(
          `${PORTAL_URL}/datasets/${dataset}/stream`,
          eventQuery,
          {
            maxBytes: 150 * 1024 * 1024,
            onRecord: async (record) => {
              const block = record as { events?: Array<{ name?: string }> }
              for (const event of block.events ?? []) {
                totalEvents++
                const name = String(event.name || 'unknown')
                eventCounts.set(name, (eventCounts.get(name) || 0) + 1)
              }
            },
          },
        ),
        portalFetchStreamRangeVisit(
          `${PORTAL_URL}/datasets/${dataset}/stream`,
          callQuery,
          {
            maxBytes: 150 * 1024 * 1024,
            onRecord: async (record) => {
              const block = record as {
                header?: { number?: number }
                calls?: Array<{ name?: string; success?: boolean }>
                extrinsics?: Array<{ index?: number; success?: boolean; fee?: string | null }>
              }
              const blockNumber = block.header?.number

              for (const call of block.calls ?? []) {
                totalCalls++
                if (call.success !== false) successfulCalls++
                const name = String(call.name || 'unknown')
                callCounts.set(name, (callCounts.get(name) || 0) + 1)
              }

              for (const extrinsic of block.extrinsics ?? []) {
                if (blockNumber === undefined || extrinsic.index === undefined) continue
                const key = `${blockNumber}:${extrinsic.index}`
                if (extrinsicKeys.has(key)) continue
                extrinsicKeys.add(key)
                if (extrinsic.success === false) {
                  failedExtrinsics++
                } else {
                  successfulExtrinsics++
                }
                totalFees += toBigInt(extrinsic.fee)
              }
            },
          },
        ),
      ])

      const topEvents = rankCounts(eventCounts, totalEvents, section_limit)
      const topCalls = rankCounts(callCounts, totalCalls, section_limit)
      const totalExtrinsics = extrinsicKeys.size
      const response = {
        overview: {
          network: dataset,
          mode,
          window: buildSubstrateWindowLabel({
            timeframe,
            from_timestamp: from_timestamp as TimestampInput | undefined,
            to_timestamp: to_timestamp as TimestampInput | undefined,
            from_block: effectiveFrom,
            to_block: endBlock,
            resolvedWindow,
          }),
          blocks_analyzed: endBlock - effectiveFrom + 1,
          requested_blocks: requestedBlocks,
          sampled,
        },
        activity: {
          total_events: totalEvents,
          total_calls: totalCalls,
          successful_calls: successfulCalls,
          failed_calls: Math.max(0, totalCalls - successfulCalls),
          call_success_rate: pct(successfulCalls, totalCalls),
          unique_event_names: eventCounts.size,
          unique_call_names: callCounts.size,
        },
        extrinsics: {
          total_extrinsics: totalExtrinsics,
          successful_extrinsics: successfulExtrinsics,
          failed_extrinsics: failedExtrinsics,
          extrinsic_success_rate: pct(successfulExtrinsics, totalExtrinsics),
          total_fees_planck: totalFees.toString(),
        },
        top_events: topEvents,
        top_calls: topCalls,
      }

      const formatted = formatSubstrateAnalyticsResponse(response, response_format as ResponseFormat)
      const windowLabel = response.overview.window
      const summary = `Analyzed ${response.activity.total_events.toLocaleString()} events and ${response.activity.total_calls.toLocaleString()} calls on ${dataset} across ${windowLabel}.`

      if (response_format === 'full') {
        const decorated = decoratePresentation(formatted, dataset, windowLabel)
        return formatResult(decorated.response, summary, {
          toolName: 'portal_substrate_get_analytics',
          notices,
          freshness: buildQueryFreshness({
            finality: 'latest',
            headBlockNumber: head.number,
            windowToBlock: endBlock,
            resolvedWindow,
          }),
          coverage: buildAnalysisCoverage({
            windowFromBlock: requestedFromBlock,
            windowToBlock: endBlock,
            analyzedFromBlock: effectiveFrom,
            analyzedToBlock: endBlock,
          }),
          execution: buildExecutionMetadata({
            mode,
            response_format,
            from_block: effectiveFrom,
            to_block: endBlock,
            range_kind: resolvedWindow.range_kind,
            notes: [
              'Substrate analytics combines one event scan and one call/extrinsic scan across the selected window.',
            ],
          }),
          ui: decorated.ui,
          llm: {
            answer_sequence: ['overview', 'activity.total_events', 'activity.total_calls', 'extrinsics.total_extrinsics', 'top_events', 'top_calls'],
            parser_notes: [
              'overview gives the actual analyzed window; check sampled to see whether fast/deep mode capped the requested range.',
              'top_events and top_calls are already ranked descending by count, so rank 1 is the most frequent item in the selected window.',
            ],
          },
          metadata: {
            network: dataset,
            dataset,
            from_block: effectiveFrom,
            to_block: endBlock,
            query_start_time: queryStartTime,
          },
        })
      }

      return formatResult(formatted, summary, {
        toolName: 'portal_substrate_get_analytics',
        notices,
        freshness: buildQueryFreshness({
          finality: 'latest',
          headBlockNumber: head.number,
          windowToBlock: endBlock,
          resolvedWindow,
        }),
        coverage: buildAnalysisCoverage({
          windowFromBlock: requestedFromBlock,
          windowToBlock: endBlock,
          analyzedFromBlock: effectiveFrom,
          analyzedToBlock: endBlock,
        }),
        execution: buildExecutionMetadata({
          mode,
          response_format,
          from_block: effectiveFrom,
          to_block: endBlock,
          range_kind: resolvedWindow.range_kind,
          notes: [
            'Substrate analytics combines one event scan and one call/extrinsic scan across the selected window.',
          ],
        }),
        metadata: {
          network: dataset,
          dataset,
          from_block: effectiveFrom,
          to_block: endBlock,
          query_start_time: queryStartTime,
        },
      })
    },
  )
}

