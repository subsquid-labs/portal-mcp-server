#!/usr/bin/env node
// squid-perf / report.mjs
// Read parsed squid logs + compare-syncs config, compute metrics, render HTML + MD.
//
// Usage:
//   node report.mjs --run-dir <path> [--breakpoints 500K,1M,...] [--downtime-threshold 120]

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const TEMPLATE_PATH = path.join(__dirname, '..', 'templates', 'report.html')

const DEFAULT_DOWNTIME_THRESHOLD_SEC = 120
const CHART_SAMPLE_POINTS = 200 // approximate data points per chart line
const BREAKPOINT_COUNT = 10 // percentage-based: 10%, 20%, ..., 100% of effective range
const CATCHUP_GAP_BLOCKS = 10 // current within N blocks of target = "caught up to chain tip".
// First such progress row marks end-of-productive-sync; anything
// after is idle tail (processing new chain blocks at real-time
// rate, not syncing history). This is the indexer's own
// definition of caught-up — more accurate than any fraction of
// the block range, which can't distinguish "few blocks, long
// idle" from "many blocks, short idle".

// --------- CLI ---------

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const next = argv[i + 1]
      if (next && !next.startsWith('--')) {
        out[a.slice(2)] = next
        i++
      } else {
        out[a.slice(2)] = true
      }
    }
  }
  return out
}

function parseShortNumber(s) {
  if (typeof s === 'number') return s
  const m = String(s)
    .trim()
    .match(/^(\d+(?:\.\d+)?)\s*([kKmMbB])?$/)
  if (!m) return NaN
  const n = parseFloat(m[1])
  const mult = { k: 1e3, m: 1e6, b: 1e9 }[(m[2] || '').toLowerCase()] || 1
  return n * mult
}

function formatShortNumber(n) {
  if (n == null || Number.isNaN(n)) return '—'
  const a = Math.abs(n)
  if (a >= 1e9) return (n / 1e9).toFixed(a >= 1e10 ? 0 : 1).replace(/\.0$/, '') + 'B'
  if (a >= 1e6) return (n / 1e6).toFixed(a >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'M'
  if (a >= 1e3) return (n / 1e3).toFixed(a >= 1e4 ? 0 : 1).replace(/\.0$/, '') + 'K'
  return String(n)
}

function formatDuration(ms) {
  if (ms == null || Number.isNaN(ms)) return '—'
  if (ms < 0) ms = 0
  const sec = Math.round(ms / 1000)
  if (sec < 60) return `${sec}s`
  const min = Math.floor(sec / 60)
  const s = sec % 60
  if (min < 60) return s ? `${min}m ${s}s` : `${min}m`
  const hr = Math.floor(min / 60)
  const m = min % 60
  if (hr < 24) return m ? `${hr}h ${m}m` : `${hr}h`
  const d = Math.floor(hr / 24)
  const h = hr % 24
  return h ? `${d}d ${h}h` : `${d}d`
}

function pct(a, b) {
  if (!isFinite(a) || !isFinite(b) || b === 0) return null
  return (a - b) / b
}

function formatPct(p) {
  if (p == null) return '—'
  const sign = p > 0 ? '+' : ''
  return `${sign}${(p * 100).toFixed(1)}%`
}

function escapeMd(s) {
  return String(s).replace(/\|/g, '\\|')
}

function readDeploymentFailures(runDir, config) {
  const failuresPath = path.join(runDir, 'failures.json')
  if (!fs.existsSync(failuresPath)) return []

  const value = JSON.parse(fs.readFileSync(failuresPath, 'utf8'))
  if (!Array.isArray(value)) throw new Error(`failures.json must contain an array at ${failuresPath}`)
  const refsByLabel = new Map(config.indexers.map((i) => [i.label, i.ref]))

  return value.map((failure, index) => {
    if (!failure || typeof failure !== 'object' || Array.isArray(failure)) {
      throw new Error(`failures.json entry ${index} must be an object`)
    }
    const label = typeof failure.label === 'string' ? failure.label.trim() : ''
    if (!label) throw new Error(`failures.json entry ${index} must include a label`)
    const stage = failure.stage
    if (stage !== 'fetch' && stage !== 'parse') {
      throw new Error(`failures.json entry ${index} stage must be fetch or parse`)
    }
    const ref =
      typeof failure.ref === 'string' && failure.ref.trim() ? failure.ref.trim() : refsByLabel.get(label) || label
    const message =
      typeof failure.message === 'string' && failure.message.trim() ? failure.message.trim() : `${stage} failed`
    return { label, ref, stage, message }
  })
}

// --------- Breakpoint generation ---------

function generateBreakpoints(effectiveRange, count = BREAKPOINT_COUNT) {
  // Percentage-based: evenly split the effective range into N buckets, report cumulative
  // block-counts at 100/N, 200/N, ..., 100% of the range.
  // `effectiveRange` is caller-supplied = (catchup_block - first_block) when catchup was
  // detected, else (last_block - first_block).
  if (effectiveRange <= 0) return []
  const actualCount = Math.min(count, Math.floor(effectiveRange))
  const out = []
  for (let i = 1; i <= actualCount; i++) {
    const breakpoint = Math.max(1, Math.round((effectiveRange * i) / actualCount))
    if (out[out.length - 1] !== breakpoint) out.push(breakpoint)
  }
  if (out[out.length - 1] !== effectiveRange) out.push(effectiveRange)
  return out
}

// Find the first progress row where the indexer reached chain tip (current within
// CATCHUP_GAP_BLOCKS of target). progressRows MUST be sorted ascending by tsMs.
// Returns { tsMs, block, target, rowIndex } or null.
function findCatchupPoint(progressRows) {
  if (!progressRows || progressRows.length === 0) return null
  for (let i = 0; i < progressRows.length; i++) {
    const row = progressRows[i]
    const current = row[1]
    const target = row[2]
    if (target == null || target <= 0) continue
    if (target - current <= CATCHUP_GAP_BLOCKS) {
      return { tsMs: row[0], block: current, target, rowIndex: i, sequence: row[7] ?? null }
    }
  }
  return null
}

function formatPctLabel(bp, maxBp) {
  if (maxBp <= 0) return formatShortNumber(bp)
  const pct = Math.round((bp / maxBp) * 100)
  return `${pct}% (${formatShortNumber(bp)} blocks)`
}

function formatIntervalLabel(from, to, maxBp) {
  if (maxBp <= 0) return `${formatShortNumber(from)} → ${formatShortNumber(to)}`
  const pctFrom = Math.round((from / maxBp) * 100)
  const pctTo = Math.round((to / maxBp) * 100)
  return `${pctFrom}% → ${pctTo}% (${formatShortNumber(to - from)} blocks)`
}

// --------- Timing computations ---------

function findFirstCrossingTs(progressRows, targetBlock) {
  for (const row of progressRows) {
    if (row[1] >= targetBlock) return row[0]
  }
  return null
}

function computeDowntimeMs(progressRows, startTsMs, endTsMs, downtimeThresholdMs) {
  if (endTsMs <= startTsMs) return 0
  let downtime = 0
  let prev = startTsMs
  for (const row of progressRows) {
    const ts = row[0]
    if (ts <= startTsMs) continue
    if (ts > endTsMs) break
    const gap = ts - prev
    if (gap > downtimeThresholdMs) downtime += gap
    prev = ts
  }
  return downtime
}

function computeIntervalStats(progressRows, fromBlock, toBlock) {
  const rateArr = [],
    mapArr = [],
    itemsArr = []
  for (const row of progressRows) {
    const cur = row[1]
    // Adjacent intervals are (fromBlock, toBlock], so a boundary sample belongs
    // only to the interval it completes rather than being counted twice.
    if (cur <= fromBlock || cur > toBlock) continue
    if (row[3] != null) rateArr.push(row[3])
    if (row[4] != null) mapArr.push(row[4])
    if (row[5] != null) itemsArr.push(row[5])
  }
  return {
    avgRate: avg(rateArr),
    avgMapping: avg(mapArr),
    avgItems: avg(itemsArr),
    samples: rateArr.length,
  }
}

function progressRowsThroughCatchup(deployment) {
  if (deployment.catchup == null || deployment.wasAlreadyCaughtUp) {
    return deployment.progressRows
  }
  return deployment.progressRows.slice(0, deployment.catchup.rowIndex + 1)
}

function multicallsThroughCatchup(deployment) {
  if (deployment.catchup == null || deployment.wasAlreadyCaughtUp) {
    return deployment.multicall
  }
  const { tsMs, sequence } = deployment.catchup
  return deployment.multicall.filter(
    (sample) =>
      sample.tsMs < tsMs ||
      (sample.tsMs === tsMs && sequence != null && sample.sequence != null && sample.sequence <= sequence),
  )
}

function tier3SamplesFromMeasurementStart(samples, deployment) {
  const start = deployment.progressRows?.[0]
  return start == null
    ? samples
    : samples.filter(
        (sample) =>
          sample.tsMs > start[0] ||
          (sample.tsMs === start[0] && start[7] != null && sample.sequence != null && sample.sequence >= start[7]),
      )
}

function tier3SamplesInMeasurementWindow(samples, deployment) {
  const bounded = tier3SamplesFromMeasurementStart(samples, deployment)
  if (deployment.catchup == null || deployment.wasAlreadyCaughtUp) return bounded
  const { tsMs, sequence } = deployment.catchup
  return bounded.filter(
    (sample) =>
      sample.tsMs < tsMs ||
      (sample.tsMs === tsMs && sequence != null && sample.sequence != null && sample.sequence <= sequence),
  )
}

function multicallStatsInRange(multicall, fromBlock, toBlock) {
  const latencies = [],
    callCounts = []
  for (const mc of multicall) {
    if (mc.block <= fromBlock || mc.block > toBlock) continue
    latencies.push(mc.latencyMs)
    callCounts.push(mc.calls)
  }
  if (latencies.length === 0) return null
  return {
    invocations: latencies.length,
    avgLatencyMs: avg(latencies),
    p95LatencyMs: percentile(latencies, 0.95),
    totalCalls: sum(callCounts),
    avgCallsPerInvocation: avg(callCounts),
  }
}

function tier3Aggregate(samples) {
  // samples: [{ tsMs, sequence, fields: {unit: value, ...} }, ...]
  const byField = new Map()
  for (const s of samples) {
    for (const [k, v] of Object.entries(s.fields)) {
      let arr = byField.get(k)
      if (!arr) {
        arr = []
        byField.set(k, arr)
      }
      arr.push(v)
    }
  }
  const out = {}
  for (const [k, arr] of byField) {
    out[k] = {
      count: arr.length,
      sum: sum(arr),
      mean: avg(arr),
      median: percentile(arr, 0.5),
      p95: percentile(arr, 0.95),
      min: Math.min(...arr),
      max: Math.max(...arr),
    }
  }
  return out
}

// Non-sync services have no progress rows, so use the parser's whole-service
// first/last ts if present (parser version ≥ 2). For older parsed JSON, fall
// back to the min/max of any time-stamped sample we can find.
function nonSyncFirstTsMs(s) {
  if (s.firstTsMs != null) return s.firstTsMs
  const candidates = []
  for (const t3 of Object.values(s.tier3 || {})) {
    if (t3.samples?.[0]?.tsMs != null) candidates.push(t3.samples[0].tsMs)
  }
  if (s.multicall?.[0]?.tsMs != null) candidates.push(s.multicall[0].tsMs)
  if (s.errors?.[0]?.tsMs != null) candidates.push(s.errors[0].tsMs)
  return candidates.length ? Math.min(...candidates) : null
}
function nonSyncLastTsMs(s) {
  if (s.lastTsMs != null) return s.lastTsMs
  const candidates = []
  for (const t3 of Object.values(s.tier3 || {})) {
    const last = t3.samples?.[t3.samples.length - 1]
    if (last?.tsMs != null) candidates.push(last.tsMs)
  }
  const mc = s.multicall || []
  if (mc[mc.length - 1]?.tsMs != null) candidates.push(mc[mc.length - 1].tsMs)
  const er = s.errors || []
  if (er[er.length - 1]?.tsMs != null) candidates.push(er[er.length - 1].tsMs)
  return candidates.length ? Math.max(...candidates) : null
}

function nonSyncSnapshot(s) {
  const first = nonSyncFirstTsMs(s)
  const last = nonSyncLastTsMs(s)
  let lineCount = s.errorCount || 0
  lineCount += (s.multicall || []).length
  for (const t3 of Object.values(s.tier3 || {})) lineCount += t3.count || 0
  return {
    nonSync: true,
    firstTsMs: first,
    lastTsMs: last,
    spanMs: first != null && last != null ? last - first : null,
    lineCount,
    tier3: s.tier3 || {},
    multicall: s.multicall || [],
    errors: s.errors || [],
    errorCount: s.errorCount || 0,
    levelCounts: s.levelCounts || null,
  }
}

function avg(arr) {
  if (!arr || arr.length === 0) return null
  return sum(arr) / arr.length
}
function sum(arr) {
  let s = 0
  for (const x of arr) s += x
  return s
}
function percentile(arr, p) {
  if (!arr || arr.length === 0) return null
  const sorted = [...arr].sort((a, b) => a - b)
  // Nearest-rank percentile converted to a zero-based array index.
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))
  return sorted[i]
}

