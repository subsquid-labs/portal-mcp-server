import type { TableValueFormat } from './chart-metadata.js'

export interface UiMetricCard {
  id: string
  label: string
  value_path: string
  format?: TableValueFormat
  unit?: string
  subtitle?: string
  emphasis?: 'primary' | 'secondary'
}

interface BaseUiPanel {
  id: string
  title: string
  subtitle?: string
  emphasis?: 'primary' | 'secondary'
}

export interface UiChartPanel extends BaseUiPanel {
  kind: 'chart_panel'
  chart_key: string
}

export interface UiTablePanel extends BaseUiPanel {
  kind: 'table_panel'
  table_id: string
}

export interface UiTimelinePanel extends BaseUiPanel {
  kind: 'timeline_panel'
  data_key: string
  timestamp_key: string
  title_key: string
  subtitle_keys?: string[]
  badge_key?: string
}

export interface UiRankedBarsPanel extends BaseUiPanel {
  kind: 'ranked_bars_panel'
  data_key: string
  category_key: string
  value_key: string
  rank_key?: string
  value_format?: TableValueFormat
  unit?: string
}

export interface UiStatListPanel extends BaseUiPanel {
  kind: 'stat_list_panel'
  data_key: string
  label_key: string
  value_key: string
  value_format?: TableValueFormat
  unit?: string
}

export type UiPanel =
  | UiChartPanel
  | UiTablePanel
  | UiTimelinePanel
  | UiRankedBarsPanel
  | UiStatListPanel

export interface UiFollowUpAction {
  label: string
  intent: 'continue' | 'show_raw' | 'compare_previous' | 'zoom_in' | 'drilldown'
  target?: string
}

export interface PortalUiSpec {
  version: 'portal_ui_v1'
  layout: 'dashboard' | 'chart_focus' | 'split'
  density: 'comfortable' | 'compact'
  design_intent: 'market_terminal' | 'analytics_dashboard' | 'activity_investigator'
  headline: {
    title: string
    subtitle?: string
  }
  metric_cards?: UiMetricCard[]
  panels: UiPanel[]
  follow_up_actions?: UiFollowUpAction[]
}

export function buildMetricCard(params: UiMetricCard): UiMetricCard {
  return params
}

export function buildChartPanel(params: UiChartPanel): UiChartPanel {
  return params
}

export function buildTablePanel(params: UiTablePanel): UiTablePanel {
  return params
}

export function buildTimelinePanel(params: UiTimelinePanel): UiTimelinePanel {
  return params
}

export function buildRankedBarsPanel(params: UiRankedBarsPanel): UiRankedBarsPanel {
  return params
}

export function buildStatListPanel(params: UiStatListPanel): UiStatListPanel {
  return params
}

export function buildPortalUi(params: PortalUiSpec): PortalUiSpec {
  return params
}
