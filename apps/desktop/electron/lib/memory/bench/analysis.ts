/**
 * Phase 1-6 experiments, over real vectors (CLI) or toy ones (test).
 * Everything that decides a threshold uses ONLY the "dev" split; "eval" is read just for reporting.
 */
import {
  contextualQuery,
  isolatedQuery,
  needsContextRetry,
  type ChatTurn,
} from '@shared/memory-query'
import { searchMemories } from '@shared/memory'
import { Bm25Index } from '@shared/memory-retrieval'
import {
  DEFAULT_RETRIEVAL,
  DEFAULT_SELECTION,
  quantile,
  NOISE_PROBES,
  noiseFloorOf,
  retrieveCandidates,
  type NoiseFloor,
  type RetrievalParams,
  type SelectionParams,
} from '@shared/memory-select'
import {
  auc,
  indexText,
  lexicalIndex,
  rankMetrics,
  rankOfFirstRelevant,
  runCase,
  selectionMetrics,
  toMemory,
  type BenchCase,
  type FixtureMemory,
  type Outcome,
  type VectorStore,
} from './harness'

export type Embed = (texts: string[]) => Promise<Float32Array[]>

export interface Fixture {
  memories: FixtureMemory[]
  cases: BenchCase[]
  dialogs: BenchCase[]
}

type Variant = 'old' | 'det' | 'full'

export interface Analysis {
  ranking: Record<string, Record<string, ReturnType<typeof rankMetrics> & { auc: number }>>
  [k: string]: unknown
}

async function embedMap(embed: Embed, texts: string[]): Promise<Map<string, Float32Array>> {
  const uniq = [...new Set(texts)]
  const vecs = await embed(uniq)
  return new Map(uniq.map((t, i) => [t, vecs[i]]))
}

export interface ModelData {
  store: Record<Variant, VectorStore>
  noise: Record<Variant, NoiseFloor>
  q: Map<string, Float32Array>
}

/** Embeddings for everything the experiments need, computed once. */
export async function prepare(embed: Embed, fx: Fixture): Promise<ModelData> {
  const retrievable = fx.memories.filter((m) => !m.fixed)
  const memTexts = (['old', 'det', 'full'] as Variant[]).flatMap((v) => retrievable.map((m) => indexText(m, v)))
  const qTexts: string[] = [...NOISE_PROBES, ...fx.cases.map((c) => c.text)]
  for (const d of fx.dialogs) {
    qTexts.push(d.text, contextualQuery(d.text, d.context ?? []).semantic)
    if (d.rewrite) qTexts.push(d.rewrite)
  }
  const mem = await embedMap(embed, memTexts)
  const q = await embedMap(embed, qTexts)
  const probes = NOISE_PROBES.map((p) => q.get(p)!)
  const store = {} as Record<Variant, VectorStore>
  const noise = {} as Record<Variant, NoiseFloor>
  for (const v of ['old', 'det', 'full'] as Variant[]) {
    const vectors = new Map(retrievable.map((m) => [m.id, mem.get(indexText(m, v))!]))
    store[v] = { vectors, lexical: lexicalIndex(retrievable, v) }
    noise[v] = noiseFloorOf(probes, vectors)
  }
  return { store, noise, q }
}

// ---------------------------------------------------------------------------
// Phase 3: ranking (baseline vs enriched vs lexical vs hybrid)
// ---------------------------------------------------------------------------

const rankParams = (mode: RetrievalParams['mode']): RetrievalParams => ({ ...DEFAULT_RETRIEVAL, mode })

