import { App, applyDocumentTheme, applyHostFonts, applyHostStyleVariables } from '@modelcontextprotocol/ext-apps'

const ACCENT_COLORS = ['#4c8dff', '#7fb2ff', '#30d158', '#64d2ff', '#bfadff', '#ff9f0a', '#ff453a', '#8e8e93']
const ZOOM_DURATION_MAP = {
  '30d': '7d',
  '7d': '24h',
  '24h': '6h',
  '6h': '1h',
  '1h': '1h',
}

const state = {
  payload: null,
  rawText: '',
  loading: false,
  error: '',
  currentArgs: {},
  tableState: {},
  rawOpen: false,
  drawer: null,
  statusMessage: '',
  chartModels: {},
}

const root = document.getElementById('app')
const app = new App({
  name: 'portal-explorer',
  version: '0.7.8',
}, {})

installBaseStyles()

app.onhostcontextchanged = (context) => {
  applyHostContext(context)
}

app.ontoolinput = (params) => {
  state.currentArgs = params.arguments ?? {}
  state.loading = true
  state.error = ''
  render()
}

app.ontoolresult = (params) => {
  consumeToolResult(params)
}

void boot()

async function boot() {
  render()

  try {
    await app.connect()
    applyHostContext(app.getHostContext())
  } catch (error) {
    state.loading = false
    state.error = error instanceof Error ? error.message : 'Unable to connect the Portal app.'
    render()
  }
}

