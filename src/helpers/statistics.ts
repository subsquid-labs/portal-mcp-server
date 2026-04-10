export function calculatePercentile(values: number[], percentile: number): number | undefined {
  if (values.length === 0) return undefined
  const sorted = values.slice().sort((a, b) => a - b)
  const clamped = Math.max(0, Math.min(100, percentile))
  const index = (clamped / 100) * (sorted.length - 1)
  const lowerIndex = Math.floor(index)
  const upperIndex = Math.ceil(index)
  const lower = sorted[lowerIndex]
  const upper = sorted[upperIndex]

  if (lowerIndex === upperIndex) {
    return lower
  }

  const weight = index - lowerIndex
  return lower + (upper - lower) * weight
}

export function buildPercentileSummary(values: number[], percentiles: number[] = [50, 95]): Record<string, number> | undefined {
  if (values.length === 0) return undefined

  const summary: Record<string, number> = {}
  for (const percentile of percentiles) {
    const value = calculatePercentile(values, percentile)
    if (value !== undefined && Number.isFinite(value)) {
      summary[`p${percentile}`] = value
    }
  }
  return summary
}
