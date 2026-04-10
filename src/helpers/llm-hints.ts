import type {
  CandlestickChartDescriptor,
  ChartDescriptor,
  TableDescriptor,
  TableValueFormat,
  TimeSeriesChartDescriptor,
} from './chart-metadata.js'
import type { PortalUiSpec, UiFollowUpAction, UiMetricCard, UiPanel } from './ui-metadata.js'

type RecordLike = Record<string, unknown>

const SUMMARY_SECTION_KEYS = ['summary', 'overview', 'activity', 'assets', 'market_context', 'guidance', 'evm', 'solana', 'bitcoin', 'hyperliquid', 'liquidations']
const RESERVED_TOP_LEVEL_KEYS = new Set(['chart', 'tables', 'gap_diagnostics', 'answer', 'display', 'next_steps', 'technical_details'])
const NORMALIZED_ALIAS_KEYS = [
  'chain_kind',
  'record_type',
  'primary_id',
  'tx_hash',
  'timestamp',
  'timestamp_human',
  'sender',
  'recipient',
  'block_number',
]

export interface LlmOverrides {
  primary_path?: string
  primary_kind?: string
  answer_sequence?: string[]
  parser_notes?: string[]
}

interface LlmMetricCardHint {
  id?: string
  label: string
  value_path: string
  display_value?: string
  emphasis?: 'primary' | 'secondary'
}

interface LlmHeadlineHint {
  title?: string
  subtitle?: string
  summary?: string
}

interface LlmSectionHint {
  path: string
  kind: string
  title?: string
  row_count?: number
  priority?: 'primary' | 'secondary' | 'supporting'
  use_for?: string
}

interface LlmChartHint {
  path: 'chart'
  kind: ChartDescriptor['kind']
  title?: string
  data_path: string
  x_key: string
  y_keys: string[]
  row_count?: number
  recommended_visual?: string
  tooltip_fields?: string[]
}

interface LlmTableHint {
  id: string
  title?: string
  data_path: string
  row_count: number
  key_field?: string
  default_sort?: TableDescriptor['default_sort']
  columns: Array<{
    key: string
    label: string
    path?: string
    kind: string
    format?: TableValueFormat
    unit?: string
  }>
}

interface LlmViewHint {
  kind: string
  title?: string
  source_path?: string
  data_path?: string
  emphasis?: 'primary' | 'secondary'
}

interface LlmPreviewCell {
  label: string
  value_path: string
  display_value?: string
}

interface LlmPreviewRow {
  key?: string
  label?: string
  cells: LlmPreviewCell[]
}

interface LlmPrimaryPreview {
  path: string
  selection: 'latest_row' | 'top_rows' | 'sample_rows' | 'summary_fields'
  row_count?: number
  rows?: LlmPreviewRow[]
  fields?: LlmPreviewCell[]
}

export interface PortalLlmHints {
  version: 'portal_llm_v1'
  primary_path: string
  primary_kind: string
  answer_sequence: string[]
  headline?: LlmHeadlineHint
  metric_cards?: LlmMetricCardHint[]
  chart?: LlmChartHint
  tables?: LlmTableHint[]
  sections: LlmSectionHint[]
  recommended_views: LlmViewHint[]
  primary_preview?: LlmPrimaryPreview
  normalized_fields?: string[]
  follow_up?: {
    continue_cursor_path?: string
    actions?: Array<{
      label: string
      intent: UiFollowUpAction['intent']
      target?: string
    }>
  }
  parser_notes?: string[]
}

function isRecord(value: unknown): value is RecordLike {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : []
}

function getByPath(value: unknown, path?: string): unknown {
  if (!path) return value

  const tokens = path
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .map((token) => token.trim())
    .filter(Boolean)

  let current: unknown = value
  for (const token of tokens) {
    if (!isRecord(current) && !Array.isArray(current)) {
      return undefined
    }
    current = (current as Record<string, unknown>)[token]
  }

  return current
}

