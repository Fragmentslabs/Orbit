/**
 * Embedding index: invalidation by signature, discarding an index from another
 * model and reindexing. The real worker does not run here (sterilized) — the
 * goal is to guarantee the index never keeps a stale vector nor takes the
 * app down when the engine is unavailable.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Memory } from '@shared/memory'

let userData: string

vi.mock('electron', () => ({
  app: {
    getPath: (key: string) => (key === 'userData' ? userData : os.tmpdir()),
    getAppPath: () => path.resolve(__dirname, '../../..'),
  },
  // No engine: any attempt to start the worker fails explicitly.
  utilityProcess: {
    fork: () => {
      throw new Error('worker not available in the test')
    },
  },
}))

const memory = (id: string, text: string): Memory => ({
  id,
  kind: 'general',
  text,
  tags: [],
  weight: 0.7,
  hits: 0,
  relatedIds: [],
  createdAt: 0,
})

const write = (payload: unknown) => {
  const file = path.join(userData, 'orbit-data', 'storage', 'memory', 'vectors.json')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(payload))
}

beforeEach(() => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-embed-'))
  vi.resetModules()
})

afterEach(() => {
  fs.rmSync(userData, { recursive: true, force: true })
})

describe('persisted index', () => {
  it('starts empty when there is no file', async () => {
    const { loadIndex } = await import('./embedding')
    const index = await loadIndex()
    expect(index.items).toEqual({})
    expect(index.model).toBe('bekko-a8m')
  })

  it('discards the whole index when the model changed', async () => {
    write({ v: 1, model: 'outro-modelo', dim: 256, schema: 1, items: { a: { sig: 'x', vec: 'AA==' } } })
    const { loadIndex } = await import('./embedding')
    expect((await loadIndex()).items).toEqual({})
  })

  it('discards when the index schema changed', async () => {
    write({ v: 1, model: 'bekko-a8m', dim: 256, schema: 0, items: { a: { sig: 'x', vec: 'AA==' } } })
    const { loadIndex } = await import('./embedding')
    expect((await loadIndex()).items).toEqual({})
  })

  it('a corrupted index does not crash it: it restarts empty', async () => {
    const file = path.join(userData, 'orbit-data', 'storage', 'memory', 'vectors.json')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, '{ this is not json')
    const { loadIndex } = await import('./embedding')
    expect((await loadIndex()).items).toEqual({})
  })
})

describe('status and synchronization', () => {
  it('counts every memory without a valid vector as pending', async () => {
    const { embeddingStatus } = await import('./embedding')
    const status = await embeddingStatus([memory('a', 'um'), memory('b', 'dois')])
    expect(status.pending).toBe(2)
    expect(status.indexed).toBe(0)
    expect(status.model).toBe('bekko-a8m')
  })

  it('removes from the index the memory that no longer exists', async () => {
    write({
      v: 1,
      model: 'bekko-a8m',
      dim: 256,
      schema: 1,
      items: { antiga: { sig: 'x', vec: 'AAAAAAA=' } },
    })
    const { syncIndex, loadIndex } = await import('./embedding')
    const result = await syncIndex([])
    expect(result.removed).toBe(1)
    expect((await loadIndex()).items).toEqual({})
  })

  it('editing the text makes the vector pending again', async () => {
    const { indexSignature } = await import('@shared/memory-retrieval')
    const { embeddingStatus } = await import('./embedding')
    const original = memory('a', 'texto original')
    const sig = indexSignature(original, { id: 'bekko-a8m', dim: 256 })
    write({ v: 1, model: 'bekko-a8m', dim: 256, schema: 1, items: { a: { sig, vec: 'AAAAAAA=' } } })
    expect((await embeddingStatus([original])).indexed).toBe(1)
    const edited = { ...original, text: 'texto editado' }
    const after = await embeddingStatus([edited])
    expect(after.pending).toBe(1)
    expect(after.indexed).toBe(0)
  })

  it('adding enrichment also invalidates the vector', async () => {
    const { indexSignature } = await import('@shared/memory-retrieval')
    const { embeddingStatus } = await import('./embedding')
    const base = memory('a', 'mesmo texto')
    const sig = indexSignature(base, { id: 'bekko-a8m', dim: 256 })
    write({ v: 1, model: 'bekko-a8m', dim: 256, schema: 1, items: { a: { sig, vec: 'AAAAAAA=' } } })
    expect((await embeddingStatus([base])).indexed).toBe(1)
    const enriched = { ...base, title: 'Título novo', entities: ['Orbit'] }
    expect((await embeddingStatus([enriched])).pending).toBe(1)
  })

  it('without a model installed, synchronization fails silently', async () => {
    const { syncIndex } = await import('./embedding')
    const result = await syncIndex([memory('a', 'texto')])
    expect(result.failed).toBe(true)
    expect(result.indexed).toBe(0)
  })
})

/**
 * The model ships inside the app (`extraResources` → `resources/memory-embed`).
 * A fresh install has to find it there, without depending on a download or on the
 * development cache — which is what exists today on a machine that only installed the
 * app and never ran the repository.
 */
describe('model that came in the package', () => {
  let resources: string
  let root: string

  beforeEach(() => {
    resources = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-resources-'))
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-approot-'))
    // No dev cache in this run: only the bundle can answer.
    process.env.APP_ROOT = root
    Object.defineProperty(process, 'resourcesPath', { value: resources, configurable: true })
  })

  afterEach(() => {
    fs.rmSync(resources, { recursive: true, force: true })
    fs.rmSync(root, { recursive: true, force: true })
    Reflect.deleteProperty(process.env, 'APP_ROOT')
    Reflect.deleteProperty(process, 'resourcesPath')
  })

  const putModel = () => {
    const dir = path.join(resources, 'memory-embed', 'bekko-a8m')
    fs.mkdirSync(path.join(dir, 'onnx'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'onnx', 'model.onnx'), 'x')
    fs.writeFileSync(path.join(dir, 'tokenizer.bin'), 'x')
  }

  it('finds the bundled model', async () => {
    putModel()
    const { modelInstalled } = await import('./embedding')
    expect(modelInstalled()).toBe(true)
  })

  it('only the tokenizer.json also works (the worker compiles the .bin)', async () => {
    const dir = path.join(resources, 'memory-embed', 'bekko-a8m')
    fs.mkdirSync(path.join(dir, 'onnx'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'onnx', 'model.onnx'), 'x')
    fs.writeFileSync(path.join(dir, 'tokenizer.json'), 'x')
    const { modelInstalled } = await import('./embedding')
    expect(modelInstalled()).toBe(true)
  })

  it('does not invent a model when the package came without one', async () => {
    const { modelInstalled } = await import('./embedding')
    expect(modelInstalled()).toBe(false)
  })

  it('does not download when the model already came in the package', async () => {
    putModel()
    const { downloadModel } = await import('./embedding')
    expect(await downloadModel()).toBe(true)
    // Nothing was written in userData — it would be a second 130 MB copy.
    expect(fs.existsSync(path.join(userData, 'memory', 'models'))).toBe(false)
  })
})