export function orderFor(
  data: ModelData,
  variant: Variant,
  c: BenchCase,
  params: RetrievalParams,
  textOverride?: { semantic: string; lexical: string },
): string[] {
  const vec = data.q.get(textOverride?.semantic ?? c.text) ?? null
  const cands = retrieveCandidates(
    { queryVec: vec, lexicalQuery: textOverride?.lexical ?? c.text, vectors: data.store[variant].vectors, lexical: data.store[variant].lexical },
    params,
  )
  // Full ranking by cosine in the semantic path (fusion only sees each source's top-K)
  if (params.mode === 'semantic') return cands.slice().sort((a, b) => (b.cos ?? -1) - (a.cos ?? -1)).map((x) => x.id)
  return cands.map((x) => x.id)
}

export interface RankRow {
  name: string
  split: string
  m: ReturnType<typeof rankMetrics>
  auc: number
}

function topCos(data: ModelData, variant: Variant, text: string): number {
  const v = data.q.get(text)!
  let best = -1
  for (const vec of data.store[variant].vectors.values()) {
    let s = 0
    for (let i = 0; i < v.length; i++) s += v[i] * vec[i]
    if (s > best) best = s
  }
  return best
}

function goldCos(data: ModelData, variant: Variant, c: BenchCase): number {
  const v = data.q.get(c.text)!
  let best = -1
  for (const id of c.relevant) {
    const vec = data.store[variant].vectors.get(id)
    if (!vec) continue
    let s = 0
    for (let i = 0; i < v.length; i++) s += v[i] * vec[i]
    best = Math.max(best, s)
  }
  return best
}

export function rankingExperiments(data: ModelData, fx: Fixture, calibrated?: RetrievalParams): RankRow[] {
  const rows: RankRow[] = []
  const retr = fx.memories.filter((m) => !m.fixed)
  const memObjs = retr.map((m) => toMemory(m, 'old'))
  const legacyOrder = (c: BenchCase) => searchMemories(memObjs, c.text, 99).map((m) => m.id)
  const experiments: Array<[string, (c: BenchCase) => string[], Variant | null]> = [
    ['current lexical (searchMemories)', legacyOrder, null],
    ['semantic, old representation', (c) => orderFor(data, 'old', c, rankParams('semantic')), 'old'],
    ['semantic, enriched (deterministic)', (c) => orderFor(data, 'det', c, rankParams('semantic')), 'det'],
    ['semantic, enriched (with LLM)', (c) => orderFor(data, 'full', c, rankParams('semantic')), 'full'],
    ['BM25, old representation', (c) => orderFor(data, 'old', c, rankParams('lexical')), null],
    ['BM25, enriched (deterministic)', (c) => orderFor(data, 'det', c, rankParams('lexical')), null],
    ['BM25, enriched (with LLM)', (c) => orderFor(data, 'full', c, rankParams('lexical')), null],
    ['hybrid RRF, old', (c) => orderFor(data, 'old', c, rankParams('hybrid')), 'old'],
    ['hybrid RRF, enriched (deterministic)', (c) => orderFor(data, 'det', c, rankParams('hybrid')), 'det'],
    ['hybrid RRF, enriched (with LLM)', (c) => orderFor(data, 'full', c, rankParams('hybrid')), 'full'],
    ...(calibrated
      ? ([['hybrid RRF, calibrated fusion', (c: BenchCase) => orderFor(data, 'full', c, { ...calibrated, mode: 'hybrid' }), 'full']] as Array<
          [string, (c: BenchCase) => string[], Variant | null]
        >)
      : []),
  ]
  for (const split of ['dev', 'eval', 'all']) {
    const pos = fx.cases.filter((c) => c.relevant.length && (split === 'all' || c.split === split))
    const neg = fx.cases.filter((c) => !c.relevant.length && (split === 'all' || c.split === split))
    for (const [name, order, variant] of experiments) {
      const ranks = pos.map((c) => rankOfFirstRelevant(order(c), c.relevant))
      const a = variant
        ? auc(pos.map((c) => goldCos(data, variant, c)), neg.map((c) => topCos(data, variant, c.text)))
        : NaN
      rows.push({ name, split, m: rankMetrics(ranks), auc: a })
    }
  }
  return rows
}

