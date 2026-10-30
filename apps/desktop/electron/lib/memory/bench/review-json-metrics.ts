/**
 * Metrics of the JSON-based evaluation — pure, no I/O, no model.
 *
 * Rules that hold here and are explained in the guide:
 *
 * - Only results classified as `relevant` or
 *   `irrelevant` enter the metrics. `conclusive` (empty) and `inconclusive` NEVER count as
 *   irrelevant: they leave the denominator.
 * - A query with no judgement at all does not enter the mean.
 * - Precision@5 is the mean, per query, of relevant / judged in the top 5.
 * - MRR is the mean of 1/rank of the first `relevant`; if the query was
 *   judged and has no relevant item, it counts as 0.
 * - Queries with `expected` = "none" do not enter P@5 or MRR: they measure
 *   an improper candidate, which is a different question.
 */

export type Judgement = '' | 'relevant' | 'irrelevant' | 'inconclusive'

/** What the query is supposed to retrieve. */
export type Expectation = 'retrieve' | 'none'

export interface ReviewHit {
  rank: number
  id: string
  score?: number
  cos?: number
  coverage?: number
}

export interface ReviewMemoryEntry {
  text?: string
  classification?: string
  notes?: string
}

export interface ReviewQueryJson {
  id: string
  type?: string
  expected?: Expectation
  lexical?: { top5?: ReviewHit[] }
  hybrid?: { top5?: ReviewHit[] }
  memories?: Record<string, ReviewMemoryEntry>
}

export type Mechanism = 'lexical' | 'hybrid'

export interface MechanismScore {
  /** queries whose `expected` expects retrieval */
  queries: number
  /** queries with at least one judgement — the basis of the means */
  scored: number
  p5: number
  mrr: number
  /** fraction of the evaluated ones with at least one `relevant` in the top 5 */
  hit5: number
  relevant: number
  irrelevant: number
  inconclusive: number
  unjudged: number
}

export interface NoMemoryScore {
  queries: number
  /** queries in which the mechanism returned some result */
  returned: number
  /** results marked `relevant` on a query that should retrieve nothing */
  markedRelevant: number
  conflicts: string[]
}

export interface Comparison {
  both: string[]
  hybridOnly: string[]
  lexicalOnly: string[]
  neither: string[]
}

// ---------------------------------------------------------------------------
// Reading: the legacy format
// ---------------------------------------------------------------------------

/**
 * Label files written before the schema was translated to English carry the
 * Portuguese keys (`esperado`, `memorias`, `hibrido`, ...). They keep loading:
 * this is the single place that knows the old names. Everything is normalized
 * on read, and what we write is always English.
 */

type Raw = Record<string, unknown>

function field<T>(raw: Raw | undefined, ...keys: string[]): T | undefined {
  if (!raw) return undefined
  for (const key of keys) if (raw[key] !== undefined) return raw[key] as T
  return undefined
}

function objectOf(value: unknown): Raw | undefined {
  return value && typeof value === 'object' ? (value as Raw) : undefined
}

function expectationOf(value: unknown): Expectation | undefined {
  if (value === 'retrieve' || value === 'recuperar') return 'retrieve'
  if (value === 'none' || value === 'nenhuma') return 'none'
  return undefined
}

function hitOf(raw: Raw): ReviewHit {
  return {
    rank: Number(raw.rank),
    id: String(raw.id),
    score: field<number>(raw, 'score'),
    cos: field<number>(raw, 'cos'),
    coverage: field<number>(raw, 'coverage', 'cobertura'),
  }
}

function top5Of(value: unknown): { top5?: ReviewHit[] } | undefined {
  const raw = objectOf(value)
  if (!raw) return undefined
  const top5 = field<unknown[]>(raw, 'top5')
  return Array.isArray(top5) ? { top5: top5.map((h) => hitOf(objectOf(h) ?? {})) } : {}
}

function entryOf(raw: Raw): ReviewMemoryEntry {
  return {
    text: field<string>(raw, 'text', 'texto'),
    classification: field<string>(raw, 'classification', 'classificacao'),
    notes: field<string>(raw, 'notes', 'obs'),
  }
}

function memoriesOf(value: unknown): Record<string, ReviewMemoryEntry> | undefined {
  const raw = objectOf(value)
  if (!raw) return undefined
  const out: Record<string, ReviewMemoryEntry> = {}
  for (const [id, entry] of Object.entries(raw)) out[id] = entryOf(objectOf(entry) ?? {})
  return out
}

