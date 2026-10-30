/**
 * Lexical search over the tool catalog — BM25 with a coverage gate.
 *
 * Why BM25 before embedding: the tool vocabulary is short and full of
 * identifiers (`pdf_extract_images`), exactly the case where lexical
 * wins. Embedding only if you measure the loss — and measuring requires the outcome
 * telemetry (see `load.ts`).
 */

export interface SearchRecord {
  name: string
  /** Name + description + argument names, already in plain text. */
  text: string
}

export interface SearchResult {
  name: string
  score: number
}

const K1 = 1.5
const B = 0.75
/** ≥ 50% of the query terms present. */
const MIN_COVERAGE = 0.5
/** Coverage is only required from 4 terms on — otherwise a lone "pdf" is dropped. */
const TERMS_REQUIRING_COVERAGE = 4
export const MAX_QUERIES_PER_CALL = 7

/**
 * Tokenizes in a stable way: lowercase, without accents, and `_` preserved because
 * `pdf_extract_images` is ONE identifier, not three words.
 */
export function termsOf(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z0-9_]+/)
    .filter((t) => t.length >= 2)
}

/** Classic BM25 over an already tokenized list of document terms. */
function bm25(
  query: string[],
  doc: string[],
  df: ReadonlyMap<string, number>,
  totalDocs: number,
  averageLength: number,
): number {
  if (doc.length === 0 || averageLength === 0) return 0
  const frequencies = new Map<string, number>()
  for (const term of doc) frequencies.set(term, (frequencies.get(term) ?? 0) + 1)
  let score = 0
  for (const term of query) {
    const tf = frequencies.get(term) ?? 0
    if (tf === 0) continue
    const n = df.get(term) ?? 0
    const idf = Math.log(1 + (totalDocs - n + 0.5) / (n + 0.5))
    const denominator = tf + K1 * (1 - B + (B * doc.length) / averageLength)
    score += idf * ((tf * (K1 + 1)) / denominator)
  }
  return score
}

/**
 * Searches several queries at once (up to 7, like Hermes — the limit comes from the
 * cost of a call with many queries, measured there).
 *
 * Rules:
 * - **Exact name first.** Searching `pdf_extract_images` cannot return
 *   eight neighbors with a similar score; the exact match goes to the top.
 * - The **coverage gate** reduces false positives on a long query.
 */
export function search(
  records: readonly SearchRecord[],
  queries: readonly string[],
  limit = 5,
): SearchResult[] {
  if (records.length === 0) return []
  const docs = records.map((record) => ({ record, tokens: termsOf(record.text) }))
  const totalDocs = docs.length
  const df = new Map<string, number>()
  for (const doc of docs) {
    for (const term of new Set(doc.tokens)) df.set(term, (df.get(term) ?? 0) + 1)
  }
  const averageLength = docs.reduce((sum, doc) => sum + doc.tokens.length, 0) / totalDocs
  const best = new Map<string, number>()

  for (const query of queries.slice(0, MAX_QUERIES_PER_CALL)) {
    const terms = termsOf(query)
    if (terms.length === 0) continue
    for (const doc of docs) {
      const present = new Set(doc.tokens)
      const covered = terms.filter((t) => present.has(t)).length
      if (
        terms.length >= TERMS_REQUIRING_COVERAGE &&
        covered / terms.length < MIN_COVERAGE
      ) {
        continue
      }
      const score = bm25(terms, doc.tokens, df, totalDocs, averageLength)
      if (score > 0) best.set(doc.record.name, Math.max(best.get(doc.record.name) ?? 0, score))
    }
  }

  const exact = new Set(queries.map((q) => q.trim().toLowerCase()))
  return [...best.entries()]
    .map(([name, score]) => ({ name, score }))
    .sort(
      (a, b) =>
        Number(exact.has(b.name.toLowerCase())) - Number(exact.has(a.name.toLowerCase())) ||
        b.score - a.score ||
        a.name.localeCompare(b.name),
    )
    .slice(0, Math.max(1, Math.min(50, Math.floor(limit))))
}