function installBaseStyles() {
  const style = document.createElement('style')
  style.textContent = `
    :root {
      color-scheme: dark;
      --portal-bg: #07090d;
      --portal-bg-top: #11151b;
      --portal-shell: rgba(10, 13, 18, 0.94);
      --portal-panel: #11151b;
      --portal-panel-strong: #171c24;
      --portal-panel-muted: #0d1117;
      --portal-border: rgba(255, 255, 255, 0.08);
      --portal-border-strong: rgba(76, 141, 255, 0.32);
      --portal-grid: rgba(255, 255, 255, 0.05);
      --portal-grid-strong: rgba(255, 255, 255, 0.1);
      --portal-text: #f5f7fa;
      --portal-text-muted: #b0b7c3;
      --portal-text-subtle: #7f8898;
      --portal-accent: #4c8dff;
      --portal-accent-soft: rgba(76, 141, 255, 0.12);
      --portal-accent-cool: #4c8dff;
      --portal-accent-positive: #30d158;
      --portal-accent-negative: #ff453a;
      --portal-shadow: 0 18px 40px rgba(0, 0, 0, 0.24);
      --portal-radius-xl: 20px;
      --portal-radius-lg: 16px;
      --portal-radius-md: 12px;
      --portal-radius-sm: 10px;
      --portal-font: var(--font-sans, -apple-system, BlinkMacSystemFont, "SF Pro Display", "Helvetica Neue", ui-sans-serif, system-ui, sans-serif);
      --portal-font-mono: var(--font-mono, "SFMono-Regular", "SF Mono", ui-monospace, monospace);
      --portal-ease-out: cubic-bezier(0.23, 1, 0.32, 1);
      --portal-ease-in-out: cubic-bezier(0.77, 0, 0.175, 1);
    }

    * {
      box-sizing: border-box;
    }

    html, body {
      margin: 0;
      min-height: 100%;
      background:
        radial-gradient(circle at top center, rgba(76, 141, 255, 0.08), transparent 26%),
        radial-gradient(circle at top left, rgba(255, 255, 255, 0.03), transparent 28%),
        linear-gradient(180deg, var(--portal-bg-top), var(--portal-bg));
      color: var(--portal-text);
      font-family: var(--portal-font);
      font-variant-numeric: tabular-nums;
    }

    body {
      padding: 10px;
    }

    button, input {
      font: inherit;
    }

    .portal-app {
      display: grid;
      gap: 10px;
      max-width: 1320px;
      margin: 0 auto;
    }

    .portal-shell {
      position: relative;
      overflow: hidden;
      border: 1px solid var(--portal-border);
      border-radius: var(--portal-radius-xl);
      background: linear-gradient(180deg, rgba(15, 19, 26, 0.98), rgba(10, 13, 18, 0.98));
      box-shadow: var(--portal-shadow);
    }

    .portal-shell::before {
      content: '';
      position: absolute;
      inset: 0;
      pointer-events: none;
      background: linear-gradient(180deg, rgba(255, 255, 255, 0.04), transparent 18%);
      opacity: 0.8;
    }

    .portal-shell > * {
      position: relative;
      z-index: 1;
    }

    .portal-header {
      display: grid;
      gap: 10px;
      padding: 24px 24px 10px;
    }

    .portal-eyebrow {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }

    .portal-headline {
      display: grid;
      gap: 6px;
    }

    .portal-title-stack {
      display: grid;
      gap: 6px;
    }

    .portal-title-kicker {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      font-size: 12px;
      font-weight: 600;
      letter-spacing: -0.01em;
      color: var(--portal-text-subtle);
    }

    .portal-title-kicker::before {
      content: '';
      width: 18px;
      height: 1px;
      background: rgba(255, 255, 255, 0.14);
    }

    .portal-chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 6px 10px;
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid rgba(255, 255, 255, 0.06);
      color: var(--portal-text-muted);
      font-size: 12px;
      font-weight: 500;
    }

    .portal-chip--accent {
      background: rgba(76, 141, 255, 0.14);
      border-color: rgba(76, 141, 255, 0.2);
      color: #dce9ff;
    }

    .portal-title {
      margin: 0;
      font-size: clamp(28px, 3.2vw, 38px);
      line-height: 1.05;
      letter-spacing: -0.035em;
      max-width: 18ch;
      font-weight: 650;
    }

    .portal-title--value {
      font-family: var(--portal-font);
      font-size: clamp(24px, 2.9vw, 32px);
      line-height: 1.08;
      letter-spacing: -0.03em;
      word-break: break-all;
      max-width: 100%;
      font-weight: 650;
    }

    .portal-subtitle,
    .portal-summary,
    .portal-empty-copy,
    .portal-error-copy {
      margin: 0;
      color: var(--portal-text-muted);
      font-size: 14px;
      line-height: 1.6;
      max-width: 70ch;
    }

    .portal-actions,
    .portal-notices,
    .portal-badges,
    .portal-metrics,
    .portal-panels {
      display: grid;
      gap: 12px;
    }

    .portal-notices {
      padding: 0 24px;
    }

    .portal-badges,
    .portal-actions {
      padding: 0 24px;
      grid-template-columns: repeat(auto-fit, minmax(180px, max-content));
      align-items: start;
    }

    .portal-metrics {
      padding: 0 24px 2px;
      grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
    }

    .portal-panels {
      padding: 0 24px 24px;
      grid-template-columns: repeat(auto-fit, minmax(340px, 1fr));
    }

    .portal-panel,
    .portal-metric,
    .portal-badge,
    .portal-empty,
    .portal-error,
    .portal-raw {
      border: 1px solid var(--portal-border);
      border-radius: var(--portal-radius-lg);
      background: rgba(17, 21, 27, 0.88);
    }

    .portal-panel--wide {
      grid-column: 1 / -1;
    }

    .portal-panel {
      display: grid;
      gap: 14px;
      padding: 18px;
    }

    .portal-panel-header {
      display: grid;
      gap: 6px;
      padding-bottom: 12px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.06);
    }

    .portal-panel-title,
    .portal-metric-label {
      margin: 0;
      font-size: 13px;
      font-weight: 600;
      font-family: var(--portal-font);
      color: var(--portal-text);
      letter-spacing: -0.01em;
    }

    .portal-panel-copy,
    .portal-metric-subtitle,
    .portal-table-meta,
    .portal-timeline-copy,
    .portal-drawer-copy {
      margin: 0;
      font-size: 12px;
      line-height: 1.5;
      color: var(--portal-text-subtle);
    }

    .portal-metric {
      display: grid;
      gap: 8px;
      padding: 16px;
      min-height: 118px;
    }

    .portal-metric-value {
      margin: 0;
      font-size: clamp(28px, 3vw, 36px);
      line-height: 1;
      letter-spacing: -0.03em;
      font-family: var(--portal-font-mono);
    }

    .portal-metric--primary {
      border-color: rgba(76, 141, 255, 0.24);
      background:
        linear-gradient(180deg, rgba(76, 141, 255, 0.09), rgba(76, 141, 255, 0.03) 34%, rgba(17, 21, 27, 0.92) 100%),
        rgba(17, 21, 27, 0.92);
    }

    .portal-badge {
      padding: 12px 14px;
    }

    .portal-badge-key {
      display: block;
      font-size: 11px;
      font-weight: 600;
      color: var(--portal-text-subtle);
      letter-spacing: -0.01em;
      margin-bottom: 6px;
      font-family: var(--portal-font);
    }

    .portal-badge-value {
      font-size: 13px;
      line-height: 1.4;
      color: var(--portal-text);
      word-break: break-word;
      font-family: var(--portal-font);
    }

    .portal-notice {
      padding: 12px 14px;
      border-radius: var(--portal-radius-md);
      border: 1px solid rgba(76, 141, 255, 0.18);
      background: rgba(76, 141, 255, 0.08);
      color: var(--portal-text-muted);
      font-size: 13px;
      line-height: 1.5;
    }

    .portal-button-row {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }

    .portal-button {
      border: 1px solid rgba(255, 255, 255, 0.08);
      background: rgba(255, 255, 255, 0.03);
      color: var(--portal-text);
      border-radius: 12px;
      padding: 10px 14px;
      cursor: pointer;
      font-family: var(--portal-font);
      font-size: 13px;
      font-weight: 500;
      transition: transform 140ms var(--portal-ease-out), border-color 140ms ease, background 140ms ease, color 140ms ease;
    }

    .portal-button:hover:not(:disabled) {
      transform: translateY(-1px);
      border-color: rgba(255, 255, 255, 0.14);
      background: rgba(255, 255, 255, 0.05);
      color: white;
    }

    .portal-button:active:not(:disabled) {
      transform: scale(0.97);
    }

    .portal-button:disabled {
      opacity: 0.6;
      cursor: wait;
    }

    .portal-button--accent {
      background: var(--portal-accent);
      border-color: var(--portal-accent);
      color: white;
    }

    .portal-empty,
    .portal-error,
    .portal-raw {
      padding: 18px;
    }

    .portal-empty,
    .portal-error {
      display: grid;
      gap: 12px;
    }

    .portal-partial {
      padding: 16px;
      display: grid;
      gap: 10px;
      border: 1px solid rgba(76, 141, 255, 0.18);
      background: rgba(76, 141, 255, 0.06);
      border-radius: var(--portal-radius-lg);
    }

    .portal-chart {
      display: grid;
      gap: 10px;
      position: relative;
    }

    .portal-chart-stage {
      position: relative;
      overflow: hidden;
      border-radius: 16px;
      border: 1px solid rgba(255, 255, 255, 0.06);
      background: linear-gradient(180deg, rgba(11, 14, 20, 0.98), rgba(8, 11, 16, 0.98));
    }

    .portal-chart-svg {
      width: 100%;
      height: auto;
      display: block;
    }

    .portal-chart-overlay {
      position: absolute;
      inset: 0;
      pointer-events: none;
    }

    .portal-chart-crosshair {
      position: absolute;
      opacity: 0;
      transition: opacity 120ms ease;
      background: rgba(255, 255, 255, 0.14);
      pointer-events: none;
    }

    .portal-chart-crosshair--x {
      top: 18px;
      bottom: 32px;
      width: 1px;
    }

    .portal-chart-crosshair--y {
      left: 18px;
      right: 72px;
      height: 1px;
    }

    .portal-chart-tooltip {
      position: absolute;
      top: 12px;
      left: 12px;
      min-width: 172px;
      padding: 10px 12px;
      border-radius: 12px;
      border: 1px solid rgba(255, 255, 255, 0.08);
      background: rgba(13, 17, 24, 0.94);
      font-size: 12px;
      color: var(--portal-text);
      display: none;
      pointer-events: none;
      box-shadow: 0 12px 24px rgba(0, 0, 0, 0.28);
      font-family: var(--portal-font-mono);
    }

    .portal-chart-tooltip strong {
      display: block;
      font-size: 12px;
      margin-bottom: 8px;
      color: #dce9ff;
      letter-spacing: 0.04em;
    }

    .portal-legend {
      display: flex;
      flex-wrap: wrap;
      gap: 8px 12px;
    }

    .portal-legend-item {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      color: var(--portal-text-muted);
      font-size: 11px;
      font-family: var(--portal-font);
      letter-spacing: 0.01em;
    }

    .portal-legend-dot {
      width: 10px;
      height: 10px;
      border-radius: 999px;
      flex: none;
    }

    .portal-table-tools {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      align-items: center;
      justify-content: space-between;
    }

    .portal-search {
      min-width: 220px;
      max-width: 320px;
      width: 100%;
      border-radius: 12px;
      border: 1px solid rgba(255, 255, 255, 0.08);
      padding: 10px 12px;
      background: rgba(255, 255, 255, 0.03);
      color: var(--portal-text);
      font-family: var(--portal-font);
    }

    .portal-search::placeholder {
      color: var(--portal-text-subtle);
    }

    .portal-table-wrap {
      overflow-x: auto;
      border: 1px solid rgba(255, 255, 255, 0.05);
      border-radius: 14px;
      background: rgba(8, 11, 16, 0.45);
    }

    .portal-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 12px;
      font-family: var(--portal-font);
    }

    .portal-table th,
    .portal-table td {
      padding: 10px 12px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.05);
      text-align: left;
      vertical-align: top;
    }

    .portal-table th {
      position: sticky;
      top: 0;
      background: rgba(15, 19, 26, 0.98);
      z-index: 1;
      color: var(--portal-text-subtle);
      font-weight: 600;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      font-size: 10px;
    }

    .portal-table tbody tr:nth-child(even) {
      background: rgba(255, 255, 255, 0.01);
    }

    .portal-table tbody tr:hover {
      background: rgba(76, 141, 255, 0.05);
    }

    .portal-table-sort {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      border: none;
      background: transparent;
      color: inherit;
      cursor: pointer;
      padding: 0;
    }

    .portal-table-row-button {
      border: none;
      background: transparent;
      color: var(--portal-accent-cool);
      cursor: pointer;
      font-weight: 600;
      padding: 0;
      font-family: var(--portal-font);
      font-size: 12px;
    }

    .portal-table-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      justify-content: space-between;
      font-family: var(--portal-font);
      letter-spacing: 0.01em;
    }

    .portal-timeline {
      display: grid;
      gap: 10px;
    }

    .portal-timeline-item {
      display: grid;
      gap: 8px;
      border: 1px solid rgba(255, 255, 255, 0.06);
      border-radius: var(--portal-radius-md);
      background: rgba(12, 16, 22, 0.9);
      padding: 14px;
    }

    .portal-timeline-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
      justify-content: space-between;
    }

    .portal-timeline-title {
      margin: 0;
      font-size: 15px;
      line-height: 1.4;
    }

    .portal-timeline-badge {
      display: inline-flex;
      align-items: center;
      padding: 4px 8px;
      border-radius: 999px;
      background: rgba(76, 141, 255, 0.12);
      color: #dce9ff;
      border: 1px solid rgba(76, 141, 255, 0.16);
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.01em;
      font-family: var(--portal-font-mono);
    }

    .portal-bars,
    .portal-stat-list {
      display: grid;
      gap: 10px;
    }

    .portal-bar-row,
    .portal-stat-row {
      display: grid;
      gap: 8px;
    }

    .portal-bar-label,
    .portal-stat-label {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      color: var(--portal-text-muted);
      font-size: 13px;
      font-family: var(--portal-font);
    }

    .portal-bar-track {
      height: 10px;
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.06);
      overflow: hidden;
    }

    .portal-bar-fill {
      height: 100%;
      border-radius: inherit;
      background: linear-gradient(90deg, var(--portal-accent), rgba(76, 141, 255, 0.4));
    }

    .portal-raw pre,
    .portal-drawer pre {
      margin: 0;
      white-space: pre-wrap;
      word-break: break-word;
      font-size: 12px;
      line-height: 1.6;
      color: #d7e1f1;
      font-family: var(--portal-font-mono);
    }

    .portal-drawer {
      display: grid;
      gap: 12px;
      padding: 18px 24px 24px;
      border-top: 1px solid rgba(255, 255, 255, 0.06);
      background: rgba(10, 13, 18, 0.96);
    }

    .portal-skeleton {
      height: 14px;
      border-radius: 999px;
      background: linear-gradient(90deg, rgba(255, 255, 255, 0.04), rgba(76, 141, 255, 0.16), rgba(255, 255, 255, 0.04));
      background-size: 200% 100%;
      animation: portal-pulse 1.3s var(--portal-ease-in-out) infinite;
    }

    @keyframes portal-pulse {
      from { background-position: 200% 0; }
      to { background-position: -200% 0; }
    }

    @media (max-width: 720px) {
      body {
        padding: 8px;
      }

      .portal-header,
      .portal-notices,
      .portal-badges,
      .portal-actions,
      .portal-metrics,
      .portal-panels,
      .portal-drawer {
        padding-left: 14px;
        padding-right: 14px;
      }

      .portal-panels {
        grid-template-columns: 1fr;
      }

      .portal-title {
        max-width: 100%;
      }
    }
  `
  document.head.append(style)
}

