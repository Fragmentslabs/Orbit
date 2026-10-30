/**
 * The attached documents as seen by the VECTOR: how much the semantic index gains by
 * seeing what is inside the `.md`, and whether chunking pays off.
 *
 *   MEMORY_DOC_VECTORS=1 npx vitest run electron/lib/memory/bench/doc-vectors.test.ts
 *
 * PRIVACY: no text is printed — only counts, percentages and timings. The
 * embedding runs on the local model (onnxruntime), no content leaves the machine.
 *
 * Four representations, compared on the SAME queries from doc-probe.ts:
 *
 *   text      — what production has today (only `buildRetrievalText`)
 *   single doc — the whole document in a single vector
 *   chunks     — N vectors per document, the best cosine wins
 *   hybrid     — RRF between the lexical index (which already sees the document) and the chunks
 */
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createEmbedder } from '../../../memory-embed/engine.mjs'
import { loadTokenizer } from '../../../memory-embed/tokenizer.mjs'
import { buildRetrievalText } from '@shared/memory-retrieval'
import { searchMemories } from '@shared/memory'
import { readDocs, readMemories } from './local-corpus'
import { buildProbes, delta, line, measure } from './doc-probe'

const enabled = process.env.MEMORY_DOC_VECTORS === '1'
const MODEL = path.resolve(__dirname, '../../../../.cache/memory-embed/bekko-a8m')

/** Same character ceiling used in `buildRetrievalText`, for consistency. */
const CHUNK_CHARS = 700
/** Model window: anything beyond it is silently discarded. */
const MAX_TOKENS = 512

/**
 * Splits the document into chunks of up to `size` characters, respecting sentence
 * and paragraph ends. A single paragraph larger than the ceiling becomes one large
 * chunk — it is measured, not hidden.
 */
function chunkDoc(doc: string, size = CHUNK_CHARS): string[] {
  const parts = doc
    .split(/\n{2,}|(?<=[.!?])\s+/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
  const out: string[] = []
  let cur = ''
  for (const part of parts) {
    const next = cur ? `${cur} ${part}` : part
    if (cur && next.length > size) {
      out.push(cur)
      cur = part
    } else {
      cur = next
    }
  }
  if (cur) out.push(cur)
  return out
}

function cos(a: Float32Array, b: Float32Array): number {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s
}

/** Ids ordered by each memory's best cosine (the best chunk wins). */
function rank(
  query: Float32Array,
  ids: string[],
  vectorsOf: (id: string) => Float32Array[],
  limit = 10,
): string[] {
  const scored = ids.map((id) => {
    let best = -Infinity
    for (const v of vectorsOf(id)) {
      const s = cos(query, v)
      if (s > best) best = s
    }
    return { id, s: best }
  })
  scored.sort((a, b) => b.s - a.s)
  return scored.slice(0, limit).map((x) => x.id)
}

/** Reciprocal Rank Fusion, as in memory-select. */
function rrf(a: string[], b: string[], k = 60): string[] {
  const score = new Map<string, number>()
  a.forEach((id, i) => score.set(id, (score.get(id) ?? 0) + 1 / (k + i + 1)))
  b.forEach((id, i) => score.set(id, (score.get(id) ?? 0) + 1 / (k + i + 1)))
  return [...score].sort((x, y) => y[1] - x[1]).map(([id]) => id)
}

const quantile = (values: number[], q: number): number => {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]
}

