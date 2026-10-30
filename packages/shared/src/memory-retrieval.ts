/**
 * Memory retrieval: pure parts (no I/O, no Electron) shared
 * between the main, the renderer and the benchmark.
 *
 *  - index text enriched per memory (`buildRetrievalText`)
 *  - BM25 lexical search over fields, with Unicode tokenization independent of
 *    language (no stopwords or stemming for a single language: the IDF already lowers what
 *    appears everywhere)
 *  - fusion of rankings by Reciprocal Rank Fusion
 *
 * The semantic search (embeddings) lives in the main; here there are only the functions that
 * do not depend on the model.
 */

import type { Memory } from "./memory"

// ---------------------------------------------------------------------------
// Text and tokens
// ---------------------------------------------------------------------------

/**
 * Lowercase + NFKC + no diacritics, but only in alphabets that do without them
 * (Latin, Cyrillic, Greek): stripping marks from kana (dakuten) or from Devanagari
 * changes the word.
 */
export function foldText(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .normalize("NFD")
    .replace(/(?<=[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}])\p{M}+/gu, "")
    .normalize("NFC")
}

/** Scripts without spaces between words: they become character bigrams. */
const UNSEGMENTED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]+/gu
const WORD = /[\p{L}\p{N}\p{M}]+(?:[-_./][\p{L}\p{N}\p{M}]+)*/gu

/**
 * Search tokens. Identifiers with a number ("ATL-2291", "v2.3.1", "SF-88213")
 * enter whole AND split; text without spaces (Japanese, Chinese, Thai…)
 * enters as bigrams.
 */
export function lexTokens(text: string): string[] {
  const out: string[] = []
  const folded = foldText(text)
  for (const match of folded.matchAll(WORD)) {
    const word = match[0]
    const parts = word.split(/[-_./]/)
    if (parts.length > 1 && /\p{N}/u.test(word)) out.push(word)
    for (const part of parts) pushPart(part, out)
  }
  return out
}

function pushPart(part: string, out: string[]) {
  let last = 0
  for (const m of part.matchAll(UNSEGMENTED)) {
    const before = part.slice(last, m.index)
    if (before.length >= 2 || /\p{N}/u.test(before)) out.push(before)
    const run = [...m[0]]
    if (run.length === 1) out.push(run[0])
    for (let i = 0; i < run.length - 1; i++) out.push(run[i] + run[i + 1])
    last = (m.index ?? 0) + m[0].length
  }
  const rest = part.slice(last)
  if (rest.length >= 2 || (rest.length === 1 && /\p{N}/u.test(rest))) out.push(rest)
}

// ---------------------------------------------------------------------------
// Fields derived from the memory (enrichment)
// ---------------------------------------------------------------------------

/**
 * Version of the index text schema. Raising this number invalidates the vectors
 * of all memories (the indexer reprocesses in the background).
 */
export const INDEX_SCHEMA_VERSION = 1

/** Ceiling of the index text — keeps the embedding and index cost under control. */
export const RETRIEVAL_TEXT_MAX_CHARS = 700

type IndexSource = Pick<Memory, "text" | "tags"> &
  Partial<Pick<Memory, "title" | "summary" | "entities" | "keywords" | "concepts">>

const clean = (s: string) => s.replace(/\s+/g, " ").trim()

/** Short title. The LLM one has priority; without it, the first sentence of the text. */
export function deriveTitle(memory: IndexSource): string {
  if (memory.title?.trim()) return clean(memory.title)
  const first = clean(memory.text)
    .split(/(?<=[.!?。！？])\s|\n/)[0]
    ?.replace(/[.!?。！？]+$/, "") ?? ""
  return first.length > 80 ? `${first.slice(0, 77).trimEnd()}…` : first
}

/**
 * Entities. The ones from the LLM take precedence; without them, a conservative heuristic with no
 * specific language: identifiers with a digit/hyphen/dot and sequences of
 * Capitalized words outside the start of a sentence. It invents nothing: it only returns
 * snippets that are already in the text.
 */