function applyHostContext(context) {
  if (!context) return
  if (context.theme) applyDocumentTheme(context.theme)
  if (context.styles?.variables) applyHostStyleVariables(context.styles.variables)
  if (context.styles?.css?.fonts) applyHostFonts(context.styles.css.fonts)
}

function consumeToolResult(result) {
  state.loading = false

  if (result?.isError) {
    state.error = extractText(result.content) || 'Portal returned an error.'
    render()
    return
  }

  const rawText = extractText(result?.content)
  state.rawText = rawText || ''
  state.error = ''

  const payload = parsePayload(rawText)
  if (!payload) {
    state.error = rawText || 'Portal returned a response the app could not parse.'
    render()
    return
  }

  state.payload = payload
  state.tableState = buildInitialTableState(payload)
  render()
}

function parsePayload(rawText) {
  if (!rawText) return null

  try {
    const parsed = JSON.parse(rawText)
    return isRecord(parsed) ? parsed : { value: parsed }
  } catch {
    return {
      _summary: rawText,
      value: rawText,
    }
  }
}

function buildInitialTableState(payload) {
  const next = { ...state.tableState }

  for (const table of asArray(payload.tables)) {
    if (!isRecord(table) || typeof table.id !== 'string') continue
    if (!next[table.id]) {
      next[table.id] = {
        search: '',
        page: 1,
        sortKey: table.default_sort?.key || table.columns?.[0]?.key || '',
        sortDirection: table.default_sort?.direction || 'asc',
      }
    }
  }

  return next
}

function render() {
  if (!root) return

  const payload = state.payload
  state.chartModels = {}
  const title = payload?._ui?.headline?.title || payload?.display?.title || 'Portal Explorer'
  const subtitle = payload?._ui?.headline?.subtitle || payload?.display?.subtitle || ''
  const summary = payload?.answer || payload?._summary || ''
  const notices = [
    ...(typeof payload?._notice === 'string' ? [payload._notice] : []),
    ...asArray(payload?._notices),
  ].filter((entry) => typeof entry === 'string')
  const metricCards = asArray(payload?._ui?.metric_cards)
  const panels = asArray(payload?._ui?.panels)
  const pipesHandoff = isRecord(payload?.pipes_handoff) ? payload.pipes_handoff : null
  const badges = buildBadges(payload)
  const actions = asArray(payload?._ui?.follow_up_actions)
  const hasPayload = Boolean(payload)
  const isPartial = hasPayload && isPartialResult(payload)

  root.innerHTML = `
    <main class="portal-app">
      <section class="portal-shell">
        <header class="portal-header">
          <div class="portal-eyebrow">
            <span class="portal-chip portal-chip--accent">${escapeHtml(payload?._tool_contract?.name ? humanize(payload._tool_contract.name.replace(/^portal_/, '')) : 'Portal')}</span>
            ${payload?._pagination?.has_more ? '<span class="portal-chip">More results available</span>' : ''}
            ${isPartial ? '<span class="portal-chip">Partial preview</span>' : ''}
            ${state.loading ? '<span class="portal-chip">Refreshing...</span>' : ''}
            ${state.statusMessage ? `<span class="portal-chip">${escapeHtml(state.statusMessage)}</span>` : ''}
          </div>
          <div class="portal-headline">
            ${renderHeadline(title)}
            ${subtitle ? `<p class="portal-subtitle">${escapeHtml(subtitle)}</p>` : ''}
          </div>
          ${summary ? `<p class="portal-summary">${escapeHtml(summary)}</p>` : ''}
        </header>

        ${renderNotices(notices)}
        ${badges.length ? `<section class="portal-badges">${badges.join('')}</section>` : ''}
        ${metricCards.length ? `<section class="portal-metrics">${metricCards.map((card) => renderMetricCard(card, payload)).join('')}</section>` : ''}
        ${(actions.length || hasPayload) ? `<section class="portal-actions"><div class="portal-button-row">${[
          ...actions.map((action) => renderActionButton(action)),
          ...renderUtilityActions(),
        ].join('')}</div></section>` : ''}

        <section class="portal-panels">
          ${state.loading && hasPayload ? renderLoadingState() : ''}
          ${state.error ? renderError() : ''}
          ${!hasPayload && !state.error ? renderEmptyState() : ''}
          ${isPartial ? renderPartialState(payload) : ''}
          ${hasPayload ? panels.map((panel) => renderPanel(panel, payload)).join('') : ''}
          ${pipesHandoff ? renderPipesPanel(pipesHandoff) : ''}
          ${state.rawOpen && state.rawText ? renderRawPanel() : ''}
        </section>

        ${state.drawer ? renderDrawer() : ''}
      </section>
    </main>
  `

  attachEventHandlers()
}

function renderNotices(notices) {
  if (!notices.length) return ''
  return `<section class="portal-notices">${notices.map((notice) => `<div class="portal-notice">${escapeHtml(notice)}</div>`).join('')}</section>`
}

function renderHeadline(title) {
  const text = String(title || 'Portal Explorer').trim()
  const dividerIndex = text.indexOf(':')

  if (dividerIndex > -1) {
    const kicker = text.slice(0, dividerIndex).trim()
    const detail = text.slice(dividerIndex + 1).trim()
    if (kicker && detail) {
      return `
        <div class="portal-title-stack">
          <span class="portal-title-kicker">${escapeHtml(kicker)}</span>
          <h1 class="portal-title portal-title--value">${escapeHtml(detail)}</h1>
        </div>
      `
    }
  }

  return `<h1 class="portal-title">${escapeHtml(text)}</h1>`
}

function renderMetricCard(card, payload) {
  const value = getByPath(payload, card.value_path)
  const formatted = formatValue(value, card.format, card.unit)

  return `
    <article class="portal-metric ${card.emphasis === 'primary' ? 'portal-metric--primary' : ''}">
      <p class="portal-metric-label">${escapeHtml(card.label || 'Metric')}</p>
      <p class="portal-metric-value">${escapeHtml(formatted || 'n/a')}</p>
      ${card.subtitle ? `<p class="portal-metric-subtitle">${escapeHtml(card.subtitle)}</p>` : ''}
    </article>
  `
}

function renderUtilityActions() {
  if (!state.payload) return []

  return [
    `
      <button class="portal-button" type="button" data-action="copy-args">
        Copy args
      </button>
    `,
    `
      <button class="portal-button" type="button" data-action="open-raw">
        Open raw
      </button>
    `,
    `
      <button class="portal-button" type="button" data-action="copy-raw">
        Copy raw
      </button>
    `,
  ]
}