// --------- Chart data sampling ---------

function sampleElapsedSeries(progressRows, firstTsMs, firstBlock, maxPoints = CHART_SAMPLE_POINTS) {
  // For line chart: x = blocks processed (current - firstBlock), y = elapsed hours
  if (!progressRows || progressRows.length === 0) return []
  const step = Math.max(1, Math.floor(progressRows.length / maxPoints))
  const out = []
  let lastCurrent = -1
  for (let i = 0; i < progressRows.length; i += step) {
    const r = progressRows[i]
    const blocks = r[1] - firstBlock
    if (blocks <= lastCurrent) continue // skip backwards (restarts) for the chart
    lastCurrent = blocks
    const elapsedHr = (r[0] - firstTsMs) / 3_600_000
    out.push({ x: blocks, y: elapsedHr })
  }
  // Always include the last point.
  const last = progressRows[progressRows.length - 1]
  const lastBlocks = last[1] - firstBlock
  if (out.length === 0 || out[out.length - 1].x < lastBlocks) {
    out.push({ x: lastBlocks, y: (last[0] - firstTsMs) / 3_600_000 })
  }
  return out
}

// --------- Main compute pipeline ---------

function compute(config, parsed, downtimeThresholdSec, breakpointsOverride) {
  const downtimeThresholdMs = downtimeThresholdSec * 1000
  const downtimeThresholdMsArg = downtimeThresholdMs

  // index parsed by label
  const byLabel = new Map()
  for (const p of parsed) byLabel.set(p.meta.label, p)

  // Gather the full set of service names across all deployments.
  const allServiceNames = new Set()
  for (const p of parsed) {
    for (const name of Object.keys(p.services)) allServiceNames.add(name)
  }
  // Sync services: at least one deployment emitted progress rows for this service.
  // Non-sync services (db, init, etc.) only show up in tier-3 / error / multicall data.
  const syncServiceNames = new Set(
    [...allServiceNames].filter((name) =>
      parsed.some((p) => {
        const s = p.services[name]
        return s && s.progressCount > 0
      }),
    ),
  )
  const intersectionServiceNames = [...allServiceNames].filter((name) =>
    parsed.every((p) => {
      const s = p.services[name]
      return s && s.progressCount > 0
    }),
  )
  // "Missing" only applies to sync services — a deployment that lacks a sync
  // service when another deployment has it can't be compared on that service.
  // Non-sync services (no progress rows anywhere) aren't missing, just not syncing.
  const missingByLabel = new Map() // label -> [serviceName, ...]
  for (const p of parsed) {
    const missing = []
    for (const name of allServiceNames) {
      if (!syncServiceNames.has(name)) continue
      const s = p.services[name]
      if (!s || s.progressCount === 0) missing.push(name)
    }
    if (missing.length > 0) missingByLabel.set(p.meta.label, missing)
  }

  const services = []

  for (const serviceName of [...allServiceNames].sort()) {
    const hasSyncData = syncServiceNames.has(serviceName)
    const perDeployment = {}
    // For non-sync services, "intersection" means the service is present in every
    // deployment (even without progress rows); that keeps the "solo" badge accurate.
    let inIntersection = hasSyncData
      ? intersectionServiceNames.includes(serviceName)
      : parsed.every((p) => p.services[serviceName])
    let minEffectiveRange = Infinity
    let minRawRange = Infinity
    const deploymentFirstBlocks = []
    const deploymentEffectiveRanges = []
    const deploymentRawRanges = []

    for (const p of parsed) {
      const s = p.services[serviceName]
      if (!s) {
        perDeployment[p.meta.label] = null
        continue
      }
      if (!hasSyncData) {
        // Non-sync service: no progress rows in any deployment. Build a reduced
        // snapshot from tier-3, multicall, errors, and overall time range.
        perDeployment[p.meta.label] = nonSyncSnapshot(s)
        continue
      }
      if (s.progressCount === 0) {
        // Another deployment proved this is a sync service, but this one never
        // reached its first progress row. Keep startup diagnostics visible while
        // excluding this deployment from breakpoint and rate comparisons.
        perDeployment[p.meta.label] = nonSyncSnapshot(s)
        continue
      }
      // After a restart, measure the final uninterrupted processor segment.
      // Reusing the pre-restart rows can produce an old first-crossing time or
      // a negative range when the capture ends below its original first block.
      const restarts = s.restarts || []
      const latestRestart = restarts.length > 0 ? restarts[restarts.length - 1] : null
      let restartRowIndex = latestRestart?.rowIndex
      if (latestRestart && !Number.isInteger(restartRowIndex)) {
        restartRowIndex = s.progressRows.findIndex(
          (row, index) =>
            index > 0 &&
            row[0] === latestRestart.tsMs &&
            row[1] === latestRestart.resumedAtBlock &&
            s.progressRows[index - 1][1] === latestRestart.fromBlock,
        )
      }
      const progressRows = latestRestart
        ? s.progressRows.slice(restartRowIndex >= 0 ? restartRowIndex : 0)
        : s.progressRows
      const firstBlock = progressRows[0][1]
      const lastBlock = progressRows[progressRows.length - 1][1]
      const firstProgressTsMs = progressRows[0][0]
      const lastProgressTsMs = progressRows[progressRows.length - 1][0]
      const multicall = latestRestart
        ? (s.multicall || []).filter(
            (sample) =>
              sample.tsMs > latestRestart.tsMs ||
              (sample.tsMs === latestRestart.tsMs &&
                latestRestart.sequence != null &&
                sample.sequence != null &&
                sample.sequence >= latestRestart.sequence),
          )
        : s.multicall

      // Catchup detection: first progress row within CATCHUP_GAP_BLOCKS of target.
      const catchup = findCatchupPoint(progressRows)
      let effectiveLastBlock = lastBlock
      let stillSyncing = false
      let wasAlreadyCaughtUp = false
      let catchupWallMs = null

      if (catchup != null) {
        if (catchup.rowIndex === 0) {
          // Already caught up at the very first progress line: the log captures
          // only the idle tail, no sync phase. Fall back to lastBlock (breakpoints
          // will measure steady-state latency, not sync) and flag prominently.
          wasAlreadyCaughtUp = true
        } else {
          effectiveLastBlock = catchup.block
          catchupWallMs = catchup.tsMs - firstProgressTsMs
        }
      } else {
        // Never reached catchup inside the log — either still syncing at fetch time,
        // or retention truncation cut off the tail. Either way, use actual lastBlock.
        stillSyncing = true
      }

      const effectiveRange = effectiveLastBlock - firstBlock
      const rawRange = lastBlock - firstBlock
      if (effectiveRange > 0) minEffectiveRange = Math.min(minEffectiveRange, effectiveRange)
      if (rawRange > 0) minRawRange = Math.min(minRawRange, rawRange)
      deploymentFirstBlocks.push(firstBlock)
      deploymentEffectiveRanges.push(effectiveRange)
      deploymentRawRanges.push(rawRange)

      perDeployment[p.meta.label] = {
        firstBlock,
        lastBlock,
        effectiveLastBlock,
        range: effectiveRange,
        rawRange,
        catchup, // { tsMs, block, target, rowIndex, sequence } or null
        catchupWallMs, // ms from first progress to catchup, or null
        stillSyncing,
        wasAlreadyCaughtUp,
        firstTsMs: firstProgressTsMs,
        lastTsMs: lastProgressTsMs,
        progressRows,
        multicall,
        restarts,
        errors: s.errors,
        errorCount: s.errorCount,
        levelCounts: s.levelCounts || null,
        tier3: s.tier3 || {},
      }
    }

    // Choose breakpoints: override wins (absolute block offsets), else percentage-based
    // over the shared effective range (post-catchup blocks excluded).
    // Non-sync services have no block range, so breakpoints stay empty.
    let breakpoints
    if (!hasSyncData) {
      breakpoints = []
    } else if (breakpointsOverride) {
      const onlyDeployment = Object.values(perDeployment).find((d) => d && !d.nonSync)
      const refRange = inIntersection && isFinite(minRawRange) ? minRawRange : (onlyDeployment?.rawRange ?? 0)
      breakpoints = breakpointsOverride.filter((b) => b <= refRange)
      if (breakpoints.length === 0 || (refRange > 0 && breakpoints[breakpoints.length - 1] !== refRange)) {
        breakpoints.push(refRange)
      }
    } else if (inIntersection && isFinite(minEffectiveRange)) {
      breakpoints = generateBreakpoints(minEffectiveRange)
    } else {
      // Solo service: use that deployment's own effective range.
      const onlyDeployment = Object.values(perDeployment).find((d) => d && !d.nonSync)
      breakpoints = onlyDeployment ? generateBreakpoints(onlyDeployment.range) : []
    }

    // Range-divergence detection covers both starting-block alignment and
    // shortened effective/raw ending coverage.
    let rangeDivergence = false
    if (deploymentFirstBlocks.length >= 2 && isFinite(minEffectiveRange)) {
      const minFirst = Math.min(...deploymentFirstBlocks)
      const maxFirst = Math.max(...deploymentFirstBlocks)
      if (minEffectiveRange > 0 && (maxFirst - minFirst) / minEffectiveRange > 0.05) rangeDivergence = true
    }
    const hasRangeSpread = (values) => {
      if (values.length < 2) return false
      const min = Math.min(...values)
      const max = Math.max(...values)
      if (min === max) return false
      return min <= 0 || (max - min) / min > 0.05
    }
    if (hasRangeSpread(deploymentEffectiveRanges) || hasRangeSpread(deploymentRawRanges)) {
      rangeDivergence = true
    }

    // Per-deployment breakpoint timings.
    const breakpointTimings = {}
    for (const [label, dep] of Object.entries(perDeployment)) {
      if (!dep || dep.nonSync) {
        breakpointTimings[label] = null
        continue
      }
      const rows = dep.progressRows
      const firstTs = dep.firstTsMs
      const firstBlock = dep.firstBlock

      const perBp = (breakpoints || []).map((bp) => {
        const target = firstBlock + bp
        const crossTs = findFirstCrossingTs(rows, target)
        if (crossTs == null) return { bp, wallMs: null, activeMs: null, downtimeMs: null }
        const wallMs = crossTs - firstTs
        const downtimeMs = computeDowntimeMs(rows, firstTs, crossTs, downtimeThresholdMsArg)
        const activeMs = wallMs - downtimeMs
        return { bp, wallMs, activeMs, downtimeMs }
      })
      breakpointTimings[label] = perBp
    }

    // Interval rate stats (per deployment, between adjacent breakpoints).
    const intervalStats = {}
    for (const [label, dep] of Object.entries(perDeployment)) {
      if (!dep || dep.nonSync || !breakpoints || breakpoints.length === 0) {
        intervalStats[label] = null
        continue
      }
      const arr = []
      const intervalProgressRows = !breakpointsOverride ? progressRowsThroughCatchup(dep) : dep.progressRows
      const intervalMulticall = !breakpointsOverride ? multicallsThroughCatchup(dep) : dep.multicall
      let prevBlock = 0
      for (const bp of breakpoints) {
        arr.push({
          from: prevBlock,
          to: bp,
          rates: computeIntervalStats(intervalProgressRows, dep.firstBlock + prevBlock, dep.firstBlock + bp),
          multicall: multicallStatsInRange(intervalMulticall, dep.firstBlock + prevBlock, dep.firstBlock + bp),
        })
        prevBlock = bp
      }
      intervalStats[label] = arr
    }

    // Tier-3 auto-discovery: loggers present across ALL deployments that have this service.
    const loggerSets = []
    for (const [label, dep] of Object.entries(perDeployment)) {
      if (!dep) continue
      loggerSets.push(new Set(Object.keys(dep.tier3)))
    }
    let commonLoggers = new Set()
    if (loggerSets.length > 0) {
      commonLoggers = new Set(loggerSets[0])
      for (let i = 1; i < loggerSets.length; i++) {
        commonLoggers = new Set([...commonLoggers].filter((x) => loggerSets[i].has(x)))
      }
    }
    const tier3 = {}
    for (const logger of commonLoggers) {
      tier3[logger] = {}
      for (const [label, dep] of Object.entries(perDeployment)) {
        if (!dep) continue
        const t3 = dep.tier3[logger]
        const rawSamples = t3.samples || []
        const measurementCandidates =
          !breakpointsOverride && Array.isArray(t3.syncSamples) ? t3.syncSamples : rawSamples
        const samples = dep.nonSync
          ? rawSamples
          : breakpointsOverride
            ? dep.restarts?.length > 0
              ? Array.isArray(t3.postRestartSamples)
                ? t3.postRestartSamples
                : tier3SamplesFromMeasurementStart(measurementCandidates, dep)
              : measurementCandidates
            : tier3SamplesInMeasurementWindow(measurementCandidates, dep)
        tier3[logger][label] = {
          count: dep.nonSync ? t3.count : samples.length,
          stats: tier3Aggregate(samples),
        }
      }
    }

    // Chart data.
    const chartSeries = {}
    for (const [label, dep] of Object.entries(perDeployment)) {
      if (!dep || dep.nonSync) continue
      const chartRows = breakpointsOverride ? dep.progressRows : progressRowsThroughCatchup(dep)
      chartSeries[label] = sampleElapsedSeries(chartRows, dep.firstTsMs, dep.firstBlock)
    }

    // Per-service catchup summary across deployments, for warnings & findings.
    const catchupSummary = {}
    for (const [label, dep] of Object.entries(perDeployment)) {
      if (!dep || dep.nonSync) {
        catchupSummary[label] = null
        continue
      }
      catchupSummary[label] = {
        caughtUp: dep.catchup != null && !dep.wasAlreadyCaughtUp,
        stillSyncing: dep.stillSyncing,
        wasAlreadyCaughtUp: dep.wasAlreadyCaughtUp,
        catchupBlock: dep.effectiveLastBlock,
        catchupWallMs: dep.catchupWallMs,
        rawRange: dep.rawRange,
        effectiveRange: dep.range,
      }
    }

    services.push({
      name: serviceName,
      hasSyncData,
      inIntersection,
      perDeployment,
      breakpoints: breakpoints || [],
      breakpointTimings,
      intervalStats,
      tier3,
      chartSeries,
      rangeDivergence,
      catchupSummary,
    })
  }

  // --- Summary findings ---
  const findings = []
  const warnings = []

  const isComparison = parsed.length >= 2

  if (isComparison && services.some((s) => s.inIntersection)) {
    // Overall verdict: compare sum of wall times across intersection services at each deployment's last breakpoint.
    const totalWallByLabel = new Map()
    for (const s of services) {
      if (!s.inIntersection) continue
      for (const [label, arr] of Object.entries(s.breakpointTimings)) {
        if (!arr) continue
        const last = arr[arr.length - 1]
        if (!last || last.wallMs == null) continue
        totalWallByLabel.set(label, (totalWallByLabel.get(label) || 0) + last.wallMs)
      }
    }
    if (totalWallByLabel.size >= 2) {
      const sorted = [...totalWallByLabel.entries()].sort((a, b) => a[1] - b[1])
      const [fastestLabel, fastestMs] = sorted[0]
      const [slowestLabel, slowestMs] = sorted[sorted.length - 1]
      if (fastestMs > 0) {
        const ratio = slowestMs / fastestMs
        findings.push({
          kind: 'verdict',
          text: `\`${fastestLabel}\` was ${ratio.toFixed(2)}× faster than \`${slowestLabel}\` in total wall time across comparable services.`,
        })
      }
    }

    // Biggest win and regression per service
    for (const s of services) {
      if (!s.inIntersection) continue
      const labels = Object.keys(s.breakpointTimings).filter((l) => s.breakpointTimings[l])
      if (labels.length < 2) continue
      const maxBp = s.breakpoints.length > 0 ? s.breakpoints[s.breakpoints.length - 1] : 0

      let bestWin = null // {bp, label, vs, ratio}
      for (let i = 0; i < s.breakpoints.length; i++) {
        const bp = s.breakpoints[i]
        const walls = labels.map((l) => [l, s.breakpointTimings[l][i]?.wallMs]).filter(([, w]) => w != null && w > 0)
        if (walls.length < 2) continue
        walls.sort((a, b) => a[1] - b[1])
        const [fast, fastMs] = walls[0]
        const [slow, slowMs] = walls[walls.length - 1]
        const ratio = slowMs / fastMs
        if (!bestWin || ratio > bestWin.ratio) bestWin = { bp, fast, slow, ratio, fastMs, slowMs }
      }

      if (bestWin && bestWin.ratio > 1.05) {
        findings.push({
          kind: 'service-delta',
          text: `**${s.name}** — biggest spread at ${formatPctLabel(bestWin.bp, maxBp)}: \`${bestWin.fast}\` ${formatDuration(bestWin.fastMs)} vs \`${bestWin.slow}\` ${formatDuration(bestWin.slowMs)} (${bestWin.ratio.toFixed(2)}×).`,
        })
      }

      // Where divergence widened most (per-interval)
      let maxGapGrowth = 0,
        growthBp = null,
        growthFrom = null
      for (let i = 0; i < s.breakpoints.length; i++) {
        const bp = s.breakpoints[i]
        const prevBp = i === 0 ? 0 : s.breakpoints[i - 1]
        const walls = labels.map((l) => [l, s.breakpointTimings[l][i]?.wallMs]).filter(([, w]) => w != null)
        const wallsPrev =
          i === 0
            ? labels.map((l) => [l, 0])
            : labels.map((l) => [l, s.breakpointTimings[l][i - 1]?.wallMs]).filter(([, w]) => w != null)
        if (walls.length < 2 || wallsPrev.length < 2) continue
        const deltaNow = Math.max(...walls.map((w) => w[1])) - Math.min(...walls.map((w) => w[1]))
        const deltaPrev = Math.max(...wallsPrev.map((w) => w[1])) - Math.min(...wallsPrev.map((w) => w[1]))
        const growth = deltaNow - deltaPrev
        if (growth > maxGapGrowth) {
          maxGapGrowth = growth
          growthBp = bp
          growthFrom = prevBp
        }
      }
      if (growthBp != null && maxGapGrowth > 60_000) {
        findings.push({
          kind: 'divergence',
          text: `**${s.name}** — divergence grew most in the ${formatIntervalLabel(growthFrom, growthBp, maxBp)} interval (+${formatDuration(maxGapGrowth)} of added gap).`,
        })
      }

      // Rate composition: which rate metric diverges most.
      // Compare avg rate vs avg mapping vs items across deployments, restricted
      // to the effective sync range so a long idle tail cannot skew the finding.
      const rateBlobs = labels.map((l) => {
        const deployment = s.perDeployment[l]
        const stats = computeIntervalStats(
          progressRowsThroughCatchup(deployment),
          deployment.firstBlock,
          deployment.effectiveLastBlock,
        )
        return { label: l, ...stats }
      })
      if (rateBlobs.length >= 2) {
        function deltaRatio(key) {
          const vals = rateBlobs.map((x) => x[key]).filter((v) => v != null)
          if (vals.length < 2) return null
          const lo = Math.min(...vals),
            hi = Math.max(...vals)
          return lo > 0 ? hi / lo : null
        }
        const rateR = deltaRatio('avgRate')
        const mapR = deltaRatio('avgMapping')
        const itemR = deltaRatio('avgItems')
        const entries = [
          ['processor rate', rateR],
          ['mapping rate', mapR],
          ['items/sec', itemR],
        ].filter((e) => e[1] != null)
        if (entries.length > 0) {
          entries.sort((a, b) => b[1] - a[1])
          const [top, ratio] = entries[0]
          if (ratio > 1.15) {
            findings.push({
              kind: 'rate-composition',
              text: `**${s.name}** — ${top} differs most across deployments (${ratio.toFixed(2)}× spread). Likely the dominant bottleneck.`,
            })
          }
        }
      }
    }
  }

  // Warnings
  for (const p of parsed) {
    if (p.meta.live) {
      warnings.push(
        `\`${p.meta.label}\` — last log timestamp is within 60s of fetch time (deployment was running live).`,
      )
    }
    for (const [name, s] of Object.entries(p.services)) {
      if (s.progressCount > 0 && (s.restarts || []).length > 0) {
        warnings.push(
          `\`${p.meta.label}\` — ${s.restarts.length} restart(s) detected in \`${name}\` (current block went backward). Sync timings use the final uninterrupted segment.`,
        )
      }
      if (s.errorCount > 0) {
        warnings.push(`\`${p.meta.label}\` — ${s.errorCount} WARN/ERROR line(s) in \`${name}\`.`)
      }
    }
  }
  for (const [label, missing] of missingByLabel) {
    warnings.push(
      `\`${label}\` missing services: ${missing.map((s) => '`' + s + '`').join(', ')} — excluded from direct comparison.`,
    )
  }
  for (const s of services) {
    if (s.rangeDivergence) {
      warnings.push(
        `**${s.name}** — deployments' starting or ending coverage differs by > 5%. Comparison may not be apples-to-apples.`,
      )
    }
    for (const [label, cu] of Object.entries(s.catchupSummary || {})) {
      if (!cu) continue
      if (cu.wasAlreadyCaughtUp) {
        warnings.push(
          `**${s.name}** / \`${label}\` — indexer was already at chain tip when logs begin (entire captured window is idle tail). No sync phase measured; shown breakpoints reflect steady-state latency. Fetch with an earlier \`--since\` to capture the sync.`,
        )
      } else if (cu.stillSyncing) {
        warnings.push(
          `**${s.name}** / \`${label}\` — never reached chain tip within the captured logs (still syncing, or retention truncated). "100%" in the table means the last observed block, not end-of-sync.`,
        )
      }
    }
  }

  return { services, findings, warnings, isComparison }
}

