/**
 * Retrieval benchmark harness: fixture types, metrics and evaluation.
 * Pure (no ONNX): it receives vectors already computed, so it runs in a test with a
 * toy embedder and in the CLI with the real Bekko.
 */
import type { Memory } from '@shared/memory'
import { Bm25Index, buildRetrievalText, lexicalDocOf } from '@shared/memory-retrieval'
import {
  retrieveCandidates,
  selectForContext,
  type Candidate,
  type NoiseFloor,
  type RetrievalParams,
  type SelectionParams,
} from '@shared/memory-select'

export interface FixtureMemory {
  id: string
  lang: string
  type: string
  fixed?: boolean
  text: string
  title?: string
  tags: string[]
  entities?: string[]
  concepts?: string[]
}

export type Expect = 'inject' | 'pointer' | 'none'

export interface BenchCase {
  id: string
  /**
   * `dev` = tuning; `eval` = evaluation on the main fixture; `blocked` =
   * a new set, created after the design was frozen and never used to
   * choose a parameter (see policy.ts).
   */
  split: 'dev' | 'eval' | 'blocked'
  lang: string
  qtype: string
  text: string
  relevant: string[]
  expect: Expect
  reason: string
  /** Only in dialogs */
  context?: Array<{ role: 'user' | 'assistant'; text: string }>
  rewrite?: string
}

export function toMemory(m: FixtureMemory, variant: 'old' | 'det' | 'full'): Memory {
  return {
    id: m.id,
    kind: 'general',
    text: m.text,
    tags: m.tags,
    weight: 0.7,
    hits: 0,
    relatedIds: [],
    createdAt: 0,
    ...(variant === 'full' ? { title: m.title, entities: m.entities, concepts: m.concepts } : undefined),
  }
}

/**
 * Indexed representation. "old" = what the previous measurement embedded (text +
 * tags line); "det" = deterministic-only enrichment (no LLM);
 * "full" = with title/entities/concepts the writing LLM would fill in.
 */
export function indexText(m: FixtureMemory, variant: 'old' | 'det' | 'full'): string {
  if (variant === 'old') return `${m.text}${m.tags.length ? `\nTags: ${m.tags.join(', ')}` : ''}`
  return buildRetrievalText(toMemory(m, variant))
}

export function lexicalIndex(memories: FixtureMemory[], variant: 'old' | 'det' | 'full'): Bm25Index {
  return new Bm25Index(
    memories.map((m) => {
      const mem = toMemory(m, variant === 'old' ? 'old' : variant)
      if (variant === 'old') return { id: m.id, text: `${m.text} ${m.tags.join(' ')}` }
      return lexicalDocOf(mem)
    }),
  )
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

export function rankOfFirstRelevant(order: string[], relevant: string[]): number {
  const i = order.findIndex((id) => relevant.includes(id))
  return i < 0 ? Infinity : i + 1
}

export interface RankMetrics {
  n: number
  hit1: number
  hit3: number
  hit5: number
  mrr: number
}

export function rankMetrics(ranks: number[]): RankMetrics {
  const n = ranks.length
  const frac = (k: number) => (n ? ranks.filter((r) => r <= k).length / n : 0)
  return { n, hit1: frac(1), hit3: frac(3), hit5: frac(5), mrr: n ? ranks.reduce((s, r) => s + (r === Infinity ? 0 : 1 / r), 0) / n : 0 }
}

/** AUC: P(cosine of the right memory of a query > highest cosine of a negative query). */
export function auc(pos: number[], neg: number[]): number {
  if (!pos.length || !neg.length) return NaN
  let s = 0
  for (const p of pos) for (const n of neg) s += p > n ? 1 : p === n ? 0.5 : 0
  return s / (pos.length * neg.length)
}

/** 95% Wilson interval for a proportion. */
export function wilson(k: number, n: number): [number, number] {
  if (!n) return [0, 0]
  const z = 1.96
  const p = k / n
  const d = 1 + (z * z) / n
  const c = p + (z * z) / (2 * n)
  const w = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))
  return [(c - w) / d, (c + w) / d]
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

export interface VectorStore {
  vectors: Map<string, Float32Array>
  lexical: Bm25Index
}

export interface QueryInput {
  case: BenchCase
  vec: Float32Array | null
  /** Text used in the lexical search */
  lexical: string
}

export interface Outcome {
  case: BenchCase
  candidates: Candidate[]
  injected: string[]
  pointers: string[]
}

export function runCase(
  q: QueryInput,
  store: VectorStore,
  retrieval: RetrievalParams,
  selection: SelectionParams,
  noise: NoiseFloor | undefined,
): Outcome {
  const candidates = retrieveCandidates({ queryVec: q.vec, lexicalQuery: q.lexical, vectors: store.vectors, lexical: store.lexical }, retrieval)
  const sel = selectForContext(candidates, noise, selection)
  return { case: q.case, candidates, injected: sel.inject.map((c) => c.id), pointers: sel.pointers.map((c) => c.id) }
}

export interface SelectionMetrics {
  /** Queries that need memory */
  positives: number
  /** Queries that need no memory */
  negatives: number
  /** Relevant memories (from expect=inject queries) injected / total relevant */
  relevantInjected: number
  relevantTotal: number
  /** expect=inject queries in which at least one relevant memory was injected */
  injectCasesHit: number
  injectCases: number
  /** expect=pointer queries: useful pointer / injection (acceptable) / nothing */
  pointerCasesPointer: number
  pointerCasesInjected: number
  pointerCases: number
  /** Relevant items of expect=inject that stayed only as a pointer */
  injectCasesDemoted: number
  /** Injected memories that are NOT relevant (any query) */
  falsePositives: number
  injectedTotal: number
  /** expect=none queries with any injection / with any pointer */
  negWithInjection: number
  negWithPointer: number
  negClean: number
  /** Non-relevant pointers among those emitted on positive queries */
  junkPointers: number
  /** Estimated token totals (chars/4) of what would be injected */
  pointerTotal: number
}

export function selectionMetrics(outcomes: Outcome[]): SelectionMetrics {
  const m: SelectionMetrics = {
    positives: 0, negatives: 0, relevantInjected: 0, relevantTotal: 0, injectCasesHit: 0, injectCases: 0,
    pointerCasesPointer: 0, pointerCasesInjected: 0, pointerCases: 0, injectCasesDemoted: 0,
    falsePositives: 0, injectedTotal: 0, negWithInjection: 0, negWithPointer: 0, negClean: 0, junkPointers: 0, pointerTotal: 0,
  }
  for (const o of outcomes) {
    const rel = new Set(o.case.relevant)
    const injRel = o.injected.filter((id) => rel.has(id))
    m.injectedTotal += o.injected.length
    m.falsePositives += o.injected.length - injRel.length
    m.pointerTotal += o.pointers.length
    if (o.case.expect === 'none') {
      m.negatives++
      if (o.injected.length) m.negWithInjection++
      if (o.pointers.length) m.negWithPointer++
      if (!o.injected.length && !o.pointers.length) m.negClean++
      continue
    }
    m.positives++
    m.junkPointers += o.pointers.filter((id) => !rel.has(id)).length
    if (o.case.expect === 'inject') {
      m.injectCases++
      m.relevantTotal += rel.size
      m.relevantInjected += injRel.length
      if (injRel.length) m.injectCasesHit++
      else if (o.pointers.some((id) => rel.has(id))) m.injectCasesDemoted++
    } else {
      m.pointerCases++
      if (injRel.length) m.pointerCasesInjected++
      else if (o.pointers.some((id) => rel.has(id))) m.pointerCasesPointer++
    }
  }
  return m
}