function renderActionButton(action) {
  const intent = typeof action.intent === 'string' ? action.intent : 'show_raw'
  const rawLabel = typeof action.label === 'string' ? action.label : humanize(intent)
  const label = compactActionLabel(rawLabel, intent)
  const disabled =
    state.loading
    || (intent === 'continue' && !state.payload?._pagination?.next_cursor)
    || ((intent === 'compare_previous' || intent === 'zoom_in') && !state.payload?._tool_contract?.name)

  return `
    <button
      class="portal-button ${intent === 'continue' ? 'portal-button--accent' : ''}"
      type="button"
      data-action="followup"
      data-intent="${escapeAttribute(intent)}"
      ${typeof action.target === 'string' ? `data-target="${escapeAttribute(action.target)}"` : ''}
      ${disabled ? 'disabled' : ''}
    >
      ${escapeHtml(label)}
    </button>
  `
}

function compactActionLabel(label, intent) {
  switch (intent) {
    case 'continue':
      return 'Load more'
    case 'compare_previous':
      return 'Compare previous'
    case 'zoom_in':
      return 'Zoom in'
    case 'show_raw':
      return 'Show raw'
    default:
      return label
        .replace(/^Show raw .*$/i, 'Show raw')
        .replace(/^Compare against the previous window$/i, 'Compare previous')
        .replace(/^Zoom into the latest .*$/i, 'Zoom in')
    }
}

function renderPanel(panel, payload) {
  if (!isRecord(panel) || typeof panel.kind !== 'string') return ''

  switch (panel.kind) {
    case 'chart_panel':
      return renderChartPanel(panel, payload)
    case 'table_panel':
      return renderTablePanel(panel, payload)
    case 'timeline_panel':
      return renderTimelinePanel(panel, payload)
    case 'ranked_bars_panel':
      return renderRankedBarsPanel(panel, payload)
    case 'stat_list_panel':
      return renderStatListPanel(panel, payload)
    default:
      return ''
  }
}

function renderPipesPanel(recipe) {
  return `
    <article class="portal-panel portal-panel--wide">
      <header class="portal-panel-header">
        <h2 class="portal-panel-title">${escapeHtml(recipe.title || 'Need more data?')}</h2>
        <p class="portal-panel-copy">${escapeHtml(recipe.summary || 'Use Pipes SDK and SQD agent skills for custom indexing or protocol-specific depth.')}</p>
      </header>
      <div class="portal-stat-list">
        <div class="portal-stat-row">
          <div class="portal-stat-label">
            <span>Goal</span>
            <strong>${escapeHtml(recipe.goal || 'Custom data workflow')}</strong>
          </div>
        </div>
        ${asArray(recipe.entities).length ? `
          <div class="portal-stat-row">
            <div class="portal-stat-label">
              <span>Entities</span>
              <strong>${escapeHtml(asArray(recipe.entities).join(', '))}</strong>
            </div>
          </div>
        ` : ''}
        ${asArray(recipe.recommended_skills).length ? `
          <div class="portal-stat-row">
            <div class="portal-stat-label">
              <span>Recommended skills</span>
              <strong>${escapeHtml(asArray(recipe.recommended_skills).join(', '))}</strong>
            </div>
          </div>
        ` : ''}
      </div>
      ${asArray(recipe.outputs).length ? `
        <div>
          <p class="portal-panel-title" style="margin-bottom: 8px;">Target outputs</p>
          <p class="portal-panel-copy">${escapeHtml(asArray(recipe.outputs).join(' • '))}</p>
        </div>
      ` : ''}
      <div class="portal-button-row">
        <button class="portal-button" type="button" data-action="open-pipes">Inspect Pipes recipe</button>
      </div>
    </article>
  `
}

function renderChartPanel(panel, payload) {
  const chart = panel.chart_key === 'chart' ? payload.chart : getByPath(payload, panel.chart_key)
  if (!isRecord(chart)) {
    return renderPanelShell(panel, '<div class="portal-empty-copy">No chart data is available for this result.</div>', true)
  }

  const chartModel = buildChartModel(chart, payload)
  const chartId = registerChartModel(chartModel)
  if (!chartModel.series.length) {
    return renderPanelShell(panel, '<div class="portal-empty-copy">This chart has no plotted points in the current window.</div>', true)
  }

  return renderPanelShell(
    panel,
    `
      <div class="portal-chart">
        <div class="portal-chart-stage">
          ${renderChartSvg(chartModel, chartId)}
          <div class="portal-chart-overlay">
            <div class="portal-chart-crosshair portal-chart-crosshair--x" data-chart-crosshair-x="${chartId}"></div>
            <div class="portal-chart-crosshair portal-chart-crosshair--y" data-chart-crosshair-y="${chartId}"></div>
            <div class="portal-chart-tooltip" data-chart-tooltip="${chartId}"></div>
          </div>
        </div>
        ${chartModel.series.length > 1 ? renderLegend(chartModel.series) : ''}
      </div>
    `,
    true,
  )
}

function renderTablePanel(panel, payload) {
  const descriptor = findTableDescriptor(payload, panel.table_id)
  if (!descriptor) {
    return renderPanelShell(panel, '<div class="portal-empty-copy">No table metadata is available for this section.</div>')
  }

  const tableView = buildTableView(descriptor, payload)
  const searchEnabled = descriptor.interactions?.searchable !== false

  return renderPanelShell(
    panel,
    `
      <div class="portal-table-tools">
        ${searchEnabled ? `<input class="portal-search" type="search" value="${escapeAttribute(tableView.search)}" placeholder="Search rows" data-table-search="${escapeAttribute(descriptor.id)}" />` : '<div></div>'}
        <div class="portal-table-meta">
          <span>Showing ${tableView.start}-${tableView.end} of ${tableView.totalRows}</span>
          <span>Page ${tableView.page} of ${tableView.totalPages}</span>
        </div>
      </div>
      <div class="portal-table-wrap">
        <table class="portal-table">
          <thead>
            <tr>
              ${descriptor.columns.map((column) => renderTableHeader(descriptor, tableView, column)).join('')}
              <th>Inspect</th>
            </tr>
          </thead>
          <tbody>
            ${tableView.pageRows.length ? tableView.pageRows.map((row, index) => renderTableRow(descriptor, tableView, row, index)).join('') : '<tr><td colspan="99" class="portal-empty-copy">No rows match the current view.</td></tr>'}
          </tbody>
        </table>
      </div>
      <div class="portal-table-meta">
        <span>${escapeHtml(descriptor.subtitle || 'Interactive result table')}</span>
        <div class="portal-button-row">
          <button class="portal-button" type="button" data-table-page="${escapeAttribute(descriptor.id)}" data-direction="prev" ${tableView.page <= 1 ? 'disabled' : ''}>Previous</button>
          <button class="portal-button" type="button" data-table-page="${escapeAttribute(descriptor.id)}" data-direction="next" ${tableView.page >= tableView.totalPages ? 'disabled' : ''}>Next</button>
        </div>
      </div>
    `,
    true,
  )
}

function renderTimelinePanel(panel, payload) {
  const rows = asArray(getByPath(payload, panel.data_key))
  const visibleRows = rows.slice(0, 12)

  return renderPanelShell(
    panel,
    visibleRows.length
      ? `<div class="portal-timeline">${visibleRows.map((row, index) => renderTimelineItem(panel, row, index)).join('')}</div>`
      : '<div class="portal-empty-copy">No timeline rows are available in this window.</div>',
    panel.emphasis === 'primary',
  )
}

function renderRankedBarsPanel(panel, payload) {
  const rows = asArray(getByPath(payload, panel.data_key))
  const maxValue = Math.max(...rows.map((row) => toNumber(getByPath(row, panel.value_key)) || 0), 0)

  return renderPanelShell(
    panel,
    rows.length
      ? `<div class="portal-bars">${rows.slice(0, 10).map((row) => {
          const value = toNumber(getByPath(row, panel.value_key)) || 0
          const width = maxValue > 0 ? Math.max(6, (value / maxValue) * 100) : 0
          return `
            <div class="portal-bar-row">
              <div class="portal-bar-label">
                <span>${escapeHtml(String(getByPath(row, panel.category_key) ?? 'Unknown'))}</span>
                <span>${escapeHtml(formatValue(value, panel.value_format, panel.unit))}</span>
              </div>
              <div class="portal-bar-track"><div class="portal-bar-fill" style="width:${width}%"></div></div>
            </div>
          `
        }).join('')}</div>`
      : '<div class="portal-empty-copy">No ranked rows are available for this view.</div>',
  )
}

