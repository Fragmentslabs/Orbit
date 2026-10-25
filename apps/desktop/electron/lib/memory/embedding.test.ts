/**
 * Índice de embeddings: invalidação por assinatura, descarte de índice de outro
 * modelo e reindexação. O worker de verdade não roda aqui (esterilizado) — o
 * objetivo é garantir que o índice nunca fique com vetor obsoleto nem derrube o
 * app quando o motor não está disponível.
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
  // Sem motor: qualquer tentativa de subir o worker falha de forma explícita.
  utilityProcess: {
    fork: () => {
      throw new Error('worker não disponível no teste')
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

describe('índice persistido', () => {
  it('começa vazio quando não há arquivo', async () => {
    const { loadIndex } = await import('./embedding')
    const index = await loadIndex()
    expect(index.items).toEqual({})
    expect(index.model).toBe('bekko-a8m')
  })

  it('descarta o índice inteiro quando o modelo mudou', async () => {
    write({ v: 1, model: 'outro-modelo', dim: 256, schema: 1, items: { a: { sig: 'x', vec: 'AA==' } } })
    const { loadIndex } = await import('./embedding')
    expect((await loadIndex()).items).toEqual({})
  })

  it('descarta quando o esquema de índice mudou', async () => {
    write({ v: 1, model: 'bekko-a8m', dim: 256, schema: 0, items: { a: { sig: 'x', vec: 'AA==' } } })
    const { loadIndex } = await import('./embedding')
    expect((await loadIndex()).items).toEqual({})
  })

  it('índice corrompido não derruba: recomeça vazio', async () => {
    const file = path.join(userData, 'orbit-data', 'storage', 'memory', 'vectors.json')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, '{ isso não é json')
    const { loadIndex } = await import('./embedding')
    expect((await loadIndex()).items).toEqual({})
  })
})

describe('status e sincronização', () => {
  it('conta como pendente toda memória sem vetor válido', async () => {
    const { embeddingStatus } = await import('./embedding')
    const status = await embeddingStatus([memory('a', 'um'), memory('b', 'dois')])
    expect(status.pending).toBe(2)
    expect(status.indexed).toBe(0)
    expect(status.model).toBe('bekko-a8m')
  })

  it('remove do índice a memória que não existe mais', async () => {
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

  it('editar o texto torna o vetor pendente de novo', async () => {
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

  it('acrescentar enriquecimento também invalida o vetor', async () => {
    const { indexSignature } = await import('@shared/memory-retrieval')
    const { embeddingStatus } = await import('./embedding')
    const base = memory('a', 'mesmo texto')
    const sig = indexSignature(base, { id: 'bekko-a8m', dim: 256 })
    write({ v: 1, model: 'bekko-a8m', dim: 256, schema: 1, items: { a: { sig, vec: 'AAAAAAA=' } } })
    expect((await embeddingStatus([base])).indexed).toBe(1)
    const enriched = { ...base, title: 'Título novo', entities: ['Orbit'] }
    expect((await embeddingStatus([enriched])).pending).toBe(1)
  })

  it('sem modelo instalado, a sincronização falha em silêncio', async () => {
    const { syncIndex } = await import('./embedding')
    const result = await syncIndex([memory('a', 'texto')])
    expect(result.failed).toBe(true)
    expect(result.indexed).toBe(0)
  })
})

/**
 * O modelo vai dentro do app (`extraResources` → `resources/memory-embed`).
 * A instalação nova precisa achá-lo ali, sem depender de download nem do cache
 * de desenvolvimento — que é o que existe hoje numa máquina que só instalou o
 * app e nunca rodou o repositório.
 */
describe('modelo que veio no pacote', () => {
  let resources: string
  let root: string

  beforeEach(() => {
    resources = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-resources-'))
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-approot-'))
    // Sem cache de dev nesta rodada: só o pacote pode responder.
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

  it('acha o modelo empacotado', async () => {
    putModel()
    const { modelInstalled } = await import('./embedding')
    expect(modelInstalled()).toBe(true)
  })

  it('só o tokenizer.json também serve (o worker compila o .bin)', async () => {
    const dir = path.join(resources, 'memory-embed', 'bekko-a8m')
    fs.mkdirSync(path.join(dir, 'onnx'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'onnx', 'model.onnx'), 'x')
    fs.writeFileSync(path.join(dir, 'tokenizer.json'), 'x')
    const { modelInstalled } = await import('./embedding')
    expect(modelInstalled()).toBe(true)
  })

  it('não inventa modelo quando o pacote veio sem ele', async () => {
    const { modelInstalled } = await import('./embedding')
    expect(modelInstalled()).toBe(false)
  })

  it('não baixa quando o modelo já veio no pacote', async () => {
    putModel()
    const { downloadModel } = await import('./embedding')
    expect(await downloadModel()).toBe(true)
    // Nada foi escrito no userData — seria uma segunda cópia de 130 MB.
    expect(fs.existsSync(path.join(userData, 'memory', 'models'))).toBe(false)
  })
})