// --------- HTML rendering ---------
//
// The report HTML is rendered by injecting a ReportData JSON payload into
// templates/report.html at the <script id="__REPORT_DATA__" ...> slot defined
// by the template contract. See the TEMPLATE CONTRACT comment inside the
// template for the schema this function must produce.

function renderHtml({ config, parsed, compute, failures, runId, downtimeThresholdSec, breakpointsOverride }) {
  const reportData = buildReportData({
    config,
    parsed,
    compute,
    failures,
    runId,
    downtimeThresholdSec,
    breakpointsOverride,
  })
  const template = fs.readFileSync(TEMPLATE_PATH, 'utf8')
  return injectReportData(template, reportData)
}

// --------- ReportData builder ---------
//
// Transform compute()'s internal shape into the documented ReportData schema
// that the template's client-side renderer expects.

function buildReportData({ config, parsed, compute, failures, runId, downtimeThresholdSec, breakpointsOverride }) {
  const byLabel = new Map(parsed.map((p) => [p.meta.label, p]))
  const mode = parsed.length >= 2 ? 'compare' : 'single'

  const indexers = config.indexers
    .filter((i) => byLabel.has(i.label))
    .map((i) => {
      const p = byLabel.get(i.label)
      const slug = i.ref.replace(/[\/@:]/g, '-')
      const ent = { label: i.label, ref: i.ref, since: i.since, slug }
      if (p.meta.live) ent.live = true
      return ent
    })

  const services = []
  const soloServices = []
  const infraServices = []
  for (const s of compute.services) {
    if (!s.hasSyncData) {
      infraServices.push(mapInfraService(s))
      continue
    }
    const mapped = mapServiceForReport(s, breakpointsOverride)
    ;(s.inIntersection ? services : soloServices).push(mapped)
  }

  const failureWarnings = failures.map((failure) => ({
    kind: `${failure.stage}-failed`,
    label: failure.label,
    message: `\`${failure.label}\` ${failure.stage} failed: ${failure.message}`,
  }))
  const warnings = [...failureWarnings, ...compute.warnings.map((w) => structuredWarning(w))]
  const headline = deriveHeadline(compute, mode)

  return {
    run: {
      id: runId,
      createdAt: config.createdAt || new Date().toISOString(),
      downtimeThresholdSec,
      breakpointsOverride: breakpointsOverride ? breakpointsOverride.join(',') : null,
    },
    mode,
    indexers,
    headline,
    services,
    soloServices,
    infraServices,
    warnings,
    deploymentFailures: failures,
    fetchFailures: failures.filter((failure) => failure.stage === 'fetch').map((failure) => failure.label),
  }
}