function renderStatListPanel(panel, payload) {
  const rows = asArray(getByPath(payload, panel.data_key))

  return renderPanelShell(
    panel,
    rows.length
      ? `<div class="portal-stat-list">${rows.slice(0, 12).map((row) => `
          <div class="portal-stat-row">
            <div class="portal-stat-label">
              <span>${escapeHtml(String(getByPath(row, panel.label_key) ?? 'Unknown'))}</span>
              <strong>${escapeHtml(formatValue(getByPath(row, panel.value_key), panel.value_format, panel.unit))}</strong>
            </div>
          </div>
        `).join('')}</div>`
      : '<div class="portal-empty-copy">No summary rows are available for this section.</div>',
  )
}

function renderPanelShell(panel, body, wide = false) {
  return `
    <article class="portal-panel ${wide ? 'portal-panel--wide' : ''}">
      <header class="portal-panel-header">
        <h2 class="portal-panel-title">${escapeHtml(panel.title || 'Panel')}</h2>
        ${panel.subtitle ? `<p class="portal-panel-copy">${escapeHtml(panel.subtitle)}</p>` : ''}
      </header>
      ${body}
    </article>
  `
}

function renderLegend(series) {
  return `<div class="portal-legend">${series.map((entry) => `
    <span class="portal-legend-item">
      <span class="portal-legend-dot" style="background:${entry.color}"></span>
      ${escapeHtml(entry.label)}
    </span>
  `).join('')}</div>`
}

function renderTableHeader(descriptor, tableView, column) {
  const active = tableView.sortKey === column.key
  const arrow = active ? (tableView.sortDirection === 'asc' ? '↑' : '↓') : '↕'
  const sortable = descriptor.interactions?.sortable !== false

  if (!sortable) {
    return `<th>${escapeHtml(column.label)}</th>`
  }

  return `
    <th>
      <button class="portal-table-sort" type="button" data-table-sort="${escapeAttribute(descriptor.id)}" data-column="${escapeAttribute(column.key)}">
        <span>${escapeHtml(column.label)}</span>
        <span>${arrow}</span>
      </button>
    </th>
  `
}

function renderTableRow(descriptor, tableView, row, index) {
  const absoluteIndex = (tableView.page - 1) * tableView.pageSize + index
  return `
    <tr>
      ${descriptor.columns.map((column) => {
        const value = getByPath(row, column.path || column.key)
        const formatted = formatValue(value, column.format, column.unit)
        return `<td title="${escapeAttribute(stringifyCellValue(value))}">${escapeHtml(formatted)}</td>`
      }).join('')}
      <td><button class="portal-table-row-button" type="button" data-row-open="${escapeAttribute(descriptor.id)}" data-row-index="${absoluteIndex}">Inspect</button></td>
    </tr>
  `
}

function renderTimelineItem(panel, row, index) {
  const timestamp = getByPath(row, panel.timestamp_key)
  const title = getByPath(row, panel.title_key)
  const subtitle = asArray(panel.subtitle_keys).map((key) => getByPath(row, key)).filter(Boolean).map((entry) => String(entry)).join(' • ')
  const badge = panel.badge_key ? getByPath(row, panel.badge_key) : undefined

  return `
    <article class="portal-timeline-item">
      <div class="portal-timeline-meta">
        <span class="portal-chip">${escapeHtml(formatValue(timestamp, 'timestamp_human'))}</span>
        ${badge ? `<span class="portal-timeline-badge">${escapeHtml(String(badge))}</span>` : ''}
      </div>
      <h3 class="portal-timeline-title">${escapeHtml(String(title ?? `Item ${index + 1}`))}</h3>
      ${subtitle ? `<p class="portal-timeline-copy">${escapeHtml(subtitle)}</p>` : ''}
      <div class="portal-button-row">
        <button class="portal-button" type="button" data-timeline-open="${escapeAttribute(panel.data_key)}" data-row-index="${index}">Inspect row</button>
      </div>
    </article>
  `
}