/** Ranking breakdown by language / memory type / query type / cross-lingual (enriched hybrid). */
export function rankingBreakdown(
  data: ModelData,
  fx: Fixture,
  split: 'dev' | 'eval' | 'blocked' | 'all',
  variant: Variant = 'full',
  mode: RetrievalParams['mode'] = 'hybrid',
  retrieval: RetrievalParams = DEFAULT_RETRIEVAL,
) {
  const memById = new Map(fx.memories.map((m) => [m.id, m]))
  const pos = fx.cases.filter((c) => c.relevant.length && (split === 'all' || c.split === split))
  const groups: Record<string, Record<string, number[]>> = { language: {}, 'memory type': {}, 'query type': {}, languages: {} }
  for (const c of pos) {
    const rank = rankOfFirstRelevant(orderFor(data, variant, c, { ...retrieval, mode }), c.relevant)
    const mem = memById.get(c.relevant[0])!
    const add = (g: string, k: string) => ((groups[g][k] ??= []).push(rank))
    add('language', `query ${c.lang}`)
    add('memory type', mem.type)
    add('query type', c.qtype)
    add('languages', c.lang === mem.lang ? 'same language' : 'different language')
  }
  return Object.fromEntries(Object.entries(groups).map(([g, byKey]) => [g, Object.fromEntries(Object.entries(byKey).map(([k, ranks]) => [k, rankMetrics(ranks)]))]))
}

// ---------------------------------------------------------------------------
// Phase 5: selection policy
// ---------------------------------------------------------------------------

export function outcomesFor(
  data: ModelData,
  variant: Variant,
  cases: BenchCase[],
  retrieval: RetrievalParams,
  selection: SelectionParams,
  noise: NoiseFloor | undefined,
): Outcome[] {
  return cases.map((c) =>
    runCase({ case: c, vec: data.q.get(c.text) ?? null, lexical: c.text }, data.store[variant], retrieval, selection, noise),
  )
}

export interface PolicyCandidate {
  name: string
  selection: SelectionParams
  useNoise: boolean
}

/**
 * Rule grid. Each family sweeps its thresholds ONLY on the dev cases and picks the
 * point with the highest injection recall subject to at most `maxDevFp` irrelevant
 * injections — the safety floor of automatic injection.
 */