// Build the reduced shape for infrastructure services (db, init, etc.).
// Non-sync services have no block progress; instead we surface tier-3
// time-series samples (e.g. Postgres query duration) with per-field charts
// and a stats table. Count-only namespaces (no numeric fields) still get
// a count row so they're visible in the report.
function mapInfraService(s) {
  const presentIn = Object.keys(s.perDeployment).filter((l) => s.perDeployment[l] != null)

  let firstTsMs = null
  let lastTsMs = null
  const perIndexer = {}
  for (const label of presentIn) {
    const d = s.perDeployment[label]
    perIndexer[label] = {
      firstTsMs: d.firstTsMs ?? null,
      lastTsMs: d.lastTsMs ?? null,
      spanMs: d.spanMs ?? null,
      lineCount: d.lineCount ?? 0,
      errorCount: d.errorCount ?? 0,
    }
    if (d.firstTsMs != null && (firstTsMs == null || d.firstTsMs < firstTsMs)) firstTsMs = d.firstTsMs
    if (d.lastTsMs != null && (lastTsMs == null || d.lastTsMs > lastTsMs)) lastTsMs = d.lastTsMs
  }

  // Gather all namespaces seen in any deployment.
  const allNamespaces = new Set()
  for (const label of presentIn) {
    for (const ns of Object.keys(s.perDeployment[label].tier3 || {})) allNamespaces.add(ns)
  }

  const entries = []
  const MAX_TS_POINTS = 150

  for (const namespace of [...allNamespaces].sort()) {
    // Union of numeric fields across deployments for this namespace.
    const fields = new Set()
    for (const label of presentIn) {
      const t3 = s.perDeployment[label].tier3?.[namespace]
      if (!t3) continue
      for (const sample of t3.samples || []) {
        for (const f of Object.keys(sample.fields || {})) fields.add(f)
      }
    }

    if (fields.size === 0) {
      // Count-only namespace: still emit a card so it's visible.
      const perIx = {}
      for (const label of presentIn) {
        const t3 = s.perDeployment[label].tier3?.[namespace]
        perIx[label] = t3 ? { count: t3.count || 0 } : null
      }
      entries.push({ namespace, field: null, perIndexer: perIx })
      continue
    }

    for (const field of [...fields].sort()) {
      const perIx = {}
      for (const label of presentIn) {
        const t3 = s.perDeployment[label].tier3?.[namespace]
        if (!t3) {
          perIx[label] = null
          continue
        }
        const samples = []
        for (const sample of t3.samples || []) {
          const v = sample.fields?.[field]
          if (v == null) continue
          samples.push([sample.tsMs, v])
        }
        if (samples.length === 0) {
          perIx[label] = null
          continue
        }

        // samples are already sorted ascending by tsMs (parser sorts).
        const dep = s.perDeployment[label]
        const baseMs = dep.firstTsMs ?? samples[0][0]
        const step = Math.max(1, Math.floor(samples.length / MAX_TS_POINTS))
        const timeseries = []
        for (let i = 0; i < samples.length; i += step) {
          timeseries.push({ t: (samples[i][0] - baseMs) / 1000, v: samples[i][1] })
        }
        const last = samples[samples.length - 1]
        const lastT = (last[0] - baseMs) / 1000
        if (timeseries.length === 0 || timeseries[timeseries.length - 1].t < lastT) {
          timeseries.push({ t: lastT, v: last[1] })
        }

        const vals = samples.map((ss) => ss[1])
        perIx[label] = {
          count: samples.length,
          mean: avg(vals),
          median: percentile(vals, 0.5),
          p95: percentile(vals, 0.95),
          min: Math.min(...vals),
          max: Math.max(...vals),
          timeseries,
        }
      }
      entries.push({ namespace, field, perIndexer: perIx })
    }
  }

  return {
    name: s.name,
    kind: 'infra',
    presentIn,
    firstTsMs,
    lastTsMs,
    spanMs: firstTsMs != null && lastTsMs != null ? lastTsMs - firstTsMs : null,
    perIndexer,
    tier3: entries,
  }
}