function renderChartSvg(chartModel, chartId) {
  const width = 1080
  const height = 320
  const padding = { top: 18, right: 72, bottom: 32, left: 18 }
  const chartWidth = width - padding.left - padding.right
  const chartHeight = height - padding.top - padding.bottom
  const minY = Number.isFinite(chartModel.minY) ? chartModel.minY : 0
  const maxY = Number.isFinite(chartModel.maxY) ? chartModel.maxY : 1
  const domain = Math.max(maxY - minY, 1)
  const gridCount = 6

  const grid = Array.from({ length: gridCount }, (_, index) => {
    const ratio = gridCount === 1 ? 0 : index / (gridCount - 1)
    const y = padding.top + chartHeight * ratio
    const labelValue = maxY - domain * ratio
    return `
      <line x1="${padding.left}" y1="${y}" x2="${width - padding.right}" y2="${y}" stroke="rgba(99, 118, 151, 0.16)" stroke-width="1" />
      <text x="${width - padding.right + 8}" y="${y + 4}" font-size="11" text-anchor="start" fill="rgba(170, 180, 198, 0.72)">${escapeHtml(formatValue(labelValue, chartModel.valueFormat, chartModel.unit))}</text>
    `
  }).join('')

  const xLabelIndexes = Array.from(new Set([
    0,
    Math.floor((chartModel.labels.length - 1) * 0.25),
    Math.floor((chartModel.labels.length - 1) * 0.5),
    Math.floor((chartModel.labels.length - 1) * 0.75),
    Math.max(chartModel.labels.length - 1, 0),
  ].filter((value) => value >= 0)))

  const xLabels = xLabelIndexes.map((index) => {
    const label = chartModel.labels[index]
    const x = padding.left + (chartWidth * index) / Math.max(chartModel.labels.length - 1, 1)
    return `<text x="${x}" y="${height - 10}" font-size="11" text-anchor="middle" fill="rgba(170, 180, 198, 0.66)">${escapeHtml(label)}</text>`
  }).join('')

  const seriesMarkup = chartModel.series.map((series, seriesIndex) => {
    const points = series.points.map((point, index) => {
      const x = padding.left + (chartWidth * index) / Math.max(series.points.length - 1, 1)
      const y = padding.top + chartHeight - (chartHeight * (point.value - minY)) / domain
      return { x, y }
    })

    if (chartModel.visual === 'bar' && seriesIndex === 0) {
      const barWidth = chartWidth / Math.max(points.length, 1) * 0.62
      return points.map((point, index) => {
        const nextX = padding.left + (chartWidth * index) / Math.max(points.length - 1, 1)
        const heightValue = padding.top + chartHeight - point.y
        return `
          <rect
            x="${nextX - barWidth / 2}"
            y="${point.y}"
            width="${Math.max(barWidth, 8)}"
            height="${heightValue}"
            rx="3"
            fill="${series.color}"
            fill-opacity="0.88"
          />
        `
      }).join('')
    }

    const linePath = points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`).join(' ')
    const areaPath = `${linePath} L ${points[points.length - 1].x} ${padding.top + chartHeight} L ${points[0].x} ${padding.top + chartHeight} Z`
    const gradientId = `${chartId}-${series.key || seriesIndex}`

    return `
      <defs>
        <linearGradient id="${gradientId}" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stop-color="${series.color}" stop-opacity="0.28"></stop>
          <stop offset="100%" stop-color="${series.color}" stop-opacity="0"></stop>
        </linearGradient>
      </defs>
      ${chartModel.series.length === 1 ? `<path d="${areaPath}" fill="url(#${gradientId})"></path>` : ''}
      <path d="${linePath}" fill="none" stroke="${series.color}" stroke-width="${chartModel.series.length === 1 ? 2.8 : 2.2}" stroke-linecap="round" stroke-linejoin="round"></path>
    `
  }).join('')

  return `
    <svg class="portal-chart-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeAttribute(chartModel.title)}" ${chartId ? `data-chart-id="${chartId}"` : ''}>
      <rect x="${padding.left}" y="${padding.top}" width="${chartWidth}" height="${chartHeight}" fill="rgba(10, 14, 21, 0.84)" />
      ${grid}
      <line x1="${padding.left}" y1="${padding.top + chartHeight}" x2="${width - padding.right}" y2="${padding.top + chartHeight}" stroke="rgba(99, 118, 151, 0.24)" stroke-width="1"></line>
      ${seriesMarkup}
      ${xLabels}
    </svg>
  `
}

function renderEmptyState() {
  if (state.loading) {
    return renderLoadingState()
  }

  return `
    <section class="portal-empty portal-panel--wide">
      <strong>Waiting for a Portal result</strong>
      <p class="portal-empty-copy">Run a supported tool like wallet summary or time series and the interactive view will appear here.</p>
    </section>
  `
}

function renderLoadingState() {
  return `
    <section class="portal-empty portal-panel--wide">
      <div class="portal-skeleton" style="width: 36%"></div>
      <div class="portal-skeleton" style="width: 82%"></div>
      <div class="portal-skeleton" style="width: 74%"></div>
    </section>
  `
}

function renderPartialState(payload) {
  const hasCursor = Boolean(payload?._pagination?.has_more)
  const coverage = payload?._coverage
  const incomplete =
    (coverage && typeof coverage === 'object' && coverage !== null && coverage.result_complete === false)
    || (coverage && typeof coverage === 'object' && coverage !== null && coverage.sampled === true)
  const message = incomplete
    ? 'This view is a partial preview of the requested window. Consider loading more results or switching to a deeper scan.'
    : 'More results are available for this view. Continue to load older or additional rows.'

  return `
    <section class="portal-partial portal-panel--wide">
      <strong>Partial results</strong>
      <p class="portal-empty-copy">${escapeHtml(message)}</p>
      ${hasCursor ? `
        <div class="portal-button-row">
          <button class="portal-button portal-button--accent" type="button" data-action="followup" data-intent="continue">
            Load more results
          </button>
        </div>
      ` : ''}
    </section>
  `
}

function renderError() {
  return `
    <section class="portal-error portal-panel--wide">
      <strong>Something went wrong</strong>
      <p class="portal-error-copy">${escapeHtml(state.error)}</p>
      <div class="portal-button-row">
        <button class="portal-button" type="button" data-action="toggle-raw">${state.rawOpen ? 'Hide raw response' : 'Show raw response'}</button>
      </div>
    </section>
  `
}

function renderRawPanel() {
  return `
    <section class="portal-raw portal-panel--wide" id="portal-raw">
      <header class="portal-panel-header">
        <h2 class="portal-panel-title">Raw result</h2>
        <p class="portal-panel-copy">Exact JSON payload returned by the Portal MCP tool.</p>
      </header>
      <pre>${escapeHtml(state.rawText)}</pre>
    </section>
  `
}

function renderDrawer() {
  const item = state.drawer?.item
  const title = state.drawer?.title || 'Selected row'
  return `
    <aside class="portal-drawer">
      <div class="portal-button-row" style="justify-content: space-between; align-items: center;">
        <div>
          <h2 class="portal-panel-title" style="margin-bottom: 4px;">${escapeHtml(title)}</h2>
          <p class="portal-drawer-copy">Evidence view for the selected result row.</p>
        </div>
        <button class="portal-button" type="button" data-action="close-drawer">Close</button>
      </div>
      <pre>${escapeHtml(JSON.stringify(item, null, 2))}</pre>
    </aside>
  `
}

function isPartialResult(payload) {
  if (!payload) return false
  if (payload?._pagination?.has_more) return true
  const coverage = payload?._coverage
  if (!coverage || typeof coverage !== 'object') return false
  return coverage.result_complete === false || coverage.sampled === true
}

function buildBadges(payload) {
  if (!payload?.display || !isRecord(payload.display)) return []

  const order = ['network', 'vm', 'focus', 'source']
  return order
    .filter((key) => payload.display[key])
    .map((key) => `
      <article class="portal-badge">
        <span class="portal-badge-key">${escapeHtml(humanize(key))}</span>
        <span class="portal-badge-value">${escapeHtml(String(payload.display[key]))}</span>
      </article>
    `)
}

function buildChartModel(chart, payload) {
  const rows = asArray(getByPath(payload, chart.data_key))
  const visual = chart.recommended_visual === 'bar' && !chart.grouped_value_field ? 'bar' : 'line'
  const labels = rows.map((row, index) => {
    const label = getByPath(row, 'timestamp_human') || getByPath(row, 'timestamp') || getByPath(row, chart.x_field) || `#${index + 1}`
    return String(formatValue(label, chart.x_field === 'timestamp' ? 'timestamp_human' : undefined))
  })

  let series = []

  if (chart.grouped_value_field && chart.grouped_value_mode === 'object_map') {
    const keys = Array.isArray(chart.series_keys) && chart.series_keys.length ? chart.series_keys : discoverSeriesKeys(rows, chart.grouped_value_field)
    series = keys.map((key, index) => ({
      key,
      label: humanize(key),
      color: ACCENT_COLORS[index % ACCENT_COLORS.length],
      points: rows.map((row, rowIndex) => ({
        label: labels[rowIndex],
        value: toNumber(getByPath(row, `${chart.grouped_value_field}.${key}`)) || 0,
      })),
    }))
  } else if (chart.grouped_value_field) {
    const grouped = new Map()
    const xLabelMap = new Map()
    for (const [index, row] of rows.entries()) {
      const key = String(getByPath(row, chart.grouped_value_field) || 'Other')
      if (!grouped.has(key)) grouped.set(key, [])
      grouped.get(key).push(row)
      const xValue = getByPath(row, chart.x_field || 'timestamp') ?? getByPath(row, 'timestamp')
      if (!xLabelMap.has(xValue)) {
        xLabelMap.set(xValue, labels[index])
      }
    }

    const uniqueX = Array.from(xLabelMap.entries()).map(([value, label]) => ({ value, label }))

    series = Array.from(grouped.entries()).map(([key, groupedRows], index) => {
      const byX = new Map()
      groupedRows.forEach((row) => {
        const xValue = getByPath(row, chart.x_field || 'timestamp') ?? getByPath(row, 'timestamp')
        byX.set(xValue, toNumber(getByPath(row, chart.y_field || 'value')) || 0)
      })

      return {
        key,
        label: humanize(key),
        color: ACCENT_COLORS[index % ACCENT_COLORS.length],
        points: uniqueX.map((entry) => ({
          label: entry.label || String(entry.value),
          value: byX.get(entry.value) || 0,
        })),
      }
    })
  } else {
    series = [
      {
        key: chart.y_field || 'value',
        label: humanize(chart.y_axis_label || chart.y_field || 'value'),
        color: ACCENT_COLORS[0],
        points: rows.map((row, index) => ({
          label: labels[index],
          value: toNumber(getByPath(row, chart.y_field || 'value')) || 0,
        })),
      },
    ]
  }

  const values = series.flatMap((entry) => entry.points.map((point) => point.value)).filter((value) => Number.isFinite(value))
  const rawMin = values.length ? Math.min(...values) : 0
  const rawMax = values.length ? Math.max(...values) : 0
  const range = rawMax - rawMin
  let minY = visual === 'bar' ? Math.min(0, rawMin) : rawMin
  let maxY = visual === 'bar' ? Math.max(0, rawMax) : rawMax

  if (visual === 'line') {
    const padding = range > 0 ? range * 0.12 : Math.max(Math.abs(rawMax) * 0.12, 1)
    minY = rawMin - padding
    maxY = rawMax + padding
    if (rawMin >= 0) {
      minY = Math.max(0, minY)
    }
  }

  if (minY === maxY) {
    maxY = minY + 1
  }

  return {
    title: chart.title || 'Chart',
    series,
    labels: series[0]?.points.map((point) => point.label) || labels,
    maxY,
    minY,
    unit: chart.unit,
    valueFormat: chart.value_format,
    visual,
  }
}