function formatScalar(value: unknown, format?: TableValueFormat, unit?: string): string | undefined {
  if (value === undefined || value === null) return undefined

  if (format === 'address') {
    const text = String(value)
    return text.length > 18 ? `${text.slice(0, 8)}...${text.slice(-6)}` : text
  }

  if (format === 'timestamp_human') {
    return String(value)
  }

  const numeric = typeof value === 'number' ? value : Number(value)
  const hasNumeric = Number.isFinite(numeric)

  if (format === 'currency_usd' && hasNumeric) {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      maximumFractionDigits: Math.abs(numeric) >= 100 ? 0 : 2,
    }).format(numeric)
  }

  if (format === 'percent' && hasNumeric) {
    return `${numeric.toLocaleString('en-US', { maximumFractionDigits: 2 })}%`
  }

  if (format === 'compact_number' && hasNumeric) {
    return new Intl.NumberFormat('en-US', {
      notation: 'compact',
      maximumFractionDigits: 2,
    }).format(numeric)
  }

  if (format === 'scientific' && hasNumeric) {
    return numeric.toExponential(4)
  }

  if (format === 'integer' && hasNumeric) {
    return Math.round(numeric).toLocaleString('en-US')
  }

  if (format === 'btc' && hasNumeric) {
    return `${numeric.toFixed(8)} BTC`
  }

  if (format === 'gwei' && hasNumeric) {
    return `${numeric.toLocaleString('en-US', { maximumFractionDigits: 2 })} gwei`
  }

  if (hasNumeric) {
    const formatted = numeric.toLocaleString('en-US', { maximumFractionDigits: Math.abs(numeric) >= 100 ? 2 : 4 })
    return unit ? `${formatted} ${unit}` : formatted
  }

  return unit ? `${String(value)} ${unit}` : String(value)
}

function inferArrayKind(path: string, chartDataPath?: string): string {
  if (path === chartDataPath) {
    return 'chart_data'
  }
  if (path.includes('ohlc')) return 'candles'
  if (path.includes('recent_trades')) return 'records'
  if (path.includes('query_suggestions')) return 'actions'
  if (path.endsWith('.items') || path === 'items') return 'records'
  if (path.includes('series') || path.includes('bucket')) return 'time_series'
  if (path.includes('top_') || path.includes('volume_by_')) return 'ranked_list'
  return 'rows'
}

function buildMetricCardHints(payload: RecordLike, ui?: PortalUiSpec): LlmMetricCardHint[] {
  return asArray<UiMetricCard>(ui?.metric_cards)
    .slice(0, 8)
    .map((card) => {
      const rawValue = getByPath(payload, card.value_path)
      const displayValue = formatScalar(rawValue, card.format, card.unit)

      return {
        ...(card.id ? { id: card.id } : {}),
        label: card.label,
        value_path: card.value_path,
        ...(displayValue ? { display_value: displayValue } : {}),
        ...(card.emphasis ? { emphasis: card.emphasis } : {}),
      }
    })
}

function buildHeadline(payload: RecordLike, ui?: PortalUiSpec): LlmHeadlineHint | undefined {
  const title = ui?.headline?.title
  const subtitle = ui?.headline?.subtitle
  const summary =
    typeof payload.answer === 'string'
      ? payload.answer
      : typeof payload._summary === 'string'
        ? payload._summary
        : undefined

  if (!title && !subtitle && !summary) return undefined

  return {
    ...(title ? { title } : {}),
    ...(subtitle ? { subtitle } : {}),
    ...(summary ? { summary } : {}),
  }
}

function buildChartHint(payload: RecordLike): LlmChartHint | undefined {
  const chart = payload.chart
  if (!isRecord(chart) || typeof chart.data_key !== 'string' || typeof chart.kind !== 'string') {
    return undefined
  }

  const dataRows = getByPath(payload, chart.data_key)
  const rowCount = Array.isArray(dataRows) ? dataRows.length : undefined
  const tooltipFields =
    isRecord(chart.tooltip)
      ? asArray<RecordLike>(chart.tooltip.fields).map((field) => String(field.label ?? field.key ?? '')).filter(Boolean)
      : []

  if (chart.kind === 'candlestick') {
    const descriptor = chart as unknown as CandlestickChartDescriptor
    return {
      path: 'chart',
      kind: 'candlestick',
      ...(descriptor.title ? { title: descriptor.title } : {}),
      data_path: descriptor.data_key,
      x_key: descriptor.x_field,
      y_keys: [
        descriptor.candle_fields.open,
        descriptor.candle_fields.high,
        descriptor.candle_fields.low,
        descriptor.candle_fields.close,
        ...(descriptor.volume_field ? [descriptor.volume_field] : []),
      ],
      ...(rowCount !== undefined ? { row_count: rowCount } : {}),
      ...(tooltipFields.length > 0 ? { tooltip_fields: tooltipFields } : {}),
    }
  }

  const descriptor = chart as unknown as TimeSeriesChartDescriptor
  return {
    path: 'chart',
    kind: 'time_series',
    ...(descriptor.title ? { title: descriptor.title } : {}),
    data_path: descriptor.data_key,
    x_key: descriptor.x_field,
    y_keys: [
      ...(descriptor.y_field ? [descriptor.y_field] : []),
      ...(descriptor.grouped_value_field ? [descriptor.grouped_value_field] : []),
      ...(descriptor.series_keys?.length ? descriptor.series_keys.map((key) => `${descriptor.grouped_value_field ?? 'series'}.${key}`) : []),
    ],
    ...(rowCount !== undefined ? { row_count: rowCount } : {}),
    recommended_visual: descriptor.recommended_visual,
    ...(tooltipFields.length > 0 ? { tooltip_fields: tooltipFields } : {}),
  }
}