/** One query of the review JSON, in English — legacy keys accepted. */
export function parseQuery(value: unknown): ReviewQueryJson {
  const raw = objectOf(value) ?? {}
  return {
    id: String(field<string>(raw, 'id') ?? ''),
    type: field<string>(raw, 'type', 'tipo'),
    expected: expectationOf(field(raw, 'expected', 'esperado')),
    lexical: top5Of(field(raw, 'lexical')),
    hybrid: top5Of(field(raw, 'hybrid', 'hibrido')),
    memories: memoriesOf(field(raw, 'memories', 'memorias')),
  }
}

/** The whole file (or its query list) in English — legacy keys accepted. */
export function parseQueries(value: unknown): ReviewQueryJson[] {
  if (Array.isArray(value)) return value.map((q) => parseQuery(q))
  const raw = objectOf(value) ?? {}
  const list = field<unknown[]>(raw, 'queries', 'consultas')
  return Array.isArray(list) ? list.map((q) => parseQuery(q)) : []
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

function judge(q: ReviewQueryJson, id: string): Judgement {
  const raw = (q.memories?.[id]?.classification ?? '').trim()
  if (raw === 'relevant' || raw === 'irrelevant' || raw === 'inconclusive') return raw
  return ''
}

function hits(q: ReviewQueryJson, mech: Mechanism): ReviewHit[] {
  const list = mech === 'lexical' ? q.lexical?.top5 : q.hybrid?.top5
  return Array.isArray(list) ? list : []
}

export function scoreMechanism(queries: ReviewQueryJson[], mech: Mechanism): MechanismScore {
  const rows = queries.filter((q) => q.expected !== 'none')
  const out: MechanismScore = {
    queries: rows.length,
    scored: 0,
    p5: 0,
    mrr: 0,
    hit5: 0,
    relevant: 0,
    irrelevant: 0,
    inconclusive: 0,
    unjudged: 0,
  }
  let p5Sum = 0
  let mrrSum = 0
  let hitSum = 0

  for (const q of rows) {
    let judged = 0
    let relevant = 0
    let firstRelevant = 0
    for (const h of hits(q, mech).slice(0, 5)) {
      const c = judge(q, h.id)
      if (c === '') out.unjudged++
      else if (c === 'inconclusive') out.inconclusive++
      else {
        judged++
        if (c === 'relevant') {
          relevant++
          if (!firstRelevant) firstRelevant = h.rank
        }
      }
    }
    out.relevant += relevant
    out.irrelevant += judged - relevant
    if (!judged) continue
    out.scored++
    p5Sum += relevant / judged
    mrrSum += firstRelevant ? 1 / firstRelevant : 0
    hitSum += relevant > 0 ? 1 : 0
  }

  if (out.scored) {
    out.p5 = p5Sum / out.scored
    out.mrr = mrrSum / out.scored
    out.hit5 = hitSum / out.scored
  }
  return out
}

export function scoreNoMemory(queries: ReviewQueryJson[], mech: Mechanism): NoMemoryScore {
  const rows = queries.filter((q) => q.expected === 'none')
  const out: NoMemoryScore = { queries: rows.length, returned: 0, markedRelevant: 0, conflicts: [] }
  for (const q of rows) {
    const list = hits(q, mech).slice(0, 5)
    if (list.length) out.returned++
    const relevant = list.filter((h) => judge(q, h.id) === 'relevant')
    if (relevant.length) {
      out.markedRelevant += relevant.length
      out.conflicts.push(q.id)
    }
  }
  return out
}

/** On which queries each mechanism found something judged relevant. */
export function compareMechanisms(queries: ReviewQueryJson[]): Comparison {
  const out: Comparison = { both: [], hybridOnly: [], lexicalOnly: [], neither: [] }
  for (const q of queries.filter((x) => x.expected !== 'none')) {
    const lex = hits(q, 'lexical').some((h) => judge(q, h.id) === 'relevant')
    const hyb = hits(q, 'hybrid').some((h) => judge(q, h.id) === 'relevant')
    if (lex && hyb) out.both.push(q.id)
    else if (hyb) out.hybridOnly.push(q.id)
    else if (lex) out.lexicalOnly.push(q.id)
    else out.neither.push(q.id)
  }
  return out
}
