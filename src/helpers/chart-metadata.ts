export type TableValueFormat =
  | 'integer'
  | 'decimal'
  | 'compact_number'
  | 'scientific'
  | 'percent'
  | 'currency_usd'
  | 'gwei'
  | 'bytes'
  | 'btc'
  | 'address'
  | 'timestamp'
  | 'timestamp_human'

export interface TooltipFieldDescriptor {
  key: string
  path?: string
  label: string
  format?: TableValueFormat
  unit?: string
  emphasis?: 'primary' | 'secondary'
}

export interface ChartTooltipDescriptor {
  mode?: 'axis' | 'item'
  title_field: string
  title_label?: string
  title_format?: TableValueFormat
  fields: TooltipFieldDescriptor[]
}

export interface ChartInteractionsDescriptor {
  hover?: {
    enabled: boolean
    crosshair?: boolean
    snap_to_data?: boolean
  }
  zoom?: {
    enabled: boolean
    axis: 'x' | 'xy'
    brush?: boolean
  }
  legend?: {
    enabled: boolean
    position?: 'top' | 'bottom' | 'right'
    toggle_series?: boolean
  }
  toolbar?: {
    enabled: boolean
    actions: Array<'reset_zoom' | 'toggle_visual' | 'download_png'>
  }
}

export interface TableInteractionsDescriptor {
  sortable?: boolean
  searchable?: boolean
  sticky_header?: boolean
  row_hover?: boolean
  row_expand?: boolean
  default_page_size?: number
}

export interface TableColumnDescriptor {
  key: string
  path?: string
  label: string
  kind: 'time' | 'dimension' | 'metric' | 'rank'
  format?: TableValueFormat
  unit?: string
  align?: 'left' | 'right' | 'center'
}

export interface TableDescriptor {
  id: string
  kind: 'table'
  data_key: string
  title?: string
  subtitle?: string
  row_count: number
  key_field?: string
  default_sort?: {
    key: string
    direction: 'asc' | 'desc'
  }
  columns: TableColumnDescriptor[]
  dense?: boolean
  interactions?: TableInteractionsDescriptor
}

interface BaseChartDescriptor {
  data_key: string
  title?: string
  subtitle?: string
  x_axis_label?: string
  y_axis_label?: string
  value_format?: TableValueFormat
  tooltip?: ChartTooltipDescriptor
  interactions?: ChartInteractionsDescriptor
  height_hint?: 'compact' | 'medium' | 'tall'
}

export interface TimeSeriesChartDescriptor extends BaseChartDescriptor {
  kind: 'time_series'
  recommended_visual: 'line' | 'bar' | 'stacked_area'
  alternative_visuals?: Array<'line' | 'bar' | 'stacked_area'>
  x_field: 'timestamp' | 'bucket_index'
  y_field?: string
  grouped_value_field?: string
  grouped_value_mode?: 'row_field' | 'object_map'
  series_keys?: string[]
  interval: string
  total_points: number
  unit?: string
  stacking?: 'stacked'
}

export interface CandlestickChartDescriptor extends BaseChartDescriptor {
  kind: 'candlestick'
  x_field: 'timestamp'
  candle_fields: {
    open: string
    high: string
    low: string
    close: string
  }
  volume_field?: string
  volume_data_key?: string
  volume_color_field?: string
  volume_panel?: boolean
  interval: string
  total_candles: number
  price_unit?: string
  volume_unit?: string
}

export type ChartDescriptor = TimeSeriesChartDescriptor | CandlestickChartDescriptor

export function buildTableDescriptor(params: {
  id: string
  dataKey: string
  rowCount: number
  columns: TableColumnDescriptor[]
  title?: string
  subtitle?: string
  keyField?: string
  defaultSort?: {
    key: string
    direction: 'asc' | 'desc'
  }
  dense?: boolean
  interactions?: TableInteractionsDescriptor
}): TableDescriptor {
  return {
    id: params.id,
    kind: 'table',
    data_key: params.dataKey,
    row_count: params.rowCount,
    columns: params.columns,
    ...(params.title ? { title: params.title } : {}),
    ...(params.subtitle ? { subtitle: params.subtitle } : {}),
    ...(params.keyField ? { key_field: params.keyField } : {}),
    ...(params.defaultSort ? { default_sort: params.defaultSort } : {}),
    ...(params.dense !== undefined ? { dense: params.dense } : {}),
    interactions: params.interactions ?? {
      sortable: true,
      searchable: params.rowCount > 12,
      sticky_header: true,
      row_hover: true,
      row_expand: false,
      default_page_size: Math.min(Math.max(params.rowCount, 1), 25),
    },
  }
}