function buildTableHints(payload: RecordLike): LlmTableHint[] {
  return asArray<TableDescriptor>(payload.tables)
    .slice(0, 8)
    .filter((table) => typeof table?.id === 'string' && typeof table?.data_key === 'string')
    .map((table) => ({
      id: table.id,
      ...(table.title ? { title: table.title } : {}),
      data_path: table.data_key,
      row_count: table.row_count,
      ...(table.key_field ? { key_field: table.key_field } : {}),
      ...(table.default_sort ? { default_sort: table.default_sort } : {}),
      columns: table.columns.slice(0, 8).map((column) => ({
        key: column.key,
        label: column.label,
        ...(column.path ? { path: column.path } : {}),
        kind: column.kind,
        ...(column.format ? { format: column.format } : {}),
        ...(column.unit ? { unit: column.unit } : {}),
      })),
    }))
}

function buildSections(payload: RecordLike, chartHint: LlmChartHint | undefined, tableHints: LlmTableHint[]): LlmSectionHint[] {
  const sections: LlmSectionHint[] = []
  const seen = new Set<string>()

  const pushSection = (section: LlmSectionHint | undefined) => {
    if (!section || seen.has(section.path)) return
    seen.add(section.path)
    sections.push(section)
  }

  if (typeof payload._summary === 'string') {
    pushSection({ path: '_summary', kind: 'summary_text', title: 'Narrative summary' })
  }

  for (const key of SUMMARY_SECTION_KEYS) {
    const value = payload[key]
    if (Array.isArray(value)) {
      pushSection({ path: key, kind: inferArrayKind(key, chartHint?.data_path), row_count: value.length, title: key.replace(/_/g, ' ') })
    } else if (isRecord(value)) {
      const items = value.items
      if (Array.isArray(items)) {
        pushSection({
          path: `${key}.items`,
          kind: inferArrayKind(`${key}.items`, chartHint?.data_path),
          row_count: items.length,
          title: `${key.replace(/_/g, ' ')} items`,
        })
      }
      pushSection({ path: key, kind: 'section', title: key.replace(/_/g, ' ') })
    }
  }

  if (chartHint) {
    pushSection({
      path: chartHint.data_path,
      kind: chartHint.kind,
      ...(chartHint.title ? { title: chartHint.title } : {}),
      ...(chartHint.row_count !== undefined ? { row_count: chartHint.row_count } : {}),
    })
  }

  for (const table of tableHints) {
    pushSection({
      path: table.data_path,
      kind: inferArrayKind(table.data_path, chartHint?.data_path),
      ...(table.title ? { title: table.title } : {}),
      row_count: table.row_count,
    })
  }

  for (const [key, value] of Object.entries(payload)) {
    if (key.startsWith('_') || RESERVED_TOP_LEVEL_KEYS.has(key) || seen.has(key)) continue
    if (Array.isArray(value)) {
      pushSection({ path: key, kind: inferArrayKind(key, chartHint?.data_path), row_count: value.length, title: key.replace(/_/g, ' ') })
    }
  }

  return sections.slice(0, 8)
}

function annotateSections(sections: LlmSectionHint[], primaryPath: string, answerSequence: string[], recommendedViews: LlmViewHint[]): LlmSectionHint[] {
  const priorityPaths = new Set(answerSequence)

  return sections.map((section) => {
    const matchingViews = recommendedViews.filter((view) => view.data_path === section.path || view.source_path === section.path)
    const useFor = matchingViews.length > 0 ? Array.from(new Set(matchingViews.map((view) => view.kind))).join(', ') : undefined

    return {
      ...section,
      ...(section.path === primaryPath
        ? { priority: 'primary' as const }
        : priorityPaths.has(section.path)
          ? { priority: 'secondary' as const }
          : { priority: 'supporting' as const }),
      ...(useFor ? { use_for: useFor } : {}),
    }
  })
}

