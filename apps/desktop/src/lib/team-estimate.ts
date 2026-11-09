/**
 * How many tokens one execution of a routine's team will probably spend, for the create/edit
 * dialogs. It is an estimate and says where it comes from:
 *
 *  - `history`: the routine already ran. The range is the lowest and highest of its last few
 *    successful runs (a single run is widened by a quarter each way, since one point is not a
 *    range). This is the honest number, and it replaces the guess as soon as there is data.
 *  - `heuristic`: no history. A member that works in its own chat reads the project, calls tools
 *    in a loop and writes a result: in the runs we measured that is about 20 to 60 thousand
 *    tokens (cache excluded), the closing summary adds roughly 10 to 20 thousand once for the
 *    whole team, and having the model review each member adds about a third more. These are
 *    round numbers on purpose; a team of small tasks lands under them and a team that reads a
 *    large project lands over, which is what the budget field is for.
 *
 * Both are rounded outward to 10 thousand so the number never looks more exact than it is.
 */

export const MEMBER_TOKENS_LOW = 20_000
export const MEMBER_TOKENS_HIGH = 60_000
export const SUMMARY_TOKENS_LOW = 10_000
export const SUMMARY_TOKENS_HIGH = 20_000
export const REVIEW_EXTRA = 1 / 3
/** How many of the latest successful runs the range is taken from. */
export const HISTORY_RUNS = 5
const SINGLE_RUN_SPREAD = 0.25
const ROUND_TO = 10_000

export interface TeamEstimate {
  low: number
  high: number
  basis: 'history' | 'heuristic'
  /** Runs the range was taken from (history only). */
  runs: number
}

export interface PastRun {
  status: 'running' | 'ok' | 'error'
  tokens: number
  startedAt: number
}

function outward(low: number, high: number): { low: number; high: number } {
  return { low: Math.floor(low / ROUND_TO) * ROUND_TO, high: Math.ceil(high / ROUND_TO) * ROUND_TO }
}

/** Null when there is nothing to estimate (no member). */
export function estimateTeamTokens(memberCount: number, options: { review?: boolean; pastRuns?: readonly PastRun[] } = {}): TeamEstimate | null {
  if (memberCount < 1) return null
  const usable = (options.pastRuns ?? [])
    .filter((r) => r.status === 'ok' && r.tokens > 0)
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, HISTORY_RUNS)
  if (usable.length > 0) {
    const tokens = usable.map((r) => r.tokens)
    let low = Math.min(...tokens)
    let high = Math.max(...tokens)
    if (usable.length === 1) {
      low *= 1 - SINGLE_RUN_SPREAD
      high *= 1 + SINGLE_RUN_SPREAD
    }
    return { ...outward(low, high), basis: 'history', runs: usable.length }
  }
  const factor = 1 + (options.review ? REVIEW_EXTRA : 0)
  return {
    ...outward(
      (memberCount * MEMBER_TOKENS_LOW + SUMMARY_TOKENS_LOW) * factor,
      (memberCount * MEMBER_TOKENS_HIGH + SUMMARY_TOKENS_HIGH) * factor,
    ),
    basis: 'heuristic',
    runs: 0,
  }
}