export function deriveEntities(memory: IndexSource): string[] {
  if (memory.entities?.length) return unique(memory.entities.map(clean).filter(Boolean)).slice(0, 12)
  const found: string[] = []
  const text = memory.text
  for (const m of text.matchAll(/\b[\p{L}\p{N}]+(?:[-_./][\p{L}\p{N}]+)+\b/gu)) {
    if (/\p{N}/u.test(m[0])) found.push(m[0])
  }
  const sentenceStart = /(^|[.!?。！？]\s+|\n)$/
  for (const m of text.matchAll(/\p{Lu}[\p{L}\p{N}]*(?:\s+\p{Lu}[\p{L}\p{N}]*)*/gu)) {
    const before = text.slice(0, m.index ?? 0)
    if (sentenceStart.test(before) && !m[0].includes(" ")) continue
    if (m[0].length >= 3) found.push(m[0])
  }
  return unique(found).slice(0, 12)
}

/** Keywords: the LLM ones, plus the tags. */
export function deriveKeywords(memory: IndexSource): string[] {
  return unique([...(memory.keywords ?? []), ...memory.tags].map(clean).filter(Boolean)).slice(0, 16)
}

function unique(items: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of items) {
    const key = foldText(item)
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(item)
  }
  return out
}

/**
 * Consolidated representation for the embedding: title, original content,
 * entities, keywords and concepts. Language labels are left out on
 * purpose (a memory can be in any language); what is not in the
 * memory does not go in. The original content is always preserved in full and the
 * extras are cut first when the ceiling is exceeded.
 */
export function buildRetrievalText(memory: IndexSource, options: { extras?: boolean } = {}): string {
  const text = clean(memory.text)
  if (options.extras === false) return text
  const title = deriveTitle(memory)
  // The suffix cut has to come BEFORE folding: foldText goes through NFKC, and
  // NFKC turns "…" into "...". Comparing afterwards, the derived title (which
  // ends in "…") was never recognized as part of the text.
  const head = title && foldText(text).includes(foldText(title.replace(/…$/, ""))) ? "" : title
  const extras: string[] = []
  const seen = new Set(lexTokens(`${head} ${text}`))
  const novel = (items: string[]) => items.filter((item) => lexTokens(item).some((t) => !seen.has(t)))
  for (const group of [novel(deriveEntities(memory)), novel(deriveKeywords(memory)), novel(memory.concepts ?? [])]) {
    if (group.length === 0) continue
    extras.push(group.join(", "))
    for (const item of group) for (const t of lexTokens(item)) seen.add(t)
  }
  const parts = [memory.summary && memory.summary !== memory.text ? clean(memory.summary) : "", ...extras]
  // The text is the content and ALWAYS enters in full. The ceiling exists so the
  // enrichment does not dilute the vector, never to cut the fact: before, a
  // title that did not fit along with the text made the index store only the title.
  let out = head ? `${head}. ${text}` : text
  for (const part of parts) {
    if (!part) continue
    const next = `${out}. ${part}`
    if (next.length > RETRIEVAL_TEXT_MAX_CHARS) break
    out = next
  }
  return out
}

/** FNV-1a hash (53 bits) — cheap, stable, enough to invalidate vectors. */
export function hashString(input: string): string {
  let h1 = 0xdeadbeef ^ 0
  let h2 = 0x41c6ce57 ^ 0
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)
}

/**
 * Signature of what feeds a memory's vector. Content, enrichment fields,
 * schema, model or dimensions changed ⇒ the signature changes ⇒ the vector is
 * eligible for reindexing.
 */
export function indexSignature(memory: IndexSource, model: { id: string; dim: number }): string {
  return hashString(`${INDEX_SCHEMA_VERSION}|${model.id}|${model.dim}|${buildRetrievalText(memory)}`)
}

// ---------------------------------------------------------------------------
// BM25 over fields
// ---------------------------------------------------------------------------

export interface LexicalDoc {
  id: string
  /** Original content + title (base weight) */
  text: string
  /** Tags, keywords and entities (weigh more) */
  boosted?: string
  /** Concepts and paraphrases (base weight) */
  concepts?: string
  /** Attached markdown document (base weight; it is what makes the .md findable) */
  body?: string
}

export interface Bm25Options {
  k1?: number
  b?: number
  /** Weight of each field in the term frequency */
  weights?: { text?: number; boosted?: number; concepts?: number; body?: number }
}