function buildRecommendedViews(
  ui: PortalUiSpec | undefined,
  chartHint: LlmChartHint | undefined,
  tableHints: LlmTableHint[],
  metricCardHints: LlmMetricCardHint[],
): LlmViewHint[] {
  const views: LlmViewHint[] = []

  if (metricCardHints.length > 0) {
    views.push({ kind: 'metric_cards', title: 'Key metrics', source_path: '_llm.metric_cards', emphasis: 'primary' })
  }

  for (const panel of asArray<UiPanel>(ui?.panels).slice(0, 5)) {
    if (panel.kind === 'chart_panel') {
      views.push({
        kind: 'chart',
        title: panel.title,
        source_path: panel.chart_key,
        ...(chartHint ? { data_path: chartHint.data_path } : {}),
        ...(panel.emphasis ? { emphasis: panel.emphasis } : {}),
      })
      continue
    }

    if (panel.kind === 'table_panel') {
      const table = tableHints.find((candidate) => candidate.id === panel.table_id)
      views.push({
        kind: 'table',
        title: panel.title,
        source_path: `tables.${panel.table_id}`,
        ...(table ? { data_path: table.data_path } : {}),
        ...(panel.emphasis ? { emphasis: panel.emphasis } : {}),
      })
      continue
    }

    if (panel.kind === 'timeline_panel' || panel.kind === 'ranked_bars_panel' || panel.kind === 'stat_list_panel') {
      views.push({
        kind: panel.kind,
        title: panel.title,
        source_path: panel.data_key,
        data_path: panel.data_key,
        ...(panel.emphasis ? { emphasis: panel.emphasis } : {}),
      })
    }
  }

  if (views.length === 0) {
    if (chartHint) {
      views.push({
        kind: 'chart',
        title: chartHint.title,
        source_path: 'chart',
        data_path: chartHint.data_path,
        emphasis: 'primary',
      })
    }

    if (tableHints[0]) {
      views.push({
        kind: 'table',
        title: tableHints[0].title,
        source_path: `tables.${tableHints[0].id}`,
        data_path: tableHints[0].data_path,
      })
    }
  }

  return views.slice(0, 5)
}

function inferPrimaryPath(
  payload: RecordLike,
  chartHint: LlmChartHint | undefined,
  tableHints: LlmTableHint[],
  sections: LlmSectionHint[],
  overrides?: LlmOverrides,
): { primaryPath: string; primaryKind: string } {
  if (overrides?.primary_path) {
    return {
      primaryPath: overrides.primary_path,
      primaryKind: overrides.primary_kind ?? 'section',
    }
  }

  if (chartHint?.data_path) {
    return { primaryPath: chartHint.data_path, primaryKind: chartHint.kind }
  }

  if (tableHints[0]) {
    return { primaryPath: tableHints[0].data_path, primaryKind: 'table_rows' }
  }

  const activityItems = getByPath(payload, 'activity.items')
  if (Array.isArray(activityItems)) {
    return { primaryPath: 'activity.items', primaryKind: 'records' }
  }

  if (Array.isArray(payload.items)) {
    return { primaryPath: 'items', primaryKind: 'records' }
  }

  const firstSection = sections.find((section) => section.path !== '_summary')
  if (firstSection) {
    return { primaryPath: firstSection.path, primaryKind: firstSection.kind }
  }

  return { primaryPath: '_summary', primaryKind: 'summary_text' }
}

function buildAnswerSequence(
  payload: RecordLike,
  metricCards: LlmMetricCardHint[],
  primaryPath: string,
  overrides?: LlmOverrides,
): string[] {
  const sequence = [
    ...(overrides?.answer_sequence ?? []),
    typeof payload.answer === 'string' ? 'answer' : undefined,
    typeof payload._summary === 'string' ? '_summary' : undefined,
    metricCards.find((card) => card.emphasis === 'primary')?.value_path,
    ...metricCards.map((card) => card.value_path),
    isRecord(payload.summary) ? 'summary' : undefined,
    isRecord(payload.overview) ? 'overview' : undefined,
    primaryPath,
  ].filter((value): value is string => Boolean(value))

  return Array.from(new Set(sequence)).slice(0, 12)
}

