/**
 * Gain from indexing the attached document in the lexical search, measured on the real pool.
 *
 * It only runs with MEMORY_DOC_GAIN=1, because it depends on the user's memories.
 * NO memory or document text is printed: the output is counts and
 * percentages, computed over objects in memory. The content does not leave here.
 *
 * Two sets, with different purposes:
 *
 *  - `doc`  — queries taken from the `.md` itself, with almost no token in common with the
 *             memory text. Only the document can answer them: it measures the
 *             NEW capability, in isolation.
 *  - `text` — queries taken from the memory text. It measures REGRESSION: the
 *             document lengthens the lexical document, and BM25's length
 *             normalisation could push down what was already found.
 */
import { describe, expect, it } from 'vitest'
import { searchMemories, type SearchOptions } from '@shared/memory'
import { Bm25Index, lexicalDocOf } from '@shared/memory-retrieval'
import { readDocs, readMemories } from './local-corpus'
import { buildProbes, delta, line, measure } from './doc-probe'

const enabled = process.env.MEMORY_DOC_GAIN === '1'

describe.skipIf(!enabled)('document attached to the lexical index', () => {
  it(
    'measures the gain on the .md queries and the regression on the text queries',
    () => {
      const pool = readMemories()
      const docs = readDocs()
      const probes = buildProbes(pool, docs)
      const docQueries = probes.doc
      const textQueries = probes.text

      expect(pool.length).toBeGreaterThan(0)
      expect(docQueries.length).toBeGreaterThan(0)
      expect(textQueries.length).toBeGreaterThan(0)

      const lex = (options: SearchOptions = {}) => (q: string) =>
        searchMemories(pool, q, 10, options).map((m) => m.id)

      const lexBefore = measure(docQueries, lex(undefined))
      const lexWithDocs = measure(docQueries, lex({ docs }))
      const textBefore = measure(textQueries, lex(undefined))
      const textWithDocs = measure(textQueries, lex({ docs }))

      const bm25Before = new Bm25Index(pool.map((m) => lexicalDocOf(m)))
      const bm25WithDocs = new Bm25Index(pool.map((m) => lexicalDocOf(m, docs.get(m.id))))
      const bm25Ids = (index: Bm25Index) => (q: string) => index.search(q, 10).map((hit) => hit.id)
      const bm25DocBefore = measure(docQueries, bm25Ids(bm25Before))
      const bm25DocAfter = measure(docQueries, bm25Ids(bm25WithDocs))
      const bm25TextBefore = measure(textQueries, bm25Ids(bm25Before))
      const bm25TextAfter = measure(textQueries, bm25Ids(bm25WithDocs))

      const report = [
        '',
        `[doc-index] ${pool.length} memories · ${docs.size} documents · ${docQueries.length} document queries · ${textQueries.length} text queries`,
        '',
        'searchMemories (memory_search) — queries only the document answers',
        line('sem documento (hoje)', lexBefore),
        line('com documento', lexWithDocs),
        `  → ${delta(lexBefore, lexWithDocs)}`,
        '',
        'searchMemories — regression on the text queries',
        line('sem documento (hoje)', textBefore),
        line('com documento', textWithDocs),
        `  → ${delta(textBefore, textWithDocs)}`,
        '',
        'BM25 (injection/hybrid) — queries only the document answers',
        line('sem documento (hoje)', bm25DocBefore),
        line('com documento', bm25DocAfter),
        `  → ${delta(bm25DocBefore, bm25DocAfter)}`,
        '',
        'BM25 — regression on the text queries',
        line('sem documento (hoje)', bm25TextBefore),
        line('com documento', bm25TextAfter),
        `  → ${delta(bm25TextBefore, bm25TextAfter)}`,
        '',
        'calibration of the document token weight (searchMemories, document queries)',
        ...[0.6, 0.8, 0.9, 1].map((w) => line(`peso ${w.toFixed(1)}`, measure(docQueries, lex({ docs, docWeight: w })))),
        'calibration of the document token weight (regression on the text ones)',
        ...[0.6, 0.8, 0.9, 1].map((w) => line(`peso ${w.toFixed(1)}`, measure(textQueries, lex({ docs, docWeight: w })))),
        '',
      ]
      console.log(report.join('\n'))
    },
    300_000,
  )
})
