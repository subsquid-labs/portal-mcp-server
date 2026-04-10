import { Counter, Histogram, Gauge, Registry, collectDefaultMetrics } from 'prom-client'

import { npmVersion } from './version.js'

// ============================================================================
// Prometheus Metrics
// ============================================================================

export const register = new Registry()

collectDefaultMetrics({ register })

export const serverInfo = new Gauge({
  name: 'mcp_server_info',
  help: 'Static server info for the running MCP instance',
  labelNames: ['server_version', 'service_name', 'runtime'] as const,
  registers: [register],
})

serverInfo.set(
  {
    server_version: npmVersion,
    service_name: 'sqd-portal-mcp',
    runtime: 'node',
  },
  1,
)

// --- MCP Tool Metrics ---

export const toolCallsTotal = new Counter({
  name: 'mcp_tool_calls_total',
  help: 'Total number of MCP tool invocations',
  labelNames: ['tool', 'status', 'transport', 'server_version'] as const,
  registers: [register],
})

export const toolCallDuration = new Histogram({
  name: 'mcp_tool_call_duration_seconds',
  help: 'Duration of MCP tool invocations in seconds',
  labelNames: ['tool', 'transport'] as const,
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
  registers: [register],
})

export const toolCallsActive = new Gauge({
  name: 'mcp_tool_calls_active',
  help: 'Number of currently in-flight MCP tool calls',
  labelNames: ['tool', 'transport'] as const,
  registers: [register],
})

export const toolErrorsTotal = new Counter({
  name: 'mcp_tool_errors_total',
  help: 'Total number of MCP tool errors by type',
  labelNames: ['tool', 'transport', 'error_type'] as const,
  registers: [register],
})

export const toolResponseSizeBytes = new Histogram({
  name: 'mcp_tool_response_size_bytes',
  help: 'Serialized MCP response size in bytes',
  labelNames: ['tool', 'transport'] as const,
  buckets: [512, 1024, 2048, 4096, 8192, 16384, 32768, 65536, 131072],
  registers: [register],
})

export const toolIntentCallsTotal = new Counter({
  name: 'mcp_tool_intent_calls_total',
  help: 'Total number of MCP tool invocations by intent and VM family',
  labelNames: ['tool', 'intent', 'vm'] as const,
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
  labelNames: ['dataset', 'vm'] as const,
  registers: [register],
})

export const clientRequestsTotal = new Counter({
  name: 'mcp_client_requests_total',
  help: 'Total number of HTTP MCP requests by declared client',
  labelNames: ['transport', 'client_name', 'client_version'] as const,
  registers: [register],
})

export const observabilityExportsTotal = new Counter({
  name: 'mcp_observability_exports_total',
  help: 'Total number of observability export attempts',
  labelNames: ['sink', 'status'] as const,
  registers: [register],
})