export function buildTimeSeriesChart(params: {
  interval: string
  totalPoints: number
  unit?: string
  groupedValueField?: string
  groupedValueMode?: 'row_field' | 'object_map'
  seriesKeys?: string[]
  recommendedVisual?: 'line' | 'bar' | 'stacked_area'
  xField?: 'timestamp' | 'bucket_index'
  dataKey?: string
  title?: string
  subtitle?: string
  xAxisLabel?: string
  yAxisLabel?: string
  valueFormat?: TableValueFormat
  tooltip?: ChartTooltipDescriptor
  interactions?: ChartInteractionsDescriptor
  heightHint?: 'compact' | 'medium' | 'tall'
}): TimeSeriesChartDescriptor {
  const recommendedVisual = params.recommendedVisual ?? (params.groupedValueField ? 'stacked_area' : 'line')
  const xField = params.xField ?? 'timestamp'

  return {
    kind: 'time_series',
    data_key: params.dataKey ?? 'time_series',
    recommended_visual: recommendedVisual,
    alternative_visuals:
      recommendedVisual === 'line'
        ? ['bar']
        : recommendedVisual === 'bar'
          ? ['line']
          : ['line', 'bar'],
    x_field: xField,
    ...(params.groupedValueField
      ? {
          grouped_value_field: params.groupedValueField,
          grouped_value_mode: params.groupedValueMode ?? 'row_field',
        }
      : { y_field: 'value' }),
    ...(params.seriesKeys ? { series_keys: params.seriesKeys } : {}),
    interval: params.interval,
    total_points: params.totalPoints,
    ...(params.unit ? { unit: params.unit } : {}),
    ...(params.title ? { title: params.title } : {}),
    ...(params.subtitle ? { subtitle: params.subtitle } : {}),
    ...(params.xAxisLabel ? { x_axis_label: params.xAxisLabel } : { x_axis_label: xField === 'timestamp' ? 'Time' : 'Bucket' }),
    ...(params.yAxisLabel ? { y_axis_label: params.yAxisLabel } : {}),
    ...(params.valueFormat ? { value_format: params.valueFormat } : {}),
    ...(params.groupedValueField && recommendedVisual === 'stacked_area' ? { stacking: 'stacked' as const } : {}),
    tooltip: params.tooltip ?? {
      mode: xField === 'timestamp' ? 'axis' : 'item',
      title_field: xField === 'timestamp' ? 'timestamp_human' : 'bucket_index',
      title_label: xField === 'timestamp' ? 'Time' : 'Bucket',
      ...(xField === 'timestamp' ? { title_format: 'timestamp_human' as const } : { title_format: 'integer' as const }),
      fields: [
        ...(params.groupedValueField && (params.groupedValueMode ?? 'row_field') === 'row_field'
          ? [{ key: params.groupedValueField, label: 'Series' } satisfies TooltipFieldDescriptor]
          : []),
        {
          key: 'value',
          label: params.yAxisLabel ?? 'Value',
          ...(params.valueFormat ? { format: params.valueFormat } : {}),
          ...(params.unit ? { unit: params.unit } : {}),
          emphasis: 'primary',
        },
      ],
    },
    interactions: params.interactions ?? {
      hover: { enabled: true, crosshair: true, snap_to_data: true },
      zoom: { enabled: true, axis: 'x', brush: true },
      legend: { enabled: Boolean(params.groupedValueField), position: 'top', toggle_series: true },
      toolbar: { enabled: true, actions: ['reset_zoom', 'toggle_visual', 'download_png'] },
    },
    height_hint: params.heightHint ?? (params.groupedValueField ? 'tall' : 'medium'),
  }
}