export function calibrate(
  data: ModelData,
  fx: Fixture,
  variant: Variant,
  maxDevFp = 2,
  retrieval: RetrievalParams = DEFAULT_RETRIEVAL,
  /** Split used to CHOOSE the thresholds. Production calibrates on "dev"; "eval" only
   * serves the sensitivity check (calibrate on one side, measure on the other). */
  split: 'dev' | 'eval' = 'dev',
) {
  const dev = fx.cases.filter((c) => c.split === split)
  const base: SelectionParams = { ...DEFAULT_SELECTION, lexInjectCoverage: 2, lexPointerCoverage: 2, minMargin: 0 }
  const range = (a: number, b: number, step: number) => {
    const out: number[] = []
    for (let x = a; x <= b + 1e-9; x += step) out.push(+x.toFixed(4))
    return out
  }
  const families: Array<{ name: string; grid: Array<Partial<SelectionParams> & { _z?: number }>; noise: boolean }> = [
    { name: 'A. absolute threshold', noise: false, grid: range(0.3, 0.8, 0.01).flatMap((t) => [{ threshold: 'absolute' as const, injectCos: t, pointerCos: Math.max(0.2, t - 0.08) }]) },
    { name: 'B. absolute + margin over the 2nd', noise: false, grid: range(0.3, 0.8, 0.02).flatMap((t) => range(0.01, 0.1, 0.03).map((m) => ({ threshold: 'absolute' as const, injectCos: t, pointerCos: Math.max(0.2, t - 0.08), minMargin: m }))) },
    { name: 'C. pool noise floor (probes)', noise: true, grid: range(0.7, 1, 0.1).flatMap((q) => range(-0.05, 0.3, 0.01).map((d) => ({ threshold: 'collection' as const, noiseQuantile: q, injectDelta: d, pointerDelta: Math.min(d - 0.03, d) }))) },
    { name: 'D. pool + lexical coverage', noise: true, grid: range(0.8, 1, 0.1).flatMap((q) => range(0, 0.3, 0.02).flatMap((d) => [0.5, 0.7, 0.9].map((cov) => ({ threshold: 'collection' as const, noiseQuantile: q, injectDelta: d, pointerDelta: d - 0.04, lexInjectCoverage: cov })))) },
    // E. Injection by a high absolute cosine (which is what the curve shows to be
    // necessary) and pointers within a window relative to the top, without requiring a
    // high cosine: it is the "plausible" level of the plan, and it is what family A/B let
    // die at the pointer threshold.
    {
      name: 'E. absolute injection + pointers by window',
      noise: false,
      grid: range(0.45, 0.72, 0.01).flatMap((t) =>
        range(0.25, t, 0.02).flatMap((pt) =>
          [1, 2, 3].flatMap((maxPointers) =>
            [0.04, 0.08, 0.12].map((gap) => ({ threshold: 'absolute' as const, injectCos: t, pointerCos: pt, maxPointers, gap })),
          ),
        ),
      ),
    },
    // F. Injection by the pool floor (the family that won in practice) and a
    // pointer with its OWN, lower threshold: they are different decisions and
    // tying them (pointerDelta = injectDelta - 0.04) was what zeroed the
    // pointers. F is the only family that measures the two separately.
    {
      name: 'F. pool injection + independent pointer',
      noise: true,
      grid: range(0.19, 0.4, 0.03).flatMap((dInj) =>
        [0, 0.03, 0.06, 0.09, 0.12, 0.16].flatMap((dPtr) =>
          [2, 2].flatMap(() =>
            [2, 3].flatMap((maxPointers) =>
              [0.5, 0.7, 0.9].map((cov) => ({
                threshold: 'collection' as const,
                noiseQuantile: 1,
                injectDelta: dInj,
                pointerDelta: dPtr,
                lexInjectCoverage: cov,
                maxPointers,
                gap: 0.1,
              })),
            ),
          ),
        ),
      ),
    },
  ]
  const results = []
  for (const fam of families) {
    let best: { params: SelectionParams; met: ReturnType<typeof selectionMetrics>; score: number } | null = null
    for (const g of fam.grid) {
      const params = { ...base, ...g } as SelectionParams
      const met = selectionMetrics(outcomesFor(data, variant, dev, retrieval, params, fam.noise ? data.noise[variant] : undefined))
      if (met.falsePositives > maxDevFp) continue
      // Score: what came in useful (injection is worth more than a pointer) minus what
      // came in as junk. The FP ceiling comes first, as a constraint.
      const score =
        met.injectCasesHit * 100 +
        met.pointerCasesPointer * 30 +
        met.relevantInjected * 5 -
        met.junkPointers * 3 -
        met.negWithPointer * 8 +
        met.negClean * 2 +
        params.injectCos * 0.0001
      if (!best || score > best.score) best = { params, met, score }
    }
    results.push({ family: fam.name, best })
  }
  return results
}

export function evaluatePolicy(
  data: ModelData,
  fx: Fixture,
  variant: Variant,
  params: SelectionParams,
  useNoise: boolean,
  split: 'dev' | 'eval' | 'blocked' | 'all',
  retrieval: RetrievalParams = DEFAULT_RETRIEVAL,
) {
  const cases = fx.cases.filter((c) => split === 'all' || c.split === split)
  const outs = outcomesFor(data, variant, cases, retrieval, params, useNoise ? data.noise[variant] : undefined)
  return { met: selectionMetrics(outs), outs }
}