function mapServiceForReport(s, breakpointsOverride) {
  // "Present in" means the deployment emitted any data (sync or non-sync) for
  // this service. Non-sync deployments still carry tier2/tier3 rows worth
  // rendering — excluding them here would leave the client with an empty
  // indexers subset and crash per-indexer renderers.
  const presentIn = Object.keys(s.perDeployment).filter((l) => s.perDeployment[l] != null)

  let firstBlock = null
  let effectiveEndBlock = null
  for (const label of presentIn) {
    const d = s.perDeployment[label]
    if (firstBlock == null || d.firstBlock < firstBlock) firstBlock = d.firstBlock
    if (effectiveEndBlock == null || d.effectiveLastBlock > effectiveEndBlock) effectiveEndBlock = d.effectiveLastBlock
  }

  const maxBp = s.breakpoints.length > 0 ? s.breakpoints[s.breakpoints.length - 1] : 0
  const usingOverride = breakpointsOverride != null
  const deploymentFirstBlocks = presentIn
    .map((label) => s.perDeployment[label])
    .filter((d) => d && !d.nonSync)
    .map((d) => d.firstBlock)
  const hasDivergentStarts = new Set(deploymentFirstBlocks).size > 1

  const breakpoints = s.breakpoints.map((bp, i) => {
    const pct = usingOverride ? null : maxBp > 0 ? Math.round((bp / maxBp) * 100) : null
    const block = hasDivergentStarts ? null : (firstBlock ?? 0) + bp
    const perIndexer = {}
    for (const [label, d] of Object.entries(s.perDeployment)) {
      const t = s.breakpointTimings[label]
      if (!d || d.nonSync || !t) {
        perIndexer[label] = null
        continue
      }
      const bt = t[i]
      const targetBlock = d.firstBlock + bp
      if (!bt || bt.wallMs == null) {
        perIndexer[label] = { block: targetBlock, wallSec: 0, activeSec: 0, downtimeSec: 0, reached: false }
        continue
      }
      perIndexer[label] = {
        block: targetBlock,
        wallSec: bt.wallMs / 1000,
        activeSec: bt.activeMs / 1000,
        downtimeSec: bt.downtimeMs / 1000,
        reached: true,
      }
    }
    return { pct, offset: bp, block, perIndexer }
  })

  const progress = {}
  for (const [label, series] of Object.entries(s.chartSeries || {})) {
    const d = s.perDeployment[label]
    const base = d && !d.nonSync ? d.firstBlock : 0
    progress[label] = series.map((pt) => ({ t: pt.y * 3600, block: base + pt.x }))
  }

  const tier2 = {}
  for (const [label, d] of Object.entries(s.perDeployment)) {
    const warningCount =
      d?.levelCounts?.warning ?? (d?.errors || []).filter((e) => e.level === 'WARN' || e.level === 'WARNING').length
    const errorCount =
      d?.levelCounts?.error ??
      (d?.errors || []).filter((e) => e.level === 'ERROR' || e.level === 'CRITICAL' || e.level === 'FATAL').length
    if (!d) {
      tier2[label] = { restarts: 0, errors: errorCount, warns: warningCount }
      continue
    }
    const tier2Multicall = d.nonSync
      ? d.multicall || []
      : breakpointsOverride == null
        ? multicallsThroughCatchup(d)
        : d.multicall || []
    const latencies = tier2Multicall.map((m) => m.latencyMs).filter((x) => x != null)
    const entry = {
      restarts: d.nonSync ? 0 : (d.restarts || []).length,
      errors: errorCount,
      warns: warningCount,
    }
    if (latencies.length > 0) {
      entry.multicallP95Ms = percentile(latencies, 0.95)
      entry.multicallMeanMs = avg(latencies)
    }
    tier2[label] = entry
  }

  const tier3 = []
  for (const [namespace, perLabel] of Object.entries(s.tier3 || {})) {
    const fieldSet = new Set()
    for (const lab of Object.values(perLabel)) {
      for (const f of Object.keys(lab.stats || {})) fieldSet.add(f)
    }
    for (const field of fieldSet) {
      const perIndexer = {}
      for (const [label, d] of Object.entries(s.perDeployment)) {
        const lab = perLabel[label]
        const fs = lab?.stats?.[field]
        perIndexer[label] = fs
          ? {
              count: fs.count,
              mean: fs.mean,
              median: fs.median,
              p95: fs.p95,
            }
          : null
      }
      tier3.push({ namespace, field, perIndexer })
    }
  }

  const inlineWarnings = []
  if (s.rangeDivergence) {
    inlineWarnings.push({
      kind: 'range-divergence',
      service: s.name,
      message: `Deployments' starting or ending coverage differs by > 5% for ${s.name}.`,
    })
  }
  for (const [label, cu] of Object.entries(s.catchupSummary || {})) {
    if (!cu) continue
    if (cu.wasAlreadyCaughtUp) {
      inlineWarnings.push({
        kind: 'already-caught-up',
        service: s.name,
        label,
        message: `Indexer was already at chain tip when logs begin. Breakpoints reflect steady-state latency, not sync.`,
      })
    } else if (cu.stillSyncing) {
      inlineWarnings.push({
        kind: 'never-caught-up',
        service: s.name,
        label,
        message: `Never reached chain tip within captured logs. "100%" reflects last observed block, not end-of-sync.`,
      })
    }
  }

  const out = {
    name: s.name,
    presentIn,
    firstBlock: firstBlock ?? 0,
    effectiveEndBlock: effectiveEndBlock ?? 0,
    breakpoints,
    progress,
    tier2,
    tier3,
    inlineWarnings,
  }

  const verdict = deriveServiceVerdict(breakpoints, presentIn)
  if (verdict) out.verdict = verdict

  return out
}