export function buildTimeSeriesTable(params: {
  id?: string
  dataKey?: string
  rowCount: number
  title?: string
  subtitle?: string
  valueField?: string
  valueLabel?: string
  valueFormat?: TableValueFormat
  unit?: string
  groupedValueField?: string
  groupedValueLabel?: string
  groupedValueMode?: 'row_field' | 'object_map'
  seriesKeys?: string[]
  timestampField?: string
  timestampLabel?: string
  timestampHumanField?: string
  timestampHumanLabel?: string
  includeBucketIndex?: boolean
  bucketIndexLabel?: string
  blocksInBucketField?: string
  blocksInBucketLabel?: string
  extraColumns?: TableColumnDescriptor[]
  keyField?: string
  defaultSort?: {
    key: string
    direction: 'asc' | 'desc'
  }
  interactions?: TableInteractionsDescriptor
}): TableDescriptor {
  const columns: TableColumnDescriptor[] = []

  if (params.includeBucketIndex ?? true) {
    columns.push({
      key: 'bucket_index',
      label: params.bucketIndexLabel ?? 'Bucket',
      kind: 'dimension',
      format: 'integer',
      align: 'right',
    })
  }

  if (params.timestampHumanField ?? 'timestamp_human') {
    columns.push({
      key: params.timestampHumanField ?? 'timestamp_human',
      label: params.timestampHumanLabel ?? 'Time',
      kind: 'time',
      format: 'timestamp_human',
    })
  }

  if (params.timestampField) {
    columns.push({
      key: params.timestampField,
      label: params.timestampLabel ?? 'Timestamp',
      kind: 'time',
      format: 'timestamp',
      align: 'right',
    })
  }

  if (params.groupedValueField) {
    if ((params.groupedValueMode ?? 'row_field') === 'object_map' && params.seriesKeys) {
      for (const seriesKey of params.seriesKeys) {
        columns.push({
          key: seriesKey.toLowerCase(),
          path: `${params.groupedValueField}.${seriesKey}`,
          label: seriesKey,
          kind: 'metric',
          format: params.valueFormat,
          ...(params.unit ? { unit: params.unit } : {}),
          align: 'right',
        })
      }
    } else {
      columns.push({
        key: params.groupedValueField,
        label: params.groupedValueLabel ?? 'Series',
        kind: 'dimension',
      })
    }
  } else {
    columns.push({
      key: params.valueField ?? 'value',
      label: params.valueLabel ?? 'Value',
      kind: 'metric',
      format: params.valueFormat,
      ...(params.unit ? { unit: params.unit } : {}),
      align: 'right',
    })
  }

  if (params.blocksInBucketField) {
    columns.push({
      key: params.blocksInBucketField,
      label: params.blocksInBucketLabel ?? 'Blocks',
      kind: 'metric',
      format: 'integer',
      align: 'right',
    })
  }

  if (params.extraColumns) {
    columns.push(...params.extraColumns)
  }

  return buildTableDescriptor({
    id: params.id ?? 'main',
    dataKey: params.dataKey ?? 'time_series',
    rowCount: params.rowCount,
    columns,
    ...(params.title ? { title: params.title } : {}),
    ...(params.subtitle ? { subtitle: params.subtitle } : {}),
    ...(params.keyField ? { keyField: params.keyField } : {}),
    ...(params.defaultSort ? { defaultSort: params.defaultSort } : {}),
    ...(params.interactions ? { interactions: params.interactions } : {}),
    dense: true,
  })
}