function buildPreviewRows(params: {
  rows: Array<{ row: RecordLike; index: number }>
  columns: Array<{ key: string; label: string; path?: string; format?: TableValueFormat; unit?: string }>
  keyField?: string
  path: string
}): LlmPreviewRow[] {
  return params.rows.map(({ row, index }, rowIndex) => {
    const keyValue = params.keyField ? getByPath(row, params.keyField) : undefined

    return {
      ...(keyValue !== undefined ? { key: String(keyValue) } : {}),
      ...(params.keyField ? undefined : rowIndex === 0 ? { label: 'Row 1' } : { label: `Row ${rowIndex + 1}` }),
      cells: params.columns.map((column) => {
        const valuePath = `${params.path}[${index}].${column.path ?? column.key}`
        const rawValue = getByPath(row, column.path ?? column.key)
        const displayValue = formatScalar(rawValue, column.format, column.unit)

        return {
          label: column.label,
          value_path: valuePath,
          ...(displayValue ? { display_value: displayValue } : {}),
        }
      }),
    }
  })
}

function buildPrimaryPreview(
  payload: RecordLike,
  primaryPath: string,
  primaryKind: string,
  tableHints: LlmTableHint[],
): LlmPrimaryPreview | undefined {
  const primaryValue = getByPath(payload, primaryPath)
  const matchingTable = tableHints.find((table) => table.data_path === primaryPath)

  if (Array.isArray(primaryValue) && matchingTable) {
    const selection =
      primaryKind === 'candlestick' || primaryKind === 'time_series'
        ? 'latest_row'
        : primaryKind === 'ranked_list' || matchingTable.default_sort?.key === 'rank'
          ? 'top_rows'
          : 'sample_rows'

    const selectedRows =
      selection === 'latest_row'
        ? primaryValue.length > 0 && isRecord(primaryValue[primaryValue.length - 1])
          ? [{ row: primaryValue[primaryValue.length - 1] as RecordLike, index: primaryValue.length - 1 }]
          : []
        : primaryValue
            .slice(0, Math.min(3, primaryValue.length))
            .map((row, index) => ({ row, index }))
            .filter((entry): entry is { row: RecordLike; index: number } => isRecord(entry.row))

    if (selectedRows.length === 0) {
      return undefined
    }

    return {
      path: primaryPath,
      selection,
      row_count: primaryValue.length,
      rows: buildPreviewRows({
        rows: selectedRows,
        columns: matchingTable.columns.slice(0, 6),
        keyField: matchingTable.key_field,
        path: primaryPath,
      }),
    }
  }

  if (isRecord(primaryValue)) {
    const scalarFields = Object.entries(primaryValue)
      .filter(([, value]) => value === null || ['string', 'number', 'boolean'].includes(typeof value))
      .slice(0, 6)
      .map(([key, value]) => ({
        label: key.replace(/_/g, ' '),
        value_path: `${primaryPath}.${key}`,
        display_value: formatScalar(value),
      }))

    if (scalarFields.length === 0) {
      return undefined
    }

    return {
      path: primaryPath,
      selection: 'summary_fields',
      fields: scalarFields,
    }
  }

  return undefined
}

function inferNormalizedFields(payload: RecordLike, primaryPath: string, normalizedOutput: boolean): string[] | undefined {
  const primaryValue = getByPath(payload, primaryPath)
  const sampleRecord =
    Array.isArray(primaryValue) && primaryValue.length > 0 && isRecord(primaryValue[0])
      ? primaryValue[0]
      : isRecord(primaryValue)
        ? primaryValue
        : undefined

  const fields = sampleRecord
    ? NORMALIZED_ALIAS_KEYS.filter((key) => key in sampleRecord)
    : normalizedOutput
      ? NORMALIZED_ALIAS_KEYS
      : []

  return fields.length > 0 ? fields : undefined
}

function buildParserNotes(
  payload: RecordLike,
  normalizedOutput: boolean,
  metricCards: LlmMetricCardHint[],
  chartHint: LlmChartHint | undefined,
  tableHints: LlmTableHint[],
  overrides?: LlmOverrides,
): string[] | undefined {
  const notes = [
    metricCards.length > 0 ? 'Use _llm.metric_cards for headline numbers before recomputing values from arrays.' : undefined,
    chartHint ? 'Use _llm.chart plus chart.tooltip and chart.interactions metadata for plotting and hover labels instead of inferring series structure.' : undefined,
    tableHints.length > 0 ? 'Use _llm.tables columns for labels, ordering, and value formats instead of guessing from field names.' : undefined,
    normalizedOutput ? 'When present, prefer normalized aliases like primary_id, record_type, timestamp_human, sender, and recipient for cross-chain answers.' : undefined,
    typeof payload._pagination === 'object' && payload._pagination !== null ? 'Check _pagination before assuming the returned list is complete.' : undefined,
    ...(overrides?.parser_notes ?? []),
  ].filter((note): note is string => Boolean(note))

  return notes.length > 0 ? Array.from(new Set(notes)).slice(0, 6) : undefined
}

