/**
 * Selection of memories for the context: candidates (semantic + lexical + fusion)
 * and the two-level policy. Pure functions — the same code runs in the app and in the
 * benchmark (electron/lib/memory/bench), so what is measured is what is delivered.
 */

import { Bm25Index, dot, lexTokens, reciprocalRankFusion } from "./memory-retrieval"

// ---------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------

export type RetrievalMode = "semantic" | "lexical" | "hybrid"

export interface RetrievalParams {
  mode: RetrievalMode
  /** How many candidates each source delivers to the fusion */
  semK: number
  lexK: number
  /** RRF constant k */
  rrfK: number
  /** Weights of each list in the RRF */
  semWeight: number
  lexWeight: number
  /**
   * Minimum coverage (fraction of the IDF of the query) for a lexical hit to enter
   * the fusion. At 0, any document with a token in common enters — which in a
   * large collection is noise: "de", "para" and a city name match dozens of
   * memories. Whoever decides the number is the calibration (bench/analysis.ts).
   */
  lexMinCoverage: number
}

export const DEFAULT_RETRIEVAL: RetrievalParams = {
  mode: "hybrid",
  semK: 20,
  lexK: 20,
  rrfK: 60,
  semWeight: 1,
  lexWeight: 1,
  lexMinCoverage: 0,
}

/**
 * Production fusion — the SAME constant the bench uses (bench/policy.ts
 * re-exports it from here), so that what is measured and what is delivered are the same
 * number. Small lexical weight and coverage cut: with equal weight the RRF
 * loses ~30 pp of R@1 (measured); with the cut, it ties with the semantic one and keeps
 * the exact identifier at the top, which is what BM25 does best.
 */
export const PRODUCTION_RETRIEVAL: RetrievalParams = {
  ...DEFAULT_RETRIEVAL,
  semWeight: 1,
  lexWeight: 0.1,
  lexMinCoverage: 0.5,
}

export interface Candidate {
  id: string
  /** Cosine with the query (null when there is no vector or in lexical mode) */
  cos: number | null
  semRank: number | null
  /** BM25 and fraction of the IDF of the query that the document covers (0..1) */
  bm25: number
  coverage: number
  lexRank: number | null
  /** Fusion score (RRF) — only to order; the decision uses the raw signals */
  fused: number
}

export interface RetrievalInput {
  /** Embedding of the query; null/undefined ⇒ lexical only */
  queryVec?: ArrayLike<number> | null
  /** Original text of the query (lexical search) */
  lexicalQuery: string
  vectors: ReadonlyMap<string, ArrayLike<number>>
  lexical: Bm25Index
}

export function retrieveCandidates(input: RetrievalInput, params: RetrievalParams = DEFAULT_RETRIEVAL): Candidate[] {
  const useSem = params.mode !== "lexical" && input.queryVec != null
  const useLex = params.mode !== "semantic" || !useSem

  const cosById = new Map<string, number>()
  let semOrder: string[] = []
  if (useSem) {
    const scored: Array<[string, number]> = []
    for (const [id, vec] of input.vectors) scored.push([id, dot(input.queryVec!, vec)])
    scored.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    for (const [id, cos] of scored) cosById.set(id, cos)
    semOrder = scored.slice(0, params.semK).map(([id]) => id)
  }

  const qIdf = useLex ? queryIdfMass(input.lexical, input.lexicalQuery) : 0
  const rawLex = useLex ? input.lexical.search(input.lexicalQuery, Math.max(params.lexK, 50)) : []
  // The coverage is how much of the IDF of the query the document covers; the cut removes the
  // single-token hit before it disputes position in the fusion.
  const lexHits =
    params.lexMinCoverage > 0 && qIdf > 0
      ? rawLex.filter((hit) => hit.score / qIdf >= params.lexMinCoverage)
      : rawLex
  const lexById = new Map(lexHits.map((hit, i) => [hit.id, { ...hit, rank: i }]))
  const lexOrder = lexHits.slice(0, params.lexK).map((h) => h.id)

  const lists = []
  if (useSem) lists.push({ ids: semOrder, weight: params.semWeight })
  if (useLex) lists.push({ ids: lexOrder, weight: params.lexWeight })
  const fused = reciprocalRankFusion(lists, params.rrfK)

  return fused.map(({ id, score }) => {
    const lex = lexById.get(id)
    const semRank = semOrder.indexOf(id)
    return {
      id,
      cos: cosById.has(id) ? cosById.get(id)! : null,
      semRank: semRank >= 0 ? semRank : null,
      bm25: lex?.score ?? 0,
      coverage: lex && qIdf > 0 ? Math.min(1, lex.score / qIdf) : 0,
      lexRank: lex ? lex.rank : null,
      fused: score,
    }
  })
}