export function buildCandlestickChart(params: {
  interval: string
  totalCandles: number
  dataKey?: string
  title?: string
  subtitle?: string
  volumePanel?: boolean
  volumeField?: string
  volumeDataKey?: string
  volumeColorField?: string
  priceUnit?: string
  volumeUnit?: string
  priceFormat?: TableValueFormat
  tooltip?: ChartTooltipDescriptor
  interactions?: ChartInteractionsDescriptor
  heightHint?: 'compact' | 'medium' | 'tall'
}): CandlestickChartDescriptor {
  return {
    kind: 'candlestick',
    data_key: params.dataKey ?? 'ohlc',
    x_field: 'timestamp',
    candle_fields: {
      open: 'open',
      high: 'high',
      low: 'low',
      close: 'close',
    },
    ...(params.volumeField ? { volume_field: params.volumeField } : {}),
    ...(params.volumeDataKey ? { volume_data_key: params.volumeDataKey } : {}),
    ...(params.volumeColorField ? { volume_color_field: params.volumeColorField } : {}),
    ...(params.volumePanel !== undefined ? { volume_panel: params.volumePanel } : {}),
    interval: params.interval,
    total_candles: params.totalCandles,
    ...(params.title ? { title: params.title } : {}),
    ...(params.subtitle ? { subtitle: params.subtitle } : {}),
    ...(params.priceUnit ? { price_unit: params.priceUnit } : {}),
    ...(params.volumeUnit ? { volume_unit: params.volumeUnit } : {}),
    ...(params.priceFormat ? { value_format: params.priceFormat } : {}),
    x_axis_label: 'Time',
    y_axis_label: 'Price',
    tooltip: params.tooltip ?? {
      mode: 'axis',
      title_field: 'timestamp_human',
      title_label: 'Time',
      title_format: 'timestamp_human',
      fields: [
        { key: 'open', label: 'Open', format: params.priceFormat ?? 'decimal', ...(params.priceUnit ? { unit: params.priceUnit } : {}), emphasis: 'primary' },
        { key: 'high', label: 'High', format: params.priceFormat ?? 'decimal', ...(params.priceUnit ? { unit: params.priceUnit } : {}) },
        { key: 'low', label: 'Low', format: params.priceFormat ?? 'decimal', ...(params.priceUnit ? { unit: params.priceUnit } : {}) },
        { key: 'close', label: 'Close', format: params.priceFormat ?? 'decimal', ...(params.priceUnit ? { unit: params.priceUnit } : {}), emphasis: 'primary' },
        ...(params.volumeField
          ? [{
              key: params.volumeField,
              label: 'Volume',
              format: params.volumeUnit === 'USD' ? 'currency_usd' : 'decimal',
              ...(params.volumeUnit ? { unit: params.volumeUnit } : {}),
            } satisfies TooltipFieldDescriptor]
          : []),
      ],
    },
    interactions: params.interactions ?? {
      hover: { enabled: true, crosshair: true, snap_to_data: true },
      zoom: { enabled: true, axis: 'x', brush: true },
      legend: { enabled: false },
      toolbar: { enabled: true, actions: ['reset_zoom', 'download_png'] },
    },
    height_hint: params.heightHint ?? 'tall',
  }
}

export function buildOhlcTable(params: {
  id?: string
  rowCount: number
  dataKey?: string
  title?: string
  subtitle?: string
  volumeField?: string
  volumeLabel?: string
  priceUnit?: string
  priceFormat?: TableValueFormat
  volumeUnit?: string
  interactions?: TableInteractionsDescriptor
}): TableDescriptor {
  const columns: TableColumnDescriptor[] = [
    { key: 'timestamp_human', label: 'Time', kind: 'time', format: 'timestamp_human' },
    { key: 'open', label: 'Open', kind: 'metric', format: params.priceFormat ?? 'decimal', ...(params.priceUnit ? { unit: params.priceUnit } : {}), align: 'right' },
    { key: 'high', label: 'High', kind: 'metric', format: params.priceFormat ?? 'decimal', ...(params.priceUnit ? { unit: params.priceUnit } : {}), align: 'right' },
    { key: 'low', label: 'Low', kind: 'metric', format: params.priceFormat ?? 'decimal', ...(params.priceUnit ? { unit: params.priceUnit } : {}), align: 'right' },
    { key: 'close', label: 'Close', kind: 'metric', format: params.priceFormat ?? 'decimal', ...(params.priceUnit ? { unit: params.priceUnit } : {}), align: 'right' },
  ]

  if (params.volumeField) {
    columns.push({
      key: params.volumeField,
      label: params.volumeLabel ?? 'Volume',
      kind: 'metric',
      format: 'decimal',
      ...(params.volumeUnit ? { unit: params.volumeUnit } : {}),
      align: 'right',
    })
  }

  return buildTableDescriptor({
    id: params.id ?? 'ohlc',
    dataKey: params.dataKey ?? 'ohlc',
    rowCount: params.rowCount,
    title: params.title,
    ...(params.subtitle ? { subtitle: params.subtitle } : {}),
    keyField: 'timestamp',
    defaultSort: { key: 'timestamp', direction: 'asc' },
    dense: true,
    columns,
    ...(params.interactions ? { interactions: params.interactions } : {}),
  })
}