function deriveServiceVerdict(breakpoints, presentIn) {
  if (breakpoints.length === 0 || presentIn.length < 2) return null
  const last = breakpoints[breakpoints.length - 1]
  const entries = presentIn.map((l) => [l, last.perIndexer[l]]).filter(([, v]) => v && v.reached && v.wallSec > 0)
  if (entries.length < 2) return null
  entries.sort((a, b) => a[1].wallSec - b[1].wallSec)
  const [faster, fSec] = [entries[0][0], entries[0][1].wallSec]
  const [slower, sSec] = [entries[entries.length - 1][0], entries[entries.length - 1][1].wallSec]
  return { faster, slower, deltaPct: Math.round(((sSec - fSec) / fSec) * 100) }
}

function deriveHeadline(compute, mode) {
  if (mode === 'single') {
    return { kind: 'solo', note: 'Single-indexer run — no comparison.' }
  }
  const totals = new Map()
  for (const s of compute.services) {
    if (!s.inIntersection) continue
    for (const [label, arr] of Object.entries(s.breakpointTimings)) {
      if (!arr || arr.length === 0) continue
      const last = arr[arr.length - 1]
      if (!last || last.wallMs == null) continue
      totals.set(label, (totals.get(label) || 0) + last.wallMs)
    }
  }
  if (totals.size < 2) {
    return { kind: 'inconclusive', note: 'Not enough comparable services to compute a headline.' }
  }
  const sorted = [...totals.entries()].sort((a, b) => a[1] - b[1])
  const [fasterLabel, fasterMs] = sorted[0]
  const [slowerLabel, slowerMs] = sorted[sorted.length - 1]
  if (fasterMs <= 0) return { kind: 'inconclusive', note: 'Faster deployment had zero wall time.' }
  return {
    kind: 'delta',
    fasterLabel,
    slowerLabel,
    deltaPct: Math.round(((slowerMs - fasterMs) / fasterMs) * 100),
    wallSecFaster: fasterMs / 1000,
    wallSecSlower: slowerMs / 1000,
  }
}