/** Approximate ceiling of the BM25 for the query (all terms matching): normalizes the coverage. */
function queryIdfMass(index: Bm25Index, query: string): number {
  return index.queryMass(query)
}

// ---------------------------------------------------------------------------
// Noise floor per collection
// ---------------------------------------------------------------------------

/**
 * Generic questions, unrelated to anyone's life. Run against the
 * user's collection, they show how far the cosine gets "by chance" in that
 * set of memories — which varies with the size, the language and the tone of the collection.
 * None of them appears in the benchmark (cases.json); the set was written
 * separately so the calibration does not see the evaluation cases.
 */
export const NOISE_PROBES: string[] = [
  "Qual é a capital da Austrália?",
  "Quanto é 45 dividido por 9?",
  "Explique a diferença entre vírus e bactéria.",
  "Escreva um poema curto sobre a chuva.",
  "Como faço para ordenar uma lista em Python?",
  "Quem pintou a Mona Lisa?",
  "Traduza 'obrigado' para o italiano.",
  "O que causa as marés?",
  "Resuma a história do Império Romano em poucas linhas.",
  "Qual a diferença entre TCP e UDP?",
  "What is the tallest mountain in the world?",
  "Explain how photosynthesis works.",
  "Write a limerick about a cat.",
  "How many ounces are in a pound?",
  "What is the difference between a list and a tuple in Python?",
  "Who wrote Pride and Prejudice?",
  "Give me three tips to write a clear email.",
  "Why is the sky blue?",
  "What does HTTP status 404 mean?",
  "Summarize the plot of Romeo and Juliet.",
  "¿Cuántos planetas tiene el sistema solar?",
  "Escribe una función que invierta una cadena.",
  "¿Qué es la inflación?",
  "¿Quién descubrió América?",
  "日本で一番長い川は?",
  "光合成とは何ですか?",
  "Кто написал «Войну и мир»?",
  "Объясни, что такое простое число.",
  "Wie funktioniert ein Elektromotor?",
  "Quelle est la formule de l'eau ?",
  "Bom dia, tudo certo?",
  "Thanks a lot!",
  "Can you rephrase this sentence to sound more formal?",
  "Corrija a ortografia deste texto, por favor.",
  "What is a good name for a bakery?",
  "Me dê uma ideia de nome para um aplicativo de receitas.",
]

export interface NoiseFloor {
  /** Highest cosine of each probe against the collection, in ascending order */
  tops: number[]
}

export function noiseFloorOf(
  probeVecs: ArrayLike<number>[],
  vectors: ReadonlyMap<string, ArrayLike<number>>,
): NoiseFloor {
  const tops = probeVecs.map((p) => {
    let best = -1
    for (const vec of vectors.values()) best = Math.max(best, dot(p, vec))
    return best
  })
  return { tops: tops.sort((a, b) => a - b) }
}

export function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0
  const pos = Math.min(sorted.length - 1, Math.max(0, q * (sorted.length - 1)))
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo)
}

// ---------------------------------------------------------------------------
// Two-level policy
// ---------------------------------------------------------------------------