function registerChartModel(chartModel) {
  const id = `chart-${Math.random().toString(36).slice(2, 9)}`
  state.chartModels[id] = chartModel
  return id
}

function discoverSeriesKeys(rows, groupedValueField) {
  const keys = new Set()
  for (const row of rows) {
    const value = getByPath(row, groupedValueField)
    if (isRecord(value)) {
      Object.keys(value).forEach((key) => keys.add(key))
    }
  }
  return Array.from(keys)
}

function buildTableView(descriptor, payload) {
  const tableState = state.tableState[descriptor.id] || {
    search: '',
    page: 1,
    sortKey: descriptor.columns?.[0]?.key || '',
    sortDirection: 'asc',
  }

  const allRows = asArray(getByPath(payload, descriptor.data_key))
  const search = tableState.search.trim().toLowerCase()
  const filteredRows = search
    ? allRows.filter((row) => descriptor.columns.some((column) => stringifyCellValue(getByPath(row, column.path || column.key)).toLowerCase().includes(search)))
    : allRows

  const sortKey = tableState.sortKey
  const sortColumn = descriptor.columns.find((column) => column.key === sortKey) || descriptor.columns[0]
  const sortedRows = [...filteredRows].sort((left, right) => compareValues(
    getByPath(left, sortColumn?.path || sortColumn?.key),
    getByPath(right, sortColumn?.path || sortColumn?.key),
    tableState.sortDirection,
  ))

  const pageSize = Math.max(1, descriptor.interactions?.default_page_size || 10)
  const totalRows = sortedRows.length
  const totalPages = Math.max(1, Math.ceil(totalRows / pageSize))
  const page = Math.min(tableState.page, totalPages)
  const startIndex = (page - 1) * pageSize
  const pageRows = sortedRows.slice(startIndex, startIndex + pageSize)

  return {
    search: tableState.search,
    sortKey: tableState.sortKey,
    sortDirection: tableState.sortDirection,
    page,
    pageSize,
    totalRows,
    totalPages,
    start: totalRows ? startIndex + 1 : 0,
    end: Math.min(startIndex + pageRows.length, totalRows),
    pageRows,
    rows: sortedRows,
  }
}

function attachEventHandlers() {
  root.querySelectorAll('[data-action="followup"]').forEach((button) => {
    button.addEventListener('click', async () => {
      const intent = button.getAttribute('data-intent') || 'show_raw'
      const target = button.getAttribute('data-target') || undefined
      await handleFollowUp(intent, target)
    })
  })

  root.querySelectorAll('[data-action="toggle-raw"]').forEach((button) => {
    button.addEventListener('click', () => {
      state.rawOpen = !state.rawOpen
      render()
    })
  })

  root.querySelectorAll('[data-action="open-raw"]').forEach((button) => {
    button.addEventListener('click', () => {
      state.rawOpen = true
      render()
      const rawPanel = document.getElementById('portal-raw')
      if (rawPanel && typeof rawPanel.scrollIntoView === 'function') {
        rawPanel.scrollIntoView({ behavior: 'smooth', block: 'start' })
      }
    })
  })

  root.querySelectorAll('[data-action="copy-raw"]').forEach((button) => {
    button.addEventListener('click', async () => {
      await copyToClipboard(state.rawText || '')
    })
  })

  root.querySelectorAll('[data-action="copy-args"]').forEach((button) => {
    button.addEventListener('click', async () => {
      await copyToClipboard(JSON.stringify(state.currentArgs || {}, null, 2))
    })
  })

  root.querySelectorAll('[data-action="close-drawer"]').forEach((button) => {
    button.addEventListener('click', () => {
      state.drawer = null
      render()
    })
  })

  root.querySelectorAll('[data-action="open-pipes"]').forEach((button) => {
    button.addEventListener('click', () => {
      if (!state.payload?.pipes_handoff) return
      state.drawer = {
        title: state.payload.pipes_handoff.title || 'Pipes recipe',
        item: state.payload.pipes_handoff,
      }
      render()
    })
  })

  root.querySelectorAll('[data-table-search]').forEach((input) => {
    input.addEventListener('input', (event) => {
      const tableId = input.getAttribute('data-table-search')
      if (!tableId || !state.tableState[tableId]) return
      state.tableState[tableId].search = event.target.value
      state.tableState[tableId].page = 1
      render()
    })
  })

  root.querySelectorAll('[data-table-sort]').forEach((button) => {
    button.addEventListener('click', () => {
      const tableId = button.getAttribute('data-table-sort')
      const column = button.getAttribute('data-column')
      if (!tableId || !column) return
      const current = state.tableState[tableId]
      if (!current) return
      if (current.sortKey === column) {
        current.sortDirection = current.sortDirection === 'asc' ? 'desc' : 'asc'
      } else {
        current.sortKey = column
        current.sortDirection = 'asc'
      }
      render()
    })
  })

  root.querySelectorAll('[data-table-page]').forEach((button) => {
    button.addEventListener('click', () => {
      const tableId = button.getAttribute('data-table-page')
      const direction = button.getAttribute('data-direction')
      if (!tableId || !direction || !state.tableState[tableId]) return
      const delta = direction === 'next' ? 1 : -1
      state.tableState[tableId].page = Math.max(1, state.tableState[tableId].page + delta)
      render()
    })
  })

  root.querySelectorAll('[data-row-open]').forEach((button) => {
    button.addEventListener('click', () => {
      const tableId = button.getAttribute('data-row-open')
      const rowIndex = Number(button.getAttribute('data-row-index'))
      if (!tableId || !Number.isFinite(rowIndex)) return
      const descriptor = findTableDescriptor(state.payload, tableId)
      if (!descriptor) return
      const tableView = buildTableView(descriptor, state.payload)
      state.drawer = {
        title: `${descriptor.title || 'Table row'} #${rowIndex + 1}`,
        item: tableView.rows[rowIndex],
      }
      render()
    })
  })

  root.querySelectorAll('[data-timeline-open]').forEach((button) => {
    button.addEventListener('click', () => {
      const dataKey = button.getAttribute('data-timeline-open')
      const rowIndex = Number(button.getAttribute('data-row-index'))
      const rows = asArray(getByPath(state.payload, dataKey))
      if (!Number.isFinite(rowIndex) || !rows[rowIndex]) return
      state.drawer = {
        title: 'Timeline row',
        item: rows[rowIndex],
      }
      render()
    })
  })

  root.querySelectorAll('[data-chart-id]').forEach((svg) => {
    const chartId = svg.getAttribute('data-chart-id')
    if (!chartId || !state.chartModels[chartId]) return
    const stage = svg.closest('.portal-chart-stage')
    const tooltip = root.querySelector(`[data-chart-tooltip="${chartId}"]`)
    const crosshairX = root.querySelector(`[data-chart-crosshair-x="${chartId}"]`)
    const crosshairY = root.querySelector(`[data-chart-crosshair-y="${chartId}"]`)
    const chartModel = state.chartModels[chartId]
    const width = 1080
    const height = 320
    const paddingTop = 18
    const paddingBottom = 32
    const paddingLeft = 18
    const paddingRight = 72
    const chartWidth = width - paddingLeft - paddingRight
    const chartHeight = height - paddingTop - paddingBottom
    const minY = Number.isFinite(chartModel.minY) ? chartModel.minY : 0
    const maxY = Number.isFinite(chartModel.maxY) ? chartModel.maxY : 1
    const domain = Math.max(maxY - minY, 1)

    const hideTooltip = () => {
      if (tooltip) tooltip.style.display = 'none'
      if (crosshairX) crosshairX.style.opacity = '0'
      if (crosshairY) crosshairY.style.opacity = '0'
    }

    svg.addEventListener('mouseleave', hideTooltip)
    svg.addEventListener('mousemove', (event) => {
      if (!tooltip || !stage) return
      const rect = svg.getBoundingClientRect()
      const x = event.clientX - rect.left
      const ratio = Math.min(1, Math.max(0, (x - paddingLeft) / chartWidth))
      const index = Math.round(ratio * Math.max(chartModel.labels.length - 1, 0))
      const label = chartModel.labels[index] || `#${index + 1}`
      const entries = chartModel.series.map((series) => ({
        label: series.label,
        value: series.points[index]?.value ?? 0,
        color: series.color,
      }))
      const primaryValue = entries[0]?.value ?? minY
      const yRatio = Math.min(1, Math.max(0, (primaryValue - minY) / domain))
      const stageRect = stage.getBoundingClientRect()
      const stageX = paddingLeft + ratio * chartWidth
      const stageY = paddingTop + chartHeight - yRatio * chartHeight
      const tooltipWidth = 180
      const tooltipLeft = Math.max(10, Math.min(
        stageX > stageRect.width - tooltipWidth - 24 ? stageX - tooltipWidth - 14 : stageX + 14,
        stageRect.width - tooltipWidth - 10,
      ))
      const tooltipTop = Math.max(10, Math.min(stageY - 18, stageRect.height - 96))

      tooltip.innerHTML = `
        <strong>${escapeHtml(label)}</strong>
        ${entries.map((entry) => `
          <div style="display:flex; align-items:center; justify-content:space-between; gap:12px; margin-top:6px;">
            <span style="display:inline-flex; align-items:center; gap:6px; color:var(--portal-text-muted);">
              <span style="width:8px;height:8px;border-radius:999px;background:${entry.color}"></span>
              <span>${escapeHtml(entry.label)}</span>
            </span>
            <span style="color:var(--portal-text);">${escapeHtml(formatValue(entry.value, chartModel.valueFormat, chartModel.unit))}</span>
          </div>
        `).join('')}
      `
      tooltip.style.display = 'block'
      tooltip.style.left = `${tooltipLeft}px`
      tooltip.style.top = `${tooltipTop}px`

      if (crosshairX) {
        crosshairX.style.opacity = '1'
        crosshairX.style.transform = `translateX(${stageX}px)`
      }

      if (crosshairY) {
        crosshairY.style.opacity = '1'
        crosshairY.style.transform = `translateY(${stageY}px)`
      }
    })

    stage.addEventListener('mouseleave', hideTooltip)
  })
}

