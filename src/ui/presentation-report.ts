import type { ReplayAction, ReplayComparison, ReplayOutcome } from '../sim/replay'

const ACTION_LINES_PER_BRANCH = 6
const metrics: readonly [keyof Omit<ReplayOutcome, 'scenario'>, string][] = [
  ['commits', 'Commits (transactions)'], ['rollbacks', 'Rollbacks (transactions)'],
  ['throughputTps', 'Throughput (model transactions/s)'], ['latencyP99ModelMs', 'p99 latency (model ms)'],
  ['deadTuples', 'Dead tuples (tuples)'], ['tablePages', 'Table pages (pages)'],
  ['reclaimedTuples', 'Tuples reclaimed (tuples)'], ['retainedWalBytes', 'WAL retained by physical slots (bytes)'],
  ['rejectedWrites', 'Rejected writes (writes)'], ['lostTransactions', 'Lost transactions (transactions)'],
]
const number = (value: number): string => value.toLocaleString('en-US', { maximumFractionDigits: 2 })

function actionText(action: ReplayAction): string {
  switch (action.type) {
    case 'knob': return `knob ${action.key} = ${JSON.stringify(action.value)} (raw model value)`
    case 'scenario': return `scenario ${action.id ?? 'none'}`
    case 'decision': return `decision ${action.choice}`
    case 'recover': return 'recover'
    case 'end-trace': return 'end trace'
  }
}

function actionLines(label: string, actions: readonly ReplayAction[]): string[] {
  const heading = `${label} recorded actions after checkpoint (${number(actions.length)} total)`
  if (!actions.length) return [`${heading}: none.`]
  return [
    `${heading}:`,
    ...actions.slice(0, ACTION_LINES_PER_BRANCH).map((action) => `step ${action.tick}: ${actionText(action)}`),
    ...(actions.length > ACTION_LINES_PER_BRANCH
      ? [`${number(actions.length - ACTION_LINES_PER_BRANCH)} additional recorded actions omitted from this image.`] : []),
  ]
}

/** Pure text report: every value comes from a captured comparison, never from a second experiment. */
export function presentationComparisonLines(comparison: ReplayComparison): string[] {
  const { baseline, current, checkpoint } = comparison
  return [
    comparison.sameDuration ? 'Same model duration — recorded branch comparison'
      : 'Different model durations — not a controlled comparison',
    `Seed ${comparison.seed}; checkpoint step ${checkpoint.tick}, after recorded action ${checkpoint.actionCount}.`,
    `Original ${baseline.elapsedModelSeconds.toFixed(2)}; alternative ${current.elapsedModelSeconds.toFixed(2)} model seconds since replay origin, not since checkpoint.`,
    `Original scenario: ${baseline.scenario ?? 'none'}; alternative scenario: ${current.scenario ?? 'none'}.`,
    'The city scene shows the alternative at export, not a rendering of the saved original branch.',
    'Representative model outcomes, not PostgreSQL measurements. PGlite results are separate.',
    'Counters and current gauges below are not changes since checkpoint or production capacity estimates.',
    ...metrics.map(([key, label]) => `${label}: original ${number(baseline[key])}; alternative ${number(current[key])}.`),
    'Reusable table space does not imply that ordinary VACUUM shrinks a relation file.',
    'Recorded actions include model controls and interventions, not SQL. Values below use raw model fields.',
    ...actionLines('Original', comparison.baselineActions),
    ...actionLines('Alternative', comparison.currentActions),
  ]
}