export interface SelectionParams {
  /**
   * How the cosine threshold is obtained:
   *  - "absolute": `injectCos` / `pointerCos` are worth as they are
   *  - "collection": noise floor of the collection (quantile of the probes) + `injectDelta` / `pointerDelta`
   */
  threshold: "absolute" | "collection"
  injectCos: number
  pointerCos: number
  noiseQuantile: number
  injectDelta: number
  pointerDelta: number
  /** Minimum distance between the 1st and the 2nd candidate to inject by cosine alone (0 = ignores it) */
  minMargin: number
  /** Lexical coverage that, added to a pointer cosine, is enough to inject (>1 = off) */
  lexInjectCoverage: number
  /** Lexical coverage that alone (without a high cosine) is enough for a pointer */
  lexPointerCoverage: number
  maxInject: number
  maxPointers: number
  /** Beyond the 1st, only candidates up to `gap` of cosine from the 1st enter */
  gap: number
  /** Character ceiling of an injected memory (the rest stays behind memory_open) */
  maxInjectChars: number
}

export const DEFAULT_SELECTION: SelectionParams = {
  threshold: "collection",
  injectCos: 0.6,
  pointerCos: 0.5,
  noiseQuantile: 1,
  injectDelta: 0.05,
  pointerDelta: 0,
  minMargin: 0,
  lexInjectCoverage: 2,
  lexPointerCoverage: 2,
  maxInject: 3,
  maxPointers: 2,
  gap: 0.08,
  maxInjectChars: 600,
}

export type Tier = "inject" | "pointer"

export interface Selected extends Candidate {
  tier: Tier
}

export interface Selection {
  inject: Selected[]
  pointers: Selected[]
  /** Thresholds effectively used (for debugging and for the reports) */
  thresholds: { inject: number; pointer: number }
}

export function selectForContext(
  candidates: Candidate[],
  noise: NoiseFloor | undefined,
  params: SelectionParams = DEFAULT_SELECTION,
): Selection {
  let injectT = params.injectCos
  let pointerT = params.pointerCos
  if (params.threshold === "collection" && noise && noise.tops.length > 0) {
    const floor = quantile(noise.tops, params.noiseQuantile)
    injectT = floor + params.injectDelta
    pointerT = floor + params.pointerDelta
  }

  const bySem = candidates.filter((c) => c.cos != null).sort((a, b) => b.cos! - a.cos!)
  const top = bySem[0]
  const second = bySem[1]
  const margin = top && second ? top.cos! - second.cos! : top ? 1 : 0

  // A tie at the top is a sign of ambiguity, not of relevance: if the 1st is not
  // clearly ahead of the 2nd, neither deserves automatic injection — both
  // become a pointer. Without `minMargin` (0), the criterion is off.
  const ambiguous = params.minMargin > 0 && top != null && second != null && margin < params.minMargin

  const inject: Selected[] = []
  const pointers: Selected[] = []
  const used = new Set<string>()

  // Candidates in order of cosine (the ones without a vector, lexical only, come later).
  const ordered = [...bySem, ...candidates.filter((c) => c.cos == null)]
  for (const c of ordered) {
    if (used.has(c.id)) continue
    const nearTop = !top || c.cos == null || top.cos! - c.cos <= params.gap
    const cos = c.cos ?? -1
    const strongCos = cos >= injectT && !ambiguous
    const lexBoost = cos >= pointerT && c.coverage >= params.lexInjectCoverage
    if ((strongCos || lexBoost) && nearTop && inject.length < params.maxInject) {
      inject.push({ ...c, tier: "inject" })
      used.add(c.id)
      continue
    }
    const plausible = cos >= pointerT || c.coverage >= params.lexPointerCoverage
    if (plausible && pointers.length < params.maxPointers) {
      pointers.push({ ...c, tier: "pointer" })
      used.add(c.id)
    }
  }
  return { inject, pointers, thresholds: { inject: injectT, pointer: pointerT } }
}

/** How many lexical tokens the query has (to decide whether the lexical search is worth it). */
export function queryTokenCount(query: string): number {
  return lexTokens(query).length
}