describe.skipIf(!enabled)('documento anexado visto pelo vetor', () => {
  it(
    'compares text, single document, chunks and hybrid on the same queries',
    async () => {
      const pool = readMemories()
      const docs = readDocs()
      const probes = buildProbes(pool, docs)
      const ids = pool.map((m) => m.id)

      expect(pool.length).toBeGreaterThan(0)
      expect(probes.doc.length).toBeGreaterThan(0)

      const embedder = await createEmbedder({
        modelPath: path.join(MODEL, 'onnx', 'model.onnx'),
        tokenizerPath: path.join(MODEL, 'tokenizer.bin'),
        dim: 256,
        maxTokens: MAX_TOKENS,
      })
      const tokenizer = loadTokenizer(path.join(MODEL, 'tokenizer.bin'))

      // --- Vectors of the memory text (what production has today)
      const t0 = performance.now()
      const textVectors = await embedder.embed(pool.map((m) => buildRetrievalText(m)))
      const textMs = performance.now() - t0
      const textById = new Map(pool.map((m, i) => [m.id, textVectors[i]]))

      // --- Whole document in one vector
      const docIds = [...docs.keys()]
      const docVectors = await embedder.embed(docIds.map((id) => docs.get(id) ?? ''))
      const docById = new Map(docIds.map((id, i) => [id, docVectors[i]]))

      // --- Chunks
      const chunkTexts: string[] = []
      const chunkOwner: string[] = []
      let truncDocs = 0
      for (const id of docIds) {
        const doc = docs.get(id) ?? ''
        if (tokenizer.encode(doc, MAX_TOKENS).length >= MAX_TOKENS) truncDocs++
        for (const chunk of chunkDoc(doc)) {
          chunkTexts.push(chunk)
          chunkOwner.push(id)
        }
      }
      const tc0 = performance.now()
      const chunkVectors = await embedder.embed(chunkTexts)
      const chunkMs = performance.now() - tc0
      const chunksById = new Map<string, Float32Array[]>()
      chunkOwner.forEach((owner, i) => {
        const list = chunksById.get(owner) ?? []
        list.push(chunkVectors[i])
        chunksById.set(owner, list)
      })

      // --- Queries
      const queries = [...probes.doc, ...probes.text]
      const tq0 = performance.now()
      const queryVectors = await embedder.embed(queries.map((q) => q.text))
      const queryMs = performance.now() - tq0
      const queryById = new Map(queries.map((q, i) => [q.text, queryVectors[i]]))

      const vecOf = (id: string) => (textById.has(id) ? [textById.get(id)!] : [])
      const withDoc = (id: string) => [...vecOf(id), ...(docById.has(id) ? [docById.get(id)!] : [])]
      const withChunks = (id: string) => [...vecOf(id), ...(chunksById.get(id) ?? [])]

      const runVec = (vectorsOf: (id: string) => Float32Array[]) => (q: string) => {
        const qv = queryById.get(q)
        return qv ? rank(qv, ids, vectorsOf) : []
      }

      const lexical = (q: string) => searchMemories(pool, q, 10, { docs }).map((m) => m.id)
      const hybrid = (q: string) => {
        const qv = queryById.get(q)
        return qv ? rrf(lexical(q), rank(qv, ids, withChunks)) : lexical(q)
      }

      const rows = (queries: typeof probes.doc) => [
        line('só o texto (hoje)', measure(queries, runVec(vecOf))),
        line('+ documento único', measure(queries, runVec(withDoc))),
        line('+ trechos', measure(queries, runVec(withChunks))),
        line('lexical (hoje)', measure(queries, lexical)),
        line('híbrido lexical+trechos', measure(queries, hybrid)),
      ]

      const chunkLens = chunkTexts.map((c) => c.length)
      const report = [
        '',
        `[doc-vectors] ${pool.length} memórias · ${docs.size} documentos · ${chunkTexts.length} trechos`,
        `trecho: mediana ${quantile(chunkLens, 0.5)} car · p90 ${quantile(chunkLens, 0.9)} car · máx ${Math.max(...chunkLens)}`,
        `documentos que estouram a janela de ${MAX_TOKENS} tokens: ${truncDocs} de ${docIds.length}`,
        '',
        `tempo: texto ${textMs.toFixed(0)} ms · trechos ${chunkMs.toFixed(0)} ms · ${queries.length} consultas ${queryMs.toFixed(0)} ms`,
        `por vetor: ${(chunkMs / Math.max(chunkTexts.length, 1)).toFixed(2)} ms · por consulta: ${(queryMs / Math.max(queries.length, 1)).toFixed(2)} ms`,
        '',
        `consultas que só o documento responde (${probes.doc.length})`,
        ...rows(probes.doc),
        '',
        `regressão nas consultas de texto (${probes.text.length})`,
        ...rows(probes.text),
        '',
        'ganho do híbrido sobre o lexical, nas de doc:',
        `  ${delta(measure(probes.doc, lexical), measure(probes.doc, hybrid))}`,
        '',
      ]
      console.log(report.join('\n'))
    },
    900_000,
  )
})