/**
 * Grouped selection metrics (cross-language, query type, expectation).
 * `outs` and `cases` must be in the same order — which is what `evaluatePolicy` returns.
 */
export function selectionByGroup(outs: Outcome[], cases: BenchCase[], key: (c: BenchCase) => string) {
  const by = new Map<string, Outcome[]>()
  outs.forEach((o, i) => {
    const k = key(cases[i])
    const g = by.get(k)
    if (g) g.push(o)
    else by.set(k, [o])
  })
  return [...by.entries()].map(([group, list]) => ({ group, n: list.length, met: selectionMetrics(list) }))
}

// ---------------------------------------------------------------------------
// Phase 4: context
// ---------------------------------------------------------------------------

export function contextExperiments(
  data: ModelData,
  fx: Fixture,
  variant: Variant,
  params: SelectionParams,
  useNoise: boolean,
  retrieval: RetrievalParams = DEFAULT_RETRIEVAL,
) {
  const noise = useNoise ? data.noise[variant] : undefined
  const modes: Record<string, (d: BenchCase) => Outcome> = {
    '1. mensagem isolada': (d) => runCase({ case: d, vec: data.q.get(d.text)!, lexical: d.text }, data.store[variant], retrieval, params, noise),
    '2. mensagem + contexto (sempre)': (d) => {
      const q = contextualQuery(d.text, d.context as ChatTurn[])
      return runCase({ case: d, vec: data.q.get(q.semantic)!, lexical: q.lexical }, data.store[variant], retrieval, params, noise)
    },
    '3. ideal rewrite (upper bound)': (d) =>
      runCase({ case: d, vec: data.q.get(d.rewrite!)!, lexical: d.rewrite! }, data.store[variant], retrieval, params, noise),
    '4. context only when the isolated search fails': (d) => {
      const first = runCase({ case: d, vec: data.q.get(d.text)!, lexical: d.text }, data.store[variant], retrieval, params, noise)
      const found = first.injected.length > 0 || first.pointers.length > 0
      if (!needsContextRetry(d.text, (d.context?.length ?? 0) > 0, found)) return first
      const q = contextualQuery(d.text, d.context as ChatTurn[])
      return runCase({ case: d, vec: data.q.get(q.semantic)!, lexical: q.lexical }, data.store[variant], retrieval, params, noise)
    },
  }
  const out: Record<string, ReturnType<typeof selectionMetrics> & { top1: number; n: number }> = {}
  for (const [name, run] of Object.entries(modes)) {
    const outs = fx.dialogs.map(run)
    const withRel = fx.dialogs.filter((d) => d.relevant.length)
    const top1 = outs.filter((o) => o.case.relevant.length && o.candidates.length && o.case.relevant.includes(topWithoutMemory(o))).length
    out[name] = { ...selectionMetrics(outs), top1, n: withRel.length }
  }
  return out
}

function topWithoutMemory(o: Outcome): string {
  return o.candidates.slice().sort((a, b) => (b.cos ?? -1) - (a.cos ?? -1))[0]?.id ?? ''
}
export { isolatedQuery, Bm25Index }

// ---------------------------------------------------------------------------
// Diagnostics: does the signal separate?
// ---------------------------------------------------------------------------

export interface CosDiag {
  id: string
  split: string
  expect: string
  qtype: string
  lang: string
  /** Cosine of the memories labelled relevant (the maximum among them) */
  gold: number | null
  /** Highest cosine in the pool for this query */
  top: number
  topId: string
}

/**
 * Distribution of cosines per query type. It is what tells whether an
 * ABSOLUTE threshold can work: if the top of the queries that need no memory
 * (expect=none) touches the top of the ones that do, no fixed number separates the
 * two — and the decision has to come from relative signals (margin, coverage, fusion).
 */
