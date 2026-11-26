import { ActionableError } from '../../helpers/errors.js'
import { estimateBlockTime, parseTimeframeToSeconds } from '../../helpers/timeframe.js'

/*
 * How many blocks one series call may read before it refuses.
 *
 * The cost of this tool is linear in blocks, not in buckets: every block in the
 * window is streamed and folded into its bucket, so a coarser interval reads
 * exactly as much as a fine one. A previous Base benchmark took up to 26.6s
 * for 10,800 blocks and 112s for 43,200. Keep the ceiling just above the scan
 * that finished comfortably within the client's timeout.
 */
export const MAX_SERIES_SCAN_BLOCKS = 12_000

export function assertSeriesWindowScannable(params: {
  dataset: string
  chainType: string
  fromBlock: number
  toBlock: number
  duration: string
}) {
  const blocks = Math.max(0, params.toBlock - params.fromBlock + 1)
  if (blocks <= MAX_SERIES_SCAN_BLOCKS) return
  throw seriesWindowTooLargeError({ ...params, blocks, estimated: false })
}

/*
 * The exact check needs the window's block numbers, and those cost timestamp
 * lookups against the Portal: on Ethereum that was ten seconds spent deciding
 * to refuse. A duration that is far over the bound by the chain's own block
 * time is refused before any lookup. A borderline one waits for the exact
 * count, because a block-time estimate is not a block count.
 */
export function assertSeriesDurationScannable(params: { dataset: string; chainType: string; duration: string }) {
  let seconds: number
  try {
    seconds = parseTimeframeToSeconds(params.duration)
  } catch {
    return
  }
  const secondsPerBlock = estimateBlockTime(params.dataset, params.chainType)
  if (!(secondsPerBlock > 0)) return
  const blocks = Math.ceil(seconds / secondsPerBlock)
  if (blocks <= MAX_SERIES_SCAN_BLOCKS * 1.5) return
  throw seriesWindowTooLargeError({ ...params, blocks, estimated: true })
}

export function getSafeSeriesDurationPresets(dataset: string, chainType: string): string[] {
  const secondsPerBlock = estimateBlockTime(dataset, chainType)
  if (!(secondsPerBlock > 0)) return []
  const affordableSeconds = MAX_SERIES_SCAN_BLOCKS * secondsPerBlock
  const presets: [string, number][] = [
    ['7d', 604_800],
    ['3d', 259_200],
    ['24h', 86_400],
    ['12h', 43_200],
    ['6h', 21_600],
    ['1h', 3_600],
    ['30m', 1_800],
    ['15m', 900],
    ['5m', 300],
  ]
  return presets
    .filter(([, seconds]) => seconds <= affordableSeconds)
    .slice(0, 3)
    .map(([label]) => label)
}

function seriesWindowTooLargeError(params: {
  dataset: string
  chainType: string
  duration: string
  blocks: number
  estimated: boolean
}): ActionableError {
  const { blocks } = params
  const secondsPerBlock = estimateBlockTime(params.dataset, params.chainType)
  const affordableSeconds = MAX_SERIES_SCAN_BLOCKS * secondsPerBlock
  const affordableWindow =
    affordableSeconds >= 3600
      ? `${Math.floor(affordableSeconds / 3600)} hours`
      : `${Math.floor(affordableSeconds / 60)} minutes`
  /* Suggest a real preset rather than a computed number nobody can type. */
  const presets: [string, number][] = [
    ['30d', 2_592_000],
    ['14d', 1_209_600],
    ['7d', 604_800],
    ['3d', 259_200],
    ['24h', 86_400],
    ['12h', 43_200],
    ['6h', 21_600],
    ['1h', 3_600],
    ['30m', 1_800],
    ['15m', 900],
  ]
  const largest = presets.find(([, seconds]) => seconds <= affordableSeconds)

  return new ActionableError(
    `A ${params.duration} window is ${params.estimated ? 'about ' : ''}${blocks.toLocaleString()} blocks on ${params.dataset}${params.estimated ? ' by its typical block time' : ''}, and portal_get_time_series reads every block in the window. It stops at ${MAX_SERIES_SCAN_BLOCKS.toLocaleString()} blocks so a call cannot outlast the client waiting for it.`,
    [
      largest
        ? `Try duration '${largest[0]}' or less on ${params.dataset}. At its typical block rate, the limit covers roughly ${affordableWindow}.`
        : `Ask for a window under ${MAX_SERIES_SCAN_BLOCKS.toLocaleString()} blocks on ${params.dataset}.`,
      'Use from_timestamp and to_timestamp to specify a narrower interval.',
      'The same duration costs less on a slower chain: the limit is blocks, not time.',
      'Use the analytics tool for this chain if you want one aggregate over a wider window instead of a series.',
    ],
    {
      requested_duration: params.duration,
      requested_blocks: blocks,
      ...(params.estimated ? { requested_blocks_estimated: true } : {}),
      max_scan_blocks: MAX_SERIES_SCAN_BLOCKS,
      seconds_per_block: secondsPerBlock,
      ...(largest ? { largest_supported_duration: largest[0] } : {}),
    },
    /* The caller asked for more than the tool serves and can ask for less.
       That is their input, not a server fault, and retrying it unchanged will
       fail exactly the same way. */
    { code: 'unsupported_operation', origin: 'client_input', retryable: false },
  )
}