function structuredWarning(raw) {
  const message = String(raw)
  let kind = 'solo-service'
  if (/within 60s of fetch time/i.test(message)) kind = 'live'
  else if (/never reached chain tip/i.test(message)) kind = 'never-caught-up'
  else if (/already at chain tip/i.test(message)) kind = 'already-caught-up'
  else if (/first-block values diverge|starting or ending coverage differs/i.test(message)) kind = 'range-divergence'
  else if (/missing services/i.test(message)) kind = 'solo-service'
  return { kind, message }
}

// --------- Template injector ---------
//
// The template is a plain HTML document with inline CSS and JavaScript. The
// data slot is its <script id="__REPORT_DATA__" type="application/json"> tag.
// We swap that tag's body for the payload and leave every other byte untouched.

function injectReportData(templateHtml, reportData) {
  // The template mentions <script id="__REPORT_DATA__"> inside its own contract
  // comment; skip that occurrence by searching past the first HTML comment.
  const commentEnd = templateHtml.indexOf('-->')
  const searchFrom = commentEnd >= 0 ? commentEnd + 3 : 0
  const openTag = '<script id="__REPORT_DATA__" type="application/json">'
  const openAt = templateHtml.indexOf(openTag, searchFrom)
  if (openAt === -1) throw new Error('injectReportData: __REPORT_DATA__ script tag not found in template')
  const closeAt = templateHtml.indexOf('</script>', openAt + openTag.length)
  if (closeAt === -1) throw new Error('injectReportData: __REPORT_DATA__ closing tag not found')

  // Escape every < in the payload (log excerpts are raw text) so no </script>
  // or <!-- sequence can end or change the enclosing script tag. The result is
  // still valid JSON.
  const payload = JSON.stringify(reportData).replace(/</g, '\\u003c')
  return templateHtml.slice(0, openAt) + openTag + '\n' + payload + '\n' + templateHtml.slice(closeAt)
}

function findRefForLabel(config, label) {
  const idx = config.indexers.find((i) => i.label === label)
  return idx ? idx.ref : label
}

// --------- MD rendering ---------

function renderMd({ config, parsed, compute, failures, runId, htmlRelPath }) {
  const labels = parsed.map((p) => p.meta.label)
  const isComparison = parsed.length >= 2

  const lines = []
  lines.push(`# Squid Sync Performance ${isComparison ? 'Comparison' : 'Metrics'} — ${runId}\n`)
  lines.push(`Generated ${new Date().toISOString()} · [open HTML report](${htmlRelPath})\n`)
  lines.push(`### Deployments`)
  for (const p of parsed) {
    const ref = findRefForLabel(config, p.meta.label)
    const live = p.meta.live ? ' **⚠ live**' : ''
    lines.push(
      `- **${escapeMd(p.meta.label)}** — \`${escapeMd(ref)}\` · logs ${p.meta.earliestTs} → ${p.meta.latestTs}${live}`,
    )
  }
  lines.push('')

  if (failures.length > 0) {
    lines.push(`### ⚠ Failed deployments`)
    for (const failure of failures) {
      lines.push(
        `- **${escapeMd(failure.label)}** — \`${escapeMd(failure.ref)}\` · ${failure.stage} failed: ${escapeMd(failure.message)}`,
      )
    }
    lines.push('')
  }

  lines.push(`## Summary\n`)
  if (compute.findings.length > 0) {
    for (const f of compute.findings) lines.push(`- ${f.text}`)
  } else {
    lines.push(`_No significant findings._`)
  }
  lines.push('')

  if (compute.warnings.length > 0) {
    lines.push(`### ⚠ Warnings`)
    for (const w of compute.warnings) lines.push(`- ${w}`)
    lines.push('')
  }

  for (const svc of compute.services) {
    if (svc.hasSyncData === false) {
      const soloMarker = svc.inIntersection ? '' : ' (solo)'
      lines.push(`## ${svc.name} (non-sync)${soloMarker}\n`)
      lines.push(
        `_Infrastructure service with no \`sqd:processor\` progress lines. Metrics below are aggregated from tier-3 log entries over the captured window._\n`,
      )
      lines.push(`| Deployment | Log time range | Span | Log lines |`)
      lines.push(`| ---------- | -------------- | ---- | --------- |`)
      for (const l of labels) {
        const dep = svc.perDeployment[l]
        if (!dep) {
          lines.push(`| ${escapeMd(l)} | — | — | — |`)
          continue
        }
        const first = dep.firstTsMs != null ? new Date(dep.firstTsMs).toISOString() : '—'
        const last = dep.lastTsMs != null ? new Date(dep.lastTsMs).toISOString() : '—'
        const span = dep.spanMs != null ? formatDuration(dep.spanMs) : '—'
        const errs = dep.errorCount ? ` (${dep.errorCount} WARN/ERROR)` : ''
        lines.push(
          `| ${escapeMd(l)} | ${escapeMd(first + ' → ' + last)} | ${escapeMd(span)} | ${dep.lineCount}${errs} |`,
        )
      }
      lines.push('')

      if (Object.keys(svc.tier3).length > 0) {
        lines.push(`### Auto-discovered metrics (Tier 3)`)
        for (const [logger, byLabel] of Object.entries(svc.tier3)) {
          const fields = new Set()
          for (const stats of Object.values(byLabel)) for (const k of Object.keys(stats.stats)) fields.add(k)
          const fieldList = [...fields].sort()
          lines.push(`\n#### \`${logger}\``)
          lines.push(`| Deployment | ${fieldList.map(escapeMd).join(' | ') || '(no numeric fields)'} | #lines |`)
          lines.push(`| ---------- | ${fieldList.map(() => '---').join(' | ') || '---'} | --- |`)
          for (const l of labels) {
            const lab = byLabel[l]
            if (!lab) {
              lines.push(`| ${escapeMd(l)} | ${fieldList.map(() => '—').join(' | ') || '—'} | — |`)
              continue
            }
            const cells = fieldList.map((f) => {
              const s = lab.stats[f]
              if (!s) return '—'
              return `mean ${s.mean.toFixed(1)} · p95 ${s.p95.toFixed(0)}`
            })
            const cellStr = cells.length > 0 ? cells.map(escapeMd).join(' | ') : '—'
            lines.push(`| ${escapeMd(l)} | ${cellStr} | ${lab.count} |`)
          }
        }
        lines.push('')
      }
      continue
    }

    const marker = svc.inIntersection ? '' : ' (solo)'
    lines.push(`## ${svc.name}${marker}\n`)
    if (svc.rangeDivergence)
      lines.push(`> ⚠ Range divergence detected — deployments' starting or ending coverage differs noticeably.\n`)

    const timings = svc.breakpointTimings
    const referenceLabel = labels.find((l) => timings[l]) || labels[0]
    const refArr = timings[referenceLabel] || []
    const maxBp = svc.breakpoints.length > 0 ? svc.breakpoints[svc.breakpoints.length - 1] : 0

    // Wall table
    lines.push(`### Wall-clock time to reach N% of sync (to chain tip)`)
    lines.push(
      `_100% = first time \`current\` came within ${CATCHUP_GAP_BLOCKS} blocks of \`target\` (indexer reached chain tip). Anything past this is steady-state, not sync._\n`,
    )
    lines.push(`| Progress | ${labels.map(escapeMd).join(' | ')} |`)
    lines.push(`| -------- | ${labels.map(() => '---').join(' | ')} |`)
    for (let i = 0; i < svc.breakpoints.length; i++) {
      const bp = svc.breakpoints[i]
      const row = [formatPctLabel(bp, maxBp)]
      for (const l of labels) {
        const t = timings[l]?.[i]
        if (!t || t.wallMs == null) {
          row.push('—')
          continue
        }
        let cell = formatDuration(t.wallMs)
        if (l !== referenceLabel && refArr[i]?.wallMs != null) {
          const p = pct(t.wallMs, refArr[i].wallMs)
          if (p != null) cell += ` _(${formatPct(p)})_`
        }
        cell += ` · active ${formatDuration(t.activeMs)} · down ${formatDuration(t.downtimeMs)}`
        row.push(cell)
      }
      lines.push(`| ${row.map(escapeMd).join(' | ')} |`)
    }
    lines.push('')

    // Rates
    const anyRates = labels.some((l) => svc.intervalStats[l])
    if (anyRates) {
      lines.push(`### Rates by interval`)
      lines.push(`| Interval | ${labels.map(escapeMd).join(' | ')} |`)
      lines.push(`| -------- | ${labels.map(() => '---').join(' | ')} |`)
      for (let i = 0; i < svc.breakpoints.length; i++) {
        const from = i === 0 ? 0 : svc.breakpoints[i - 1]
        const to = svc.breakpoints[i]
        const row = [formatIntervalLabel(from, to, maxBp)]
        for (const l of labels) {
          const r = svc.intervalStats[l]?.[i]?.rates
          if (!r) {
            row.push('—')
            continue
          }
          const rate = r.avgRate != null ? r.avgRate.toFixed(1) : '—'
          const mr = r.avgMapping != null ? r.avgMapping.toFixed(1) : '—'
          const its = r.avgItems != null ? r.avgItems.toFixed(1) : '—'
          row.push(`${rate} blk/s · map ${mr} · items ${its}`)
        }
        lines.push(`| ${row.map(escapeMd).join(' | ')} |`)
      }
      lines.push('')
    }

    // Multicall
    const hasMulticall = labels.some((l) => svc.intervalStats[l]?.some((x) => x.multicall))
    if (hasMulticall) {
      lines.push(`### Multicall stats by interval`)
      lines.push(`| Interval | ${labels.map(escapeMd).join(' | ')} |`)
      lines.push(`| -------- | ${labels.map(() => '---').join(' | ')} |`)
      for (let i = 0; i < svc.breakpoints.length; i++) {
        const from = i === 0 ? 0 : svc.breakpoints[i - 1]
        const to = svc.breakpoints[i]
        const row = [formatIntervalLabel(from, to, maxBp)]
        for (const l of labels) {
          const mc = svc.intervalStats[l]?.[i]?.multicall
          if (!mc) {
            row.push('—')
            continue
          }
          row.push(
            `${mc.invocations} calls · avg ${mc.avgLatencyMs.toFixed(0)}ms · p95 ${mc.p95LatencyMs}ms · ${formatShortNumber(mc.totalCalls)} eth_calls`,
          )
        }
        lines.push(`| ${row.map(escapeMd).join(' | ')} |`)
      }
      lines.push('')
    }

    // Deployments that never emitted processor progress cannot be assigned to
    // block intervals, but their retained multicall samples are still useful
    // startup diagnostics and must remain visible in the Markdown report.
    const diagnosticMulticall = {}
    for (const label of labels) {
      const dep = svc.perDeployment[label]
      if (!dep?.nonSync) continue
      const samples = (dep.multicall || []).filter((sample) => sample.latencyMs != null)
      if (samples.length === 0) continue
      const latencies = samples.map((sample) => sample.latencyMs)
      diagnosticMulticall[label] = {
        invocations: samples.length,
        avgLatencyMs: avg(latencies),
        p95LatencyMs: percentile(latencies, 0.95),
        totalCalls: sum(samples.map((sample) => sample.calls || 0)),
      }
    }
    if (Object.keys(diagnosticMulticall).length > 0) {
      lines.push(`### Diagnostic-only multicall stats`)
      lines.push(
        `_These deployments emitted multicall records but no processor progress, so the samples are not assigned to block intervals._\n`,
      )
      lines.push(`| Deployment | Samples | Average | p95 | Total calls |`)
      lines.push(`| ---------- | ------- | ------- | --- | ----------- |`)
      for (const [label, stats] of Object.entries(diagnosticMulticall)) {
        lines.push(
          `| ${escapeMd(label)} | ${stats.invocations} | ${stats.avgLatencyMs.toFixed(0)}ms | ${stats.p95LatencyMs.toFixed(0)}ms | ${formatShortNumber(stats.totalCalls)} |`,
        )
      }
      lines.push('')
    }

    // Tier-3
    if (Object.keys(svc.tier3).length > 0) {
      lines.push(`### Auto-discovered metrics (Tier 3)`)
      for (const [logger, byLabel] of Object.entries(svc.tier3)) {
        const fields = new Set()
        for (const stats of Object.values(byLabel)) for (const k of Object.keys(stats.stats)) fields.add(k)
        const fieldList = [...fields].sort()
        lines.push(`\n#### \`${logger}\``)
        lines.push(`| Deployment | ${fieldList.map(escapeMd).join(' | ')} | #lines |`)
        lines.push(`| ---------- | ${fieldList.map(() => '---').join(' | ')} | --- |`)
        for (const l of labels) {
          const lab = byLabel[l]
          if (!lab) {
            lines.push(`| ${escapeMd(l)} | ${fieldList.map(() => '—').join(' | ')} | — |`)
            continue
          }
          const cells = fieldList.map((f) => {
            const s = lab.stats[f]
            if (!s) return '—'
            return `mean ${s.mean.toFixed(1)} · p95 ${s.p95.toFixed(0)}`
          })
          lines.push(`| ${escapeMd(l)} | ${cells.map(escapeMd).join(' | ')} | ${lab.count} |`)
        }
      }
      lines.push('')
    }
  }

  return lines.join('\n') + '\n'
}

