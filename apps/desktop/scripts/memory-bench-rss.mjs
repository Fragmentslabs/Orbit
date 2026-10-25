/**
 * Custo real do motor de memória, medido num processo limpo (sem vitest):
 * RSS antes/depois de carregar o modelo, depois do tokenizer, depois do índice
 * do acervo, e o tempo de indexação e de consulta.
 *
 *   node scripts/memory-bench-rss.mjs a8m
 *   node scripts/memory-bench-rss.mjs a25m
 *
 * Rode 3 vezes por modelo e reporte a MEDIANA — cada execução é um processo
 * novo, senão a RAM do modelo anterior contamina a medição.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const id = process.argv[2] ?? 'a8m'
const cache = path.join(here, '..', '.cache', 'memory-embed', `bekko-${id}`)
const modelPath = path.join(cache, 'onnx', 'model.onnx')
if (!fs.existsSync(modelPath)) {
  console.error(`modelo ausente: ${modelPath}`)
  process.exit(1)
}

// O acervo de medição é o corpus sintético do benchmark (61 memórias).
const corpus = JSON.parse(
  fs.readFileSync(path.join(here, '..', 'electron', 'lib', 'memory', 'bench', 'corpus.json'), 'utf8'),
).memories

const mb = () => Math.round(process.memoryUsage().rss / 1e6)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const rssBase = mb()
const { createEmbedder } = await import('../electron/memory-embed/engine.mjs')
const { compileTokenizer } = await import('../electron/memory-embed/tokenizer.mjs')
const { buildRetrievalText } = await import('../../packages/shared/src/memory-retrieval.ts').catch(() => ({}))

const tokenizerBin = path.join(cache, 'tokenizer.bin')
if (!fs.existsSync(tokenizerBin)) compileTokenizer(path.join(cache, 'tokenizer.json'), tokenizerBin)
const tokenizerBytes = fs.statSync(tokenizerBin).size

const t0 = performance.now()
const embedder = await createEmbedder({ modelPath, tokenizerPath: tokenizerBin, dim: 256 })
const loadMs = performance.now() - t0
await sleep(150)
const rssModel = mb()

// Índice do acervo: o texto indexado é o enriquecido (título + conceitos),
// como no app; se o import do shared não resolver, cai no texto puro.
const texts = corpus
  .filter((m) => !m.fixed)
  .map((m) => (buildRetrievalText ? buildRetrievalText(m) : `${m.text} ${(m.tags ?? []).join(' ')}`))

const tIndex = performance.now()
const vectors = []
for (const text of texts) {
  const [vec] = await embedder.embed([text])
  vectors.push(vec)
}
const indexMs = performance.now() - tIndex
await sleep(150)
const rssIndexed = mb()

const queries = [
  'posso levar bagagem grande no voo?',
  'quando é o aniversário da minha mãe?',
  'qual banco eu uso para pagar viagens?',
  'what is the test runner for the Atlas project?',
  '¿cuándo vence mi pasaporte?',
  '飛行機の座席はどこがいい?',
  'qual a capital da Austrália?',
]
const lat = []
for (const q of queries) {
  const t = performance.now()
  await embedder.embed([q])
  lat.push(performance.now() - t)
}
lat.sort((a, b) => a - b)
const median = lat[Math.floor(lat.length / 2)]
const p95 = lat[Math.min(lat.length - 1, Math.floor(lat.length * 0.95))]

// Bytes que o índice ocupa em disco/memória (float32, 256 dims).
const vectorBytes = vectors.length * 256 * 4

await embedder.dispose()

console.log(
  JSON.stringify(
    {
      model: id,
      rssBaseMB: rssBase,
      rssModelMB: rssModel,
      rssIndexedMB: rssIndexed,
      modelMB: rssModel - rssBase,
      tokenizerBytes,
      loadMs: Math.round(loadMs),
      indexMs: Math.round(indexMs),
      indexPerMemoryMs: +(indexMs / texts.length).toFixed(1),
      firstQueryMs: +lat[0].toFixed(2),
      medianMs: +median.toFixed(2),
      p95Ms: +p95.toFixed(2),
      memories: texts.length,
      vectorBytes,
    },
    null,
    1,
  ),
)
