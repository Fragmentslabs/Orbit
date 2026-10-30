/**
 * Label triage and pilot metrics — pure: no model, no I/O, no
 * real memories. It is the part of the evaluator that decides *which* scenarios enter
 * each denominator, and that is why it has to be testable on its own.
 *
 * Central rule: an unreviewed scenario is NEVER interpreted as "no
 * memory". It simply does not enter any count.
 */

/** Decisions accepted as a label. Anything else = missing decision. */
export const DECISIONS = ['inject', 'pointer', 'none'] as const
export type Decision = (typeof DECISIONS)[number]

export interface LabelEntry {
  id: string
  memoryId: string | null
  query?: string
  decision?: string
  reason?: string
  role?: string
}

export interface QueueEntry {
  id: string
  memoryId: string | null
  role?: string
}

export interface Triage {
  /** entries present in the file, including the discarded ones */
  total: number
  /** in the batch, but absent from the file (the export omitted them) */
  notInFile: string[]
  /** in the file, with no query written */
  unreviewed: string[]
  /** flagged as inconclusive by the reviewer */
  inconclusive: string[]
  /** id that does not exist in the batch (orphan label from a previous batch) */
  invalidId: string[]
  /** target memory that no longer exists in the pool */
  invalidTarget: string[]
  /** reviewed and valid, but with no decision chosen */
  missingDecision: string[]
  /** ranking basis: query + valid target */
  valid: LabelEntry[]
  /** decision-metric basis: valid and with a decision */
  decided: LabelEntry[]
}

/**
 * Splits the labels into explicit sets. The order of the checks matters:
 * an orphan id is discarded before anything else (we do not know which scenario it belongs to),
 * an empty query is "not reviewed", and a nonexistent target is a data error.
 */
export function triage(labels: LabelEntry[], queue: QueueEntry[], corpusIds: Set<string>): Triage {
  const byId = new Map(queue.map((q) => [q.id, q]))
  const seen = new Set<string>()
  const t: Triage = {
    total: labels.length,
    notInFile: [],
    unreviewed: [],
    inconclusive: [],
    invalidId: [],
    invalidTarget: [],
    missingDecision: [],
    valid: [],
    decided: [],
  }

  for (const l of labels) {
    seen.add(l.id)
    if (!byId.has(l.id)) {
      t.invalidId.push(l.id)
      continue
    }
    if (!l.query || !l.query.trim()) {
      t.unreviewed.push(l.id)
      continue
    }
    const decision = (l.decision ?? '').trim()
    if (decision === 'inconclusive') {
      t.inconclusive.push(l.id)
      continue
    }
    if (l.memoryId && !corpusIds.has(l.memoryId)) {
      t.invalidTarget.push(l.id)
      continue
    }
    t.valid.push(l)
    if ((DECISIONS as readonly string[]).includes(decision)) t.decided.push(l)
    else t.missingDecision.push(l.id)
  }

  t.notInFile = queue.map((q) => q.id).filter((id) => !seen.has(id))
  return t
}

export interface RankRow {
  id: string
  role: string
  memoryId: string | null
  lexRank: number | null
  hybRank: number | null
  lexHits: number
  hybTopCos: number | null
  tier: string
  decision: string
}

export interface RankSummary {
  n: number
  r1: number
  r5: number
  mrr: number
}

export interface PilotReport {
  targets: {
    n: number
    lexical: RankSummary
    hybrid: RankSummary
    /** target in the hybrid's top-5 and out of the lexical top-5 */
    hybOnly: string[]
    /** target in the lexical top-5 and out of the hybrid top-5 */
    lexOnly: string[]
    /** target in both top-5s */
    both: string[]
    /** target out of both top-5s */
    neither: string[]
  }
  noMemory: {
    n: number
    /** queries that need no memory and got a candidate from the lexical search */
    lexReturned: number
    /** ... and whose hybrid top went past the calibrated floor */
    hybAboveFloor: number
  }
  decision: Array<{ expected: Decision; n: number; match: number; tiers: Record<string, number> }>
}

const emptySummary = (): RankSummary => ({ n: 0, r1: 0, r5: 0, mrr: 0 })

function summariseRank(rows: RankRow[], pick: (r: RankRow) => number | null): RankSummary {
  const s = emptySummary()
  s.n = rows.length
  if (!rows.length) return s
  let hits1 = 0
  let hits5 = 0
  let rr = 0
  for (const r of rows) {
    const rank = pick(r)
    if (rank === 1) hits1++
    if (rank !== null && rank <= 5) hits5++
    if (rank !== null && rank > 0) rr += 1 / rank
  }
  s.r1 = hits1 / s.n
  s.r5 = hits5 / s.n
  s.mrr = rr / s.n
  return s
}

/**
 * Aggregates the rows already computed. `floor` is the pool's noise floor, used only
 * to say whether the hybrid top would pass the pointer threshold.
 */
export function summarize(rows: RankRow[], floor: number): PilotReport {
  const targets = rows.filter((r) => r.role !== 'no-memory' && r.memoryId)
  const noMem = rows.filter((r) => r.role === 'no-memory' || !r.memoryId)

  const inTop5 = (rank: number | null) => rank !== null && rank > 0 && rank <= 5
  const hybOnly = targets.filter((r) => inTop5(r.hybRank) && !inTop5(r.lexRank)).map((r) => r.id)
  const lexOnly = targets.filter((r) => inTop5(r.lexRank) && !inTop5(r.hybRank)).map((r) => r.id)
  const both = targets.filter((r) => inTop5(r.lexRank) && inTop5(r.hybRank)).map((r) => r.id)
  const neither = targets.filter((r) => !inTop5(r.lexRank) && !inTop5(r.hybRank)).map((r) => r.id)

  const decision: PilotReport['decision'] = []
  for (const expected of DECISIONS) {
    const set = rows.filter((r) => r.decision === expected)
    if (!set.length) continue
    const tiers: Record<string, number> = {}
    for (const r of set) tiers[r.tier] = (tiers[r.tier] ?? 0) + 1
    decision.push({ expected, n: set.length, match: set.filter((r) => r.tier === expected).length, tiers })
  }

  return {
    targets: {
      n: targets.length,
      lexical: summariseRank(targets, (r) => r.lexRank),
      hybrid: summariseRank(targets, (r) => r.hybRank),
      hybOnly,
      lexOnly,
      both,
      neither,
    },
    noMemory: {
      n: noMem.length,
      lexReturned: noMem.filter((r) => r.lexHits > 0).length,
      hybAboveFloor: noMem.filter((r) => (r.hybTopCos ?? -1) >= floor).length,
    },
    decision,
  }
}