export function cosineDiagnostics(data: ModelData, fx: Fixture, variant: Variant): CosDiag[] {
  return fx.cases.map((c) => {
    const qv = data.q.get(c.text)
    if (!qv) return { id: c.id, split: c.split, expect: c.expect, qtype: c.qtype, lang: c.lang, gold: null, top: -1, topId: '' }
    let top = -1
    let topId = ''
    for (const [id, vec] of data.store[variant].vectors) {
      let s = 0
      for (let i = 0; i < qv.length; i++) s += qv[i] * vec[i]
      if (s > top) {
        top = s
        topId = id
      }
    }
    let gold: number | null = null
    for (const id of c.relevant) {
      const vec = data.store[variant].vectors.get(id)
      if (!vec) continue
      let s = 0
      for (let i = 0; i < qv.length; i++) s += qv[i] * vec[i]
      gold = Math.max(gold ?? -1, s)
    }
    return { id: c.id, split: c.split, expect: c.expect, qtype: c.qtype, lang: c.lang, gold, top, topId }
  })
}

export function percentiles(values: number[], qs = [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1]) {
  const sorted = [...values].sort((a, b) => a - b)
  const at = (q: number) => {
    if (!sorted.length) return 0
    const pos = Math.min(sorted.length - 1, Math.max(0, q * (sorted.length - 1)))
    const lo = Math.floor(pos)
    const hi = Math.ceil(pos)
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo)
  }
  return Object.fromEntries(qs.map((q) => [`p${Math.round(q * 100)}`, +at(q).toFixed(3)]))
}

// ---------------------------------------------------------------------------
// Fusion weights (Phase 3)
// ---------------------------------------------------------------------------

export interface FusionChoice {
  semWeight: number
  lexWeight: number
  /** Only candidates with this minimum coverage enter the lexical list */
  lexMinCoverage: number
  hit1: number
  mrr: number
}

/**
 * Sweeps the RRF weights ONLY on the dev cases and picks what maximises R@1 and, on a
 * tie, MRR. Equal-weight fusion is not a given: it is a hypothesis, and on the
 * synthetic pool it lets a one-off lexical match tie with the best
 * semantic one — which only shows up when you measure.
 */
export function calibrateFusion(
  data: ModelData,
  fx: Fixture,
  variant: Variant,
  mode: RetrievalParams['mode'] = 'hybrid',
  split: 'dev' | 'eval' = 'dev',
): FusionChoice[] {
  const dev = fx.cases.filter((c) => c.split === split && c.relevant.length)
  const out: FusionChoice[] = []
  for (const lexWeight of [0, 0.1, 0.2, 0.3, 0.5, 0.8, 1]) {
    for (const lexMinCoverage of [0, 0.5, 0.9]) {
      const params: RetrievalParams = { ...DEFAULT_RETRIEVAL, mode, lexWeight, semWeight: 1, lexMinCoverage }
      const ranks = dev.map((c) => rankOfFirstRelevant(orderFor(data, variant, c, params), c.relevant))
      const m = rankMetrics(ranks)
      out.push({ semWeight: 1, lexWeight, lexMinCoverage, hit1: m.hit1, mrr: m.mrr })
    }
  }
  return out.sort((a, b) => b.hit1 - a.hit1 || b.mrr - a.mrr)
}

// ---------------------------------------------------------------------------
// Comparison of decision rules (Phase 5)
// ---------------------------------------------------------------------------

export interface RuleSample {
  expect: string
  qtype: string
  split: string
  /** Cosine of the 1st candidate */
  top: number
  /** Cosine of the 2nd candidate (0 when there is only one) */
  second: number
  /** Cosine of the best labelled memory (null if the pool does not have it) */
  gold: number | null
  /** The best labelled memory is the 1st candidate */
  goldIsTop: boolean
  /** Lexical coverage of the 1st candidate */
  topCoverage: number
  /** Cosine of the 1st candidate minus the pool's noise floor */
  aboveNoise: number
}