export function buildLlmHints(payload: RecordLike, overrides?: LlmOverrides): PortalLlmHints {
  const ui = isRecord(payload._ui) ? (payload._ui as unknown as PortalUiSpec) : undefined
  const toolContract = isRecord(payload._tool_contract) ? payload._tool_contract : undefined
  const normalizedOutput = Boolean(toolContract?.normalized_output)
  const payloadSize = JSON.stringify(payload).length
  const compactHints = payloadSize > 12_000
  const headline = buildHeadline(payload, ui)
  const chartHint = buildChartHint(payload)
  const tableHints = buildTableHints(payload)
  const metricCards = buildMetricCardHints(payload, ui)
  const sections = buildSections(payload, chartHint, tableHints)
  const { primaryPath, primaryKind } = inferPrimaryPath(payload, chartHint, tableHints, sections, overrides)
  const llmMetricCards = compactHints ? metricCards.slice(0, 4) : metricCards
  const llmTableHints = compactHints
    ? tableHints.slice(0, 2).map((table) => ({
        ...table,
        columns: table.columns.slice(0, 4),
      }))
    : tableHints
  const answerSequence = buildAnswerSequence(payload, llmMetricCards, primaryPath, overrides)
  const recommendedViews = buildRecommendedViews(ui, chartHint, llmTableHints, llmMetricCards)
  if (recommendedViews.length === 0) {
    const primarySection = sections.find((section) => section.path === primaryPath)
    recommendedViews.push({
      kind: primaryKind === 'records' ? 'list' : primaryKind,
      title: primarySection?.title ?? 'Primary data',
      source_path: primaryPath,
      data_path: primaryPath,
      emphasis: 'primary',
    })
  }
  const primaryPreview = buildPrimaryPreview(payload, primaryPath, primaryKind, llmTableHints.length > 0 ? llmTableHints : tableHints)
  const annotatedSections = annotateSections(sections, primaryPath, answerSequence, recommendedViews)
  const llmSections = compactHints ? annotatedSections.slice(0, 5) : annotatedSections
  const llmRecommendedViews = compactHints ? recommendedViews.slice(0, 3) : recommendedViews
  const normalizedFields = inferNormalizedFields(payload, primaryPath, normalizedOutput)
  const parserNotes = buildParserNotes(payload, normalizedOutput, llmMetricCards, chartHint, llmTableHints, overrides)
  const llmParserNotes = compactHints ? parserNotes?.slice(0, 3) : parserNotes
  const followUpActions = asArray<UiFollowUpAction>(ui?.follow_up_actions)
  const llmFollowUpActions = compactHints ? followUpActions.slice(0, 2) : followUpActions.slice(0, 5)

  return {
    version: 'portal_llm_v1',
    primary_path: primaryPath,
    primary_kind: overrides?.primary_kind ?? primaryKind,
    answer_sequence: answerSequence,
    ...(headline ? { headline } : {}),
    ...(llmMetricCards.length > 0 ? { metric_cards: llmMetricCards } : {}),
    ...(chartHint ? { chart: chartHint } : {}),
    ...(llmTableHints.length > 0 ? { tables: llmTableHints } : {}),
    sections: llmSections,
    recommended_views: llmRecommendedViews,
    ...(primaryPreview ? { primary_preview: primaryPreview } : {}),
    ...(normalizedFields ? { normalized_fields: normalizedFields } : {}),
    ...((typeof payload._pagination === 'object' && payload._pagination !== null) || llmFollowUpActions.length > 0
      ? {
          follow_up: {
            ...(isRecord(payload._pagination) && typeof payload._pagination.next_cursor === 'string'
              ? { continue_cursor_path: '_pagination.next_cursor' }
              : {}),
            ...(llmFollowUpActions.length > 0
              ? {
                  actions: llmFollowUpActions.map((action) => ({
                    label: action.label,
                    intent: action.intent,
                    ...(action.target ? { target: action.target } : {}),
                  })),
                }
              : {}),
          },
        }
      : {}),
    ...(llmParserNotes ? { parser_notes: llmParserNotes } : {}),
  }
}