export interface ScoredId {
  id: string
  score: number
}

/**
 * Lexical document of a memory: the same cut for the index and for the
 * tests. `doc` is the attached markdown, when it exists — without it the document is
 * identical to the previous one.
 */
export function lexicalDocOf(memory: Memory & Partial<IndexSource>, doc?: string | null): LexicalDoc {
  return {
    id: memory.id,
    text: `${deriveTitle(memory)} ${memory.text}`,
    boosted: [...deriveKeywords(memory), ...deriveEntities(memory)].join(" "),
    concepts: (memory.concepts ?? []).join(" "),
    body: doc ? clean(doc) : undefined,
  }
}

export class Bm25Index {
  private readonly k1: number
  private readonly b: number
  private readonly postings = new Map<string, Array<[number, number]>>()
  private readonly lengths: number[] = []
  private readonly ids: string[] = []
  private avgLen = 0

  constructor(docs: LexicalDoc[], options: Bm25Options = {}) {
    this.k1 = options.k1 ?? 1.2
    this.b = options.b ?? 0.75
    const w = { text: 1, boosted: 2, concepts: 1, body: 1, ...options.weights }
    let total = 0
    docs.forEach((doc, index) => {
      const tf = new Map<string, number>()
      const add = (text: string | undefined, weight: number) => {
        if (!text) return
        for (const t of lexTokens(text)) tf.set(t, (tf.get(t) ?? 0) + weight)
      }
      add(doc.text, w.text)
      add(doc.boosted, w.boosted)
      add(doc.concepts, w.concepts)
      add(doc.body, w.body)
      let len = 0
      for (const [token, freq] of tf) {
        len += freq
        const list = this.postings.get(token)
        if (list) list.push([index, freq])
        else this.postings.set(token, [[index, freq]])
      }
      this.ids.push(doc.id)
      this.lengths.push(len)
      total += len
    })
    this.avgLen = docs.length ? total / docs.length : 0
  }

  get size(): number {
    return this.ids.length
  }

  /**
   * IDF mass of the query (unknown terms count as the rarest ones):
   * the denominator of the "coverage" — how much of what was asked the document has.
   */
  queryMass(query: string): number {
    const n = this.ids.length
    let mass = 0
    for (const token of new Set(lexTokens(query))) {
      const df = this.postings.get(token)?.length ?? 0
      mass += Math.log(1 + (n - df + 0.5) / (df + 0.5))
    }
    return mass
  }

  search(query: string, limit = 20): ScoredId[] {
    const n = this.ids.length
    if (n === 0) return []
    const scores = new Map<number, number>()
    for (const token of new Set(lexTokens(query))) {
      const list = this.postings.get(token)
      if (!list) continue
      const idf = Math.log(1 + (n - list.length + 0.5) / (list.length + 0.5))
      for (const [doc, freq] of list) {
        const norm = 1 - this.b + (this.b * this.lengths[doc]) / (this.avgLen || 1)
        const s = (idf * freq * (this.k1 + 1)) / (freq + this.k1 * norm)
        scores.set(doc, (scores.get(doc) ?? 0) + s)
      }
    }
    return [...scores]
      .map(([doc, score]) => ({ id: this.ids[doc], score }))
      .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1))
      .slice(0, limit)
  }
}

// ---------------------------------------------------------------------------
// Fusion
// ---------------------------------------------------------------------------

export interface RankedList {
  ids: string[]
  weight?: number
}

/**
 * Reciprocal Rank Fusion: score(id) = Σ weight / (k + position). It operates only on
 * positions, so it does not mix the cosine scale with the BM25 one — which are not
 * comparable. k=60 is the classic value (Cormack et al., 2009).
 */
export function reciprocalRankFusion(lists: RankedList[], k = 60): ScoredId[] {
  const scores = new Map<string, number>()
  for (const list of lists) {
    const weight = list.weight ?? 1
    list.ids.forEach((id, position) => {
      scores.set(id, (scores.get(id) ?? 0) + weight / (k + position + 1))
    })
  }
  return [...scores]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1))
}

// ---------------------------------------------------------------------------
// Vectors
// ---------------------------------------------------------------------------

export function dot(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let s = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) s += a[i] * b[i]
  return s
}