export function ruleSamples(data: ModelData, fx: Fixture, variant: Variant): RuleSample[] {
  return fx.cases.map((c) => {
    const cands = retrieveCandidates(
      { queryVec: data.q.get(c.text), lexicalQuery: c.text, vectors: data.store[variant].vectors, lexical: data.store[variant].lexical },
      DEFAULT_RETRIEVAL,
    )
    const byCos = cands.filter((x) => x.cos != null).sort((a, b) => b.cos! - a.cos!)
    const top = byCos[0]?.cos ?? -1
    const second = byCos[1]?.cos ?? 0
    const gold = byCos.find((x) => c.relevant.includes(x.id))?.cos ?? null
    const noiseMax = quantile(data.noise[variant].tops, 1)
    return {
      expect: c.expect,
      qtype: c.qtype,
      split: c.split,
      top,
      second,
      gold,
      goldIsTop: byCos[0] != null && c.relevant.includes(byCos[0].id),
      topCoverage: byCos[0]?.coverage ?? 0,
      aboveNoise: top - noiseMax,
    }
  })
}

export interface RuleResult {
  rule: string
  /** Queries that ASK for memory and would be injected */
  injectHit: number
  injectN: number
  /** Queries that need no memory in which the rule would inject */
  falsePos: number
  negN: number
  /** False positives only among the neighbouring-theme cases (the hard ones) */
  falsePosRel: number
  relN: number
}

/**
 * Compares decision rules on the DEVELOPMENT cases. The question is always the
 * same: how many queries that need memory the rule covers, and at what cost
 * in queries that do not. No rule is chosen here — the report
 * shows the whole table so the decision stays auditable.
 */
export function compareRules(samples: RuleSample[], split: 'dev' | 'eval' = 'dev'): RuleResult[] {
  const s = samples.filter((x) => x.split === split)
  const pos = s.filter((x) => x.expect !== 'none')
  const neg = s.filter((x) => x.expect === 'none')
  const rel = neg.filter((x) => x.qtype === 'rel')
  const rules: Array<[string, (x: RuleSample) => boolean]> = [
    ['cosine ≥ 0.50', (x) => x.top >= 0.5],
    ['cosine ≥ 0.55', (x) => x.top >= 0.55],
    ['cosine ≥ 0.60', (x) => x.top >= 0.6],
    ['cosine ≥ 0.65', (x) => x.top >= 0.65],
    ['cos ≥ 0.50 + margin ≥ 0.05', (x) => x.top >= 0.5 && x.top - x.second >= 0.05],
    ['cos ≥ 0.50 + margin ≥ 0.08', (x) => x.top >= 0.5 && x.top - x.second >= 0.08],
    ['cos ≥ 0.55 + margin ≥ 0.05', (x) => x.top >= 0.55 && x.top - x.second >= 0.05],
    ['cos ≥ 0.55 + margin ≥ 0.10', (x) => x.top >= 0.55 && x.top - x.second >= 0.1],
    ['cos ≥ 0.50 + coverage ≥ 0.6', (x) => x.top >= 0.5 && x.topCoverage >= 0.6],
    ['cos ≥ 0.50 + coverage ≥ 0.9', (x) => x.top >= 0.5 && x.topCoverage >= 0.9],
    ['cos ≥ noise floor + 0.20', (x) => x.top >= 0.2 && x.aboveNoise >= 0.2],
    ['cos ≥ noise floor + 0.27', (x) => x.top >= 0.27 && x.aboveNoise >= 0.27],
    ['cos ≥ 0.45 + margin ≥ 0.06', (x) => x.top >= 0.45 && x.top - x.second >= 0.06],
  ]
  return rules.map(([rule, test]) => ({
    rule,
    injectHit: pos.filter((x) => test(x) && x.goldIsTop).length,
    injectN: pos.length,
    falsePos: neg.filter(test).length,
    negN: neg.length,
    falsePosRel: rel.filter(test).length,
    relN: rel.length,
  }))
}
