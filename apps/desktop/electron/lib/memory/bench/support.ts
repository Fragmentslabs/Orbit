/**
 * Support for the VALIDATION runner (audit.test.ts): loads the fixture and the model.
 * Kept separate from eval.test.ts on purpose — that one is the tuning harness (reads
 * `dev`), this one is the validation one (reads `eval` and `blocked`, never calibrates).
 */
import fs from 'node:fs'
import path from 'node:path'
import { compileTokenizer } from '../../../memory-embed/tokenizer.mjs'
import type { BenchCase, FixtureMemory } from './harness'

export const CACHE = path.resolve(__dirname, '../../../../.cache/memory-embed')
export const OUT = path.join(CACHE, 'results')

export type ModelId = 'a8m' | 'a25m'

export interface Fixture {
  memories: FixtureMemory[]
  cases: BenchCase[]
  dialogs: BenchCase[]
}

interface CaseTable {
  columns: string[]
  cases: unknown[][]
}

function table(raw: CaseTable): BenchCase[] {
  return raw.cases.map((row) => Object.fromEntries(raw.columns.map((c, i) => [c, row[i]])) as unknown as BenchCase)
}

/**
 * `main` = tuning fixture (dev/eval). `blocked` = a new set, created
 * after the design was frozen and never used to choose a parameter.
 */
export function loadFixture(name: 'main' | 'blocked' = 'main'): Fixture {
  if (name === 'blocked') {
    const f = JSON.parse(fs.readFileSync(path.join(__dirname, 'blocked.json'), 'utf8')) as {
      memories: FixtureMemory[]
      cases: CaseTable
      dialogs?: CaseTable
    }
    return {
      memories: f.memories,
      cases: table(f.cases),
      dialogs: f.dialogs ? table(f.dialogs) : [],
    }
  }
  const corpus = JSON.parse(fs.readFileSync(path.join(__dirname, 'corpus.json'), 'utf8')) as { memories: FixtureMemory[] }
  const cases = JSON.parse(fs.readFileSync(path.join(__dirname, 'cases.json'), 'utf8')) as CaseTable
  const dialogs = JSON.parse(fs.readFileSync(path.join(__dirname, 'dialogs.json'), 'utf8')) as { dialogs: BenchCase[] }
  return { memories: corpus.memories, cases: table(cases), dialogs: dialogs.dialogs }
}

/** Model paths in the cache; compiles tokenizer.bin the first time. */
export function modelPaths(id: ModelId) {
  const dir = path.join(CACHE, `bekko-${id}`)
  const modelPath = path.join(dir, 'onnx', 'model.onnx')
  const tokenizerJson = path.join(dir, 'tokenizer.json')
  const tokenizerPath = path.join(dir, 'tokenizer.bin')
  if (!fs.existsSync(modelPath) || !fs.existsSync(tokenizerJson)) {
    throw new Error(`modelo ausente em ${dir} — baixe hotchpotch/bekko-embedding-v1-${id}`)
  }
  if (!fs.existsSync(tokenizerPath)) compileTokenizer(tokenizerJson, tokenizerPath)
  return { modelPath, tokenizerPath }
}

export function hasModel(id: ModelId): boolean {
  return fs.existsSync(path.join(CACHE, `bekko-${id}`, 'onnx', 'model.onnx'))
}

export interface LoadedModel {
  embedder: { embed(texts: string[]): Promise<Float32Array[]>; dispose?(): Promise<void> }
  loadMs: number
  latencies: number[]
  embed(texts: string[]): Promise<Float32Array[]>
}

/** Loads the model and returns an `embed` that records the latency per text. */
export async function loadModel(id: ModelId): Promise<LoadedModel> {
  const { createEmbedder } = await import('../../../memory-embed/engine.mjs')
  const paths = modelPaths(id)
  const t0 = performance.now()
  const embedder = await createEmbedder({ ...paths, dim: 256 })
  const loadMs = performance.now() - t0
  const latencies: number[] = []
  const embed = async (texts: string[]) => {
    const out: Float32Array[] = []
    for (const text of texts) {
      const t = performance.now()
      const [vec] = await embedder.embed([text])
      latencies.push(performance.now() - t)
      out.push(vec)
    }
    return out
  }
  return { embedder, loadMs, latencies, embed }
}

export function pct(xs: number[], q: number): number {
  if (!xs.length) return NaN
  const s = [...xs].sort((a, b) => a - b)
  const i = Math.min(s.length - 1, Math.max(0, Math.round((s.length - 1) * q)))
  return s[i]
}