async function handleFollowUp(intent, target) {
  if (intent === 'show_raw') {
    state.rawOpen = !state.rawOpen
    render()
    return
  }

  const toolName = state.payload?._tool_contract?.name
  if (!toolName) {
    state.error = 'This result does not expose a follow-up tool call.'
    render()
    return
  }

  if (intent === 'continue') {
    const cursor = state.payload?._pagination?.next_cursor
    if (!cursor) return
    await executeToolCall(toolName, { cursor })
    return
  }

  if (intent === 'compare_previous') {
    await executeToolCall(toolName, {
      ...state.currentArgs,
      compare_previous: true,
    })
    return
  }

  if (intent === 'zoom_in') {
    const nextDuration = ZOOM_DURATION_MAP[state.currentArgs?.duration] || state.currentArgs?.duration
    await executeToolCall(toolName, {
      ...state.currentArgs,
      ...(nextDuration ? { duration: nextDuration } : {}),
    })
    return
  }

  if (intent === 'drilldown' && target) {
    const value = getByPath(state.payload, target)
    state.drawer = {
      title: humanize(target),
      item: value,
    }
    render()
    return
  }
}

async function copyToClipboard(text) {
  if (!text) {
    state.statusMessage = 'Nothing to copy'
    render()
    clearStatus()
    return
  }

  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
    } else {
      const temp = document.createElement('textarea')
      temp.value = text
      document.body.appendChild(temp)
      temp.select()
      document.execCommand('copy')
      temp.remove()
    }
    state.statusMessage = 'Copied'
  } catch {
    state.statusMessage = 'Copy failed'
  }

  render()
  clearStatus()
}

function clearStatus() {
  setTimeout(() => {
    state.statusMessage = ''
    render()
  }, 1800)
}
async function executeToolCall(name, args) {
  state.loading = true
  state.error = ''
  render()

  try {
    state.currentArgs = args || {}
    const result = await app.callServerTool({
      name,
      arguments: args,
    })
    consumeToolResult(result)
  } catch (error) {
    state.loading = false
    state.error = error instanceof Error ? error.message : 'Follow-up request failed.'
    render()
  }
}

function findTableDescriptor(payload, tableId) {
  return asArray(payload?.tables).find((descriptor) => isRecord(descriptor) && descriptor.id === tableId)
}

function extractText(content) {
  if (!Array.isArray(content)) return ''
  const textPart = content.find((entry) => isRecord(entry) && entry.type === 'text' && typeof entry.text === 'string')
  return textPart?.text || ''
}

function asArray(value) {
  return Array.isArray(value) ? value : []
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function getByPath(value, path) {
  if (!path) return value
  const tokens = String(path)
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter(Boolean)

  let current = value
  for (const token of tokens) {
    if (!isRecord(current) && !Array.isArray(current)) return undefined
    current = current[token]
  }
  return current
}

function compareValues(left, right, direction) {
  const multiplier = direction === 'desc' ? -1 : 1
  const leftNumeric = toNumber(left)
  const rightNumeric = toNumber(right)
  if (leftNumeric !== null && rightNumeric !== null) {
    return (leftNumeric - rightNumeric) * multiplier
  }
  return String(left ?? '').localeCompare(String(right ?? '')) * multiplier
}

function toNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return null
    const parsed = Number(trimmed)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function stringifyCellValue(value) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function formatValue(value, format, unit) {
  if (value === null || value === undefined || value === '') return 'n/a'

  if (format === 'timestamp_human') {
    return typeof value === 'string' ? value : formatTimestamp(value)
  }

  if (format === 'timestamp') {
    return formatTimestamp(value)
  }

  if (format === 'address' && typeof value === 'string') {
    return value.length > 14 ? `${value.slice(0, 8)}...${value.slice(-4)}` : value
  }

  const numeric = toNumber(value)
  if (numeric !== null) {
    switch (format) {
      case 'integer':
        return `${Math.round(numeric).toLocaleString('en-US')}${unit ? ` ${unit}` : ''}`
      case 'percent':
        return `${numeric.toLocaleString('en-US', { maximumFractionDigits: 2 })}%`
      case 'currency_usd':
        return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: numeric >= 100 ? 0 : 2 }).format(numeric)
      case 'gwei':
        return `${numeric.toLocaleString('en-US', { maximumFractionDigits: 2 })} gwei`
      case 'bytes':
        return formatBytes(numeric)
      case 'btc':
        return `${numeric.toLocaleString('en-US', { maximumFractionDigits: 8 })} BTC`
      case 'compact_number':
        return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(numeric)
      case 'decimal':
      default:
        return `${numeric.toLocaleString('en-US', { maximumFractionDigits: 4 })}${unit ? ` ${unit}` : ''}`
    }
  }

  if (typeof value === 'string') return value
  return stringifyCellValue(value)
}

function formatTimestamp(value) {
  const numeric = toNumber(value)
  if (numeric === null) return String(value)
  const millis = numeric > 10_000_000_000 ? numeric : numeric * 1000
  return new Date(millis).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

function formatBytes(value) {
  if (!Number.isFinite(value)) return String(value)
  if (value < 1024) return `${Math.round(value)} B`
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`
  return `${(value / 1024 ** 3).toFixed(1)} GB`
}

function humanize(value) {
  return String(value)
    .replace(/^portal_/, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\bmainnet\b/gi, '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => {
      const lower = part.toLowerCase()
      if (['evm', 'btc', 'usd', 'ohlc', 'tps'].includes(lower)) return lower.toUpperCase()
      if (/^0x[0-9a-f]+$/i.test(part)) return part
      return lower.charAt(0).toUpperCase() + lower.slice(1)
    })
    .join(' ')
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function escapeAttribute(value) {
  return escapeHtml(value).replaceAll("'", '&#39;')
}
