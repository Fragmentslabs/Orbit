/**
 * Harness do benchmark de recuperação: tipos da fixture, métricas e avaliação.
 * Puro (sem ONNX): recebe vetores já calculados, então roda em teste com um
 * embedder de brinquedo e no CLI com o Bekko de verdade.
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
   * `dev` = ajuste; `eval` = avaliação da fixture principal; `blocked` =
   * conjunto novo, criado depois do desenho fechado e nunca usado para
   * escolher parâmetro (ver policy.ts).
   */
  split: 'dev' | 'eval' | 'blocked'
  lang: string
  qtype: string
  text: string
  relevant: string[]
  expect: Expect
  reason: string
  /** Só em diálogos */
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
 * Representação indexada. "old" = o que a medição anterior embutia (texto +
 * linha de tags); "det" = enriquecimento só determinístico (sem LLM);
 * "full" = com título/entidades/conceitos que o LLM gravador preencheria.
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
// Métricas
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

/** AUC: P(cosseno da memória certa de uma consulta > maior cosseno de uma consulta negativa). */
export function auc(pos: number[], neg: number[]): number {
  if (!pos.length || !neg.length) return NaN
  let s = 0
  for (const p of pos) for (const n of neg) s += p > n ? 1 : p === n ? 0.5 : 0
  return s / (pos.length * neg.length)
}

/** Intervalo de Wilson 95% para uma proporção. */
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
// Avaliação
// ---------------------------------------------------------------------------

export interface VectorStore {
  vectors: Map<string, Float32Array>
  lexical: Bm25Index
}

export interface QueryInput {
  case: BenchCase
  vec: Float32Array | null
  /** Texto usado na busca lexical */
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
  /** Consultas que precisam de memória */
  positives: number
  /** Consultas sem necessidade de memória */
  negatives: number
  /** Memórias relevantes (de consultas expect=inject) injetadas / total relevante */
  relevantInjected: number
  relevantTotal: number
  /** Consultas expect=inject em que ao menos uma relevante foi injetada */
  injectCasesHit: number
  injectCases: number
  /** Consultas expect=pointer: ponteiro útil / injeção (aceitável) / nada */
  pointerCasesPointer: number
  pointerCasesInjected: number
  pointerCases: number
  /** Relevantes de expect=inject que ficaram só como ponteiro */
  injectCasesDemoted: number
  /** Memórias injetadas que NÃO são relevantes (qualquer consulta) */
  falsePositives: number
  injectedTotal: number
  /** Consultas expect=none com qualquer injeção / com qualquer ponteiro */
  negWithInjection: number
  negWithPointer: number
  negClean: number
  /** Ponteiros não relevantes entre os emitidos em consultas positivas */
  junkPointers: number
  /** Totais de tokens estimados (chars/4) do que seria injetado */
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