// --------- Entry ---------

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const runDir = args['run-dir']
  if (!runDir) {
    process.stderr.write('usage: report.mjs --run-dir <path> [--breakpoints 500K,1M,...] [--downtime-threshold 120]\n')
    process.exit(2)
  }

  const configPath = path.join(runDir, 'compare-syncs.json')
  if (!fs.existsSync(configPath)) {
    throw new Error(`compare-syncs.json not found at ${configPath}`)
  }
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
  const failures = readDeploymentFailures(runDir, config)

  const parsedDir = path.join(runDir, 'parsed')
  if (!fs.existsSync(parsedDir)) {
    throw new Error(`parsed/ directory not found at ${parsedDir}`)
  }
  const parsedFiles = fs.readdirSync(parsedDir).filter((f) => f.endsWith('.json'))
  if (parsedFiles.length === 0) throw new Error(`no parsed/*.json in ${parsedDir}`)
  const parsed = parsedFiles.map((f) => JSON.parse(fs.readFileSync(path.join(parsedDir, f), 'utf8')))

  const hasProgress = parsed.some((p) => Object.values(p.services || {}).some((service) => service.progressCount > 0))
  if (!hasProgress) throw new Error(`no parsed deployment contains processor progress data in ${parsedDir}`)

  // Sort parsed to match the order of indexers in config.
  const orderByLabel = new Map(config.indexers.map((i, idx) => [i.label, idx]))
  parsed.sort((a, b) => (orderByLabel.get(a.meta.label) ?? 99) - (orderByLabel.get(b.meta.label) ?? 99))

  const downtimeThresholdSec =
    args['downtime-threshold'] != null
      ? parseInt(args['downtime-threshold'], 10)
      : (config.downtimeThresholdSec ?? DEFAULT_DOWNTIME_THRESHOLD_SEC)

  let breakpointsOverride = null
  if (args['breakpoints']) {
    breakpointsOverride = String(args['breakpoints'])
      .split(',')
      .map((s) => parseShortNumber(s.trim()))
      .filter((n) => !Number.isNaN(n) && n > 0)
      .sort((a, b) => a - b)
  } else if (Array.isArray(config.breakpointsOverride)) {
    breakpointsOverride = config.breakpointsOverride.slice().sort((a, b) => a - b)
  }

  const computed = compute(config, parsed, downtimeThresholdSec, breakpointsOverride)

  const runId = path.basename(runDir.replace(/\/$/, ''))
  const html = renderHtml({
    config,
    parsed,
    compute: computed,
    failures,
    runId,
    downtimeThresholdSec,
    breakpointsOverride,
  })
  const htmlPath = path.join(runDir, 'report.html')
  fs.writeFileSync(htmlPath, html)

  const mdPath = path.join(runDir, 'report.md')
  const md = renderMd({
    config,
    parsed,
    compute: computed,
    failures,
    runId,
    htmlRelPath: './report.html',
  })
  fs.writeFileSync(mdPath, md)

  process.stderr.write(`report ok — wrote ${htmlPath} (${formatShortNumber(html.length)} bytes) and ${mdPath}\n`)
}

main().catch((err) => {
  process.stderr.write(`report: ${err && err.stack ? err.stack : err}\n`)
  process.exit(1)
})
