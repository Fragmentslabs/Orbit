/**
 * Ganho de indexar o documento anexado na busca lexical, medido no acervo real.
 *
 * Roda só com MEMORY_DOC_GAIN=1, porque depende das memórias do usuário.
 * NENHUM texto de memória ou de documento é impresso: a saída são contagens e
 * percentuais, calculados sobre objetos em memória. O conteúdo não sai daqui.
 *
 * Dois conjuntos, com propósitos diferentes:
 *
 *  - `doc`  — consultas tiradas do próprio `.md`, quase sem token em comum com o
 *             texto da memória. Só o documento pode respondê-las: mede a
 *             capacidade NOVA, isolada.
 *  - `text` — consultas tiradas do texto da memória. Mede REGRESSÃO: o
 *             documento alonga o documento lexical, e a normalização de tamanho
 *             do BM25 poderia empurrar para baixo o que já era achado.
 */
import { describe, expect, it } from 'vitest'
import { searchMemories, type SearchOptions } from '@shared/memory'
import { Bm25Index, lexicalDocOf } from '@shared/memory-retrieval'
import { readDocs, readMemories } from './local-corpus'
import { buildProbes, delta, line, measure } from './doc-probe'

const enabled = process.env.MEMORY_DOC_GAIN === '1'

describe.skipIf(!enabled)('documento anexado no índice lexical', () => {
  it(
    'mede ganho nas consultas do .md e regressão nas consultas de texto',
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
        `[doc-index] ${pool.length} memórias · ${docs.size} documentos · ${docQueries.length} consultas de doc · ${textQueries.length} de texto`,
        '',
        'searchMemories (memory_search) — consultas que só o documento responde',
        line('sem documento (hoje)', lexBefore),
        line('com documento', lexWithDocs),
        `  → ${delta(lexBefore, lexWithDocs)}`,
        '',
        'searchMemories — regressão nas consultas de texto',
        line('sem documento (hoje)', textBefore),
        line('com documento', textWithDocs),
        `  → ${delta(textBefore, textWithDocs)}`,
        '',
        'BM25 (injeção/híbrido) — consultas que só o documento responde',
        line('sem documento (hoje)', bm25DocBefore),
        line('com documento', bm25DocAfter),
        `  → ${delta(bm25DocBefore, bm25DocAfter)}`,
        '',
        'BM25 — regressão nas consultas de texto',
        line('sem documento (hoje)', bm25TextBefore),
        line('com documento', bm25TextAfter),
        `  → ${delta(bm25TextBefore, bm25TextAfter)}`,
        '',
        'calibração do peso do token do documento (searchMemories, consultas de doc)',
        ...[0.6, 0.8, 0.9, 1].map((w) => line(`peso ${w.toFixed(1)}`, measure(docQueries, lex({ docs, docWeight: w })))),
        'calibração do peso do token do documento (regressão nas de texto)',
        ...[0.6, 0.8, 0.9, 1].map((w) => line(`peso ${w.toFixed(1)}`, measure(textQueries, lex({ docs, docWeight: w })))),
        '',
      ]
      console.log(report.join('\n'))
    },
    300_000,
  )
})
