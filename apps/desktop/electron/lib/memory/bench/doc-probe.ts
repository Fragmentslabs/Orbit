/**
 * Query set shared by the document measurements.
 *
 * It exists so the lexical gain (doc-index.test.ts) and the vector gain
 * (doc-vectors.test.ts) are measured on the SAME queries — numbers from
 * different experiments are not comparable.
 *
 * NOTHING here prints text: the content only circulates in memory.
 */
import { tokenize, type Memory } from '@shared/memory'

export interface Query {
  text: string
  target: string
}

export interface Metrics {
  n: number
  r1: number
  r5: number
  mrr: number
}

const LONG_TOKEN = 4

function longTokens(text: string): string[] {
  return tokenize(text).filter((t) => t.length >= LONG_TOKEN)
}

export function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => s.length >= 40 && s.length <= 220)
}

/**
 * Sentence from the document that barely shares any term with the memory text
 * (at most 25%). Deterministic: it takes the middle one among the eligible, so it does not
 * always bias towards the first line of the `.md`.
 */
export function docQuery(doc: string, memoryText: string): string | null {
  const own = new Set(longTokens(memoryText))
  const eligible = sentences(doc).filter((s) => {
    const tokens = [...new Set(longTokens(s))]
    if (tokens.length < 3) return false
    const shared = tokens.filter((t) => own.has(t)).length
    return shared / tokens.length <= 0.25
  })
  if (eligible.length === 0) return null
  return eligible[Math.floor(eligible.length / 2)]
}

/** Sentence from the memory text — the query that already worked before the change. */
export function textQuery(memory: Memory): string | null {
  const first = sentences(memory.text)[0]
  if (first) return first
  const plain = memory.text.replace(/\s+/g, ' ').trim()
  return plain.length >= 20 ? plain.slice(0, 160) : null
}

/** The two sets, built the same way in every experiment. */
export function buildProbes(
  pool: Memory[],
  docs: Map<string, string>,
): { doc: Query[]; text: Query[] } {
  const docQueries: Query[] = []
  const textQueries: Query[] = []
  for (const memory of pool) {
    const doc = docs.get(memory.id)
    if (doc) {
      const q = docQuery(doc, memory.text)
      if (q) docQueries.push({ text: q, target: memory.id })
    }
    const tq = textQuery(memory)
    if (tq) textQueries.push({ text: tq, target: memory.id })
  }
  return { doc: docQueries, text: textQueries }
}

export function measure(queries: Query[], run: (q: string) => string[]): Metrics {
  let r1 = 0
  let r5 = 0
  let mrr = 0
  for (const query of queries) {
    const ids = run(query.text)
    const at = ids.indexOf(query.target)
    if (at === 0) r1++
    if (at >= 0 && at < 5) {
      r5++
      mrr += 1 / (at + 1)
    }
  }
  const n = queries.length || 1
  return { n: queries.length, r1: r1 / n, r5: r5 / n, mrr: mrr / n }
}

export const pct = (v: number) => `${(v * 100).toFixed(1)}%`.padStart(6)

export function line(label: string, m: Metrics): string {
  return `  ${label.padEnd(26)} R@1 ${pct(m.r1)}   R@5 ${pct(m.r5)}   MRR ${m.mrr.toFixed(3)}`
}

export function delta(before: Metrics, after: Metrics): string {
  const d = (after.r1 - before.r1) * 100
  return `${d >= 0 ? '+' : ''}${d.toFixed(1)} pp em R@1`
}
