import { Counter, Histogram, Gauge, Registry, collectDefaultMetrics } from 'prom-client'

// ============================================================================
// Prometheus Metrics
// ============================================================================

export const register = new Registry()

collectDefaultMetrics({ register })

// --- MCP Tool Metrics ---

export const toolCallsTotal = new Counter({
  name: 'mcp_tool_calls_total',
  help: 'Total number of MCP tool invocations',
  labelNames: ['tool', 'status'] as const,
  registers: [register],
})

export const toolCallDuration = new Histogram({
  name: 'mcp_tool_call_duration_seconds',
  help: 'Duration of MCP tool invocations in seconds',
  labelNames: ['tool'] as const,
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
  registers: [register],
})

export const toolCallsActive = new Gauge({
  name: 'mcp_tool_calls_active',
  help: 'Number of currently in-flight MCP tool calls',
  labelNames: ['tool'] as const,
  registers: [register],
})

// --- Portal API Metrics ---

export const portalRequestsTotal = new Counter({
  name: 'mcp_portal_api_requests_total',
  help: 'Total number of requests to the Portal API',
  labelNames: ['method', 'status_code'] as const,
  registers: [register],
})

// --- Dataset Metrics ---

export const datasetQueriesTotal = new Counter({
  name: 'mcp_dataset_queries_total',
  help: 'Total number of queries per dataset',
  labelNames: ['dataset'] as const,
  registers: [register],
})
