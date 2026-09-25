// What one turn actually cost, from the CLI's `total_cost_usd`.
//
// That field is a RUNNING total, not a per-turn figure (Anthropic's cost-tracking docs,
// "Track costs in streaming input mode"). It runs across every result one process emits
// (background agents reporting in, queued messages), and from CLI 2.1.278 it also carries
// the session's earlier spend across `--resume`. Storing it as the turn's cost and then
// summing turns makes a session read several times its real cost, and the Usage page
// roughly 3x high.
//
// So the turn cost is the increase since the previous turn of the same session, EXCEPT
// when the total restarted. Subtracting across a restart is the opposite failure: it
// stores near zero for real work. Two tests catch a restart:
//   - the total went down (or there is no previous turn): the total IS this turn;
//   - the increase is smaller than this turn's own token cost. A turn never costs less
//     than its own tokens (measured on rows that are certainly per-turn:
//     CLI / computed p10 1.02, median 1.2). Example: a 2.1.278 resume after a pre-2.1.278
//     compact starts from zero, and a blind subtraction stores a fraction of the turn's
//     real cost.
// That second test is only as good as the price it compares with, so `computed` must come
// from the CURRENT price table. A server running an old shared/dist that priced Opus 5.5
// at Opus 5 rates would make every Opus 5.5 increase look like a restart.
// Subagent spend is inside the CLI total and not inside the turn's own tokens, so a delta
// ABOVE computed is expected and must never be pulled down to it.

/** The instant from which the CLI's total is treated as a running total across --resume
 *  (CLI 2.1.278 and later). Turns recorded before it are priced the old, per-process way. */
export const RUNNING_TOTAL_SINCE_MS = Date.parse('2026-09-21T21:50:29Z')

/** A delta below this fraction of the turn's own token cost means the total restarted. */
export const RESTART_FLOOR = 0.9

export interface PerTurnInput {
  /** The CLI's total_cost_usd on this result; 0 when absent. */
  cliTotal: number
  /** The session's previous positive RAW CLI total, or null. */
  prevCliTotal: number | null
  /** This turn's cost priced locally from its own tokens, or null when the model is unknown.
   *  For a `<synthetic>` turn (one that ended on an API error) pass its tokens priced at the
   *  session's last real model: it is only used to tell a restart from an increase. */
  computed: number | null
  /** When the row was written. Only history before RUNNING_TOTAL_SINCE_MS needs it. */
  createdAt: number
  /** The result reported no tokens at all (an error turn that did no work of its own). */
  noTokens?: boolean
}

/** Distance in log terms, so 2x high and 2x low count the same. */
function logDistance(value: number, target: number): number {
  return value > 0 ? Math.abs(Math.log(value / target)) : Infinity
}

export function perTurnCost({ cliTotal, prevCliTotal, computed, createdAt, noTokens }: PerTurnInput): number {
  if (!(cliTotal > 0)) return 0
  if (prevCliTotal == null || !(prevCliTotal > 0) || cliTotal < prevCliTotal) return cliTotal
  const delta = cliTotal - prevCliTotal
  // The same total to the micro-dollar is one process reporting its running total again with
  // nothing spent in between (a background agent's wake-up that died, a retry). Two real
  // turns never cost the same to six decimals. The same total can arrive several times in a
  // row, the repeats with zero tokens; counting each would bill spend that never happened.
  if (delta < 1e-6) return 0
  const c = computed != null && computed > 0 ? computed : null
  // Too small to pay for this turn's own tokens: the total restarted, the raw figure is it.
  if (c != null && delta < RESTART_FLOOR * c) return cliTotal
  if (createdAt >= RUNNING_TOTAL_SINCE_MS) return delta
  // Before 2.1.278 each process started at zero, so a figure is per-turn unless the process
  // emitted several results (a background agent reporting in, a queued message).
  if (c == null) {
    // An error result with no tokens of its own, a little above the previous figure, is the
    // same process re-reporting its running total plus what its subagents spent (checked
    // against transcripts: such rows sit a little above the previous figure and the
    // transcripts show only that much subagent spend in between).
    return noTokens && cliTotal <= 1.3 * prevCliTotal ? delta : cliTotal
  }
  // Only call it a running total when the raw figure sits outside the per-turn band (p90 of
  // CLI / computed is 1.58) and the delta fits the band (median 1.2) better. Scored against
  // transcript-measured cost on pre-2.1.278 rows, this has roughly a third of the absolute
  // error of always taking the raw figure, and almost no net bias where that one overcounts.
  const target = 1.2 * c
  if (cliTotal > 1.7 * c && logDistance(delta, target) < logDistance(cliTotal, target)) return delta
  return cliTotal
}
