import { app, utilityProcess, type UtilityProcess } from 'electron'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Memory } from '@shared/memory'
import { INDEX_SCHEMA_VERSION, buildRetrievalText, indexSignature } from '@shared/memory-retrieval'
import { readJson, writeJson } from '../storage'

/**
 * Índice de embeddings das memórias, do lado do main.
 *
 * Três responsabilidades:
 *  1. subir/derrubar o worker (`electron/memory-embed/worker.mjs`) por
 *     ociosidade — o modelo custa ~400 MB de RSS e não pode ficar para sempre;
 *  2. manter os vetores em disco, com assinatura por memória, para reindexar só
 *     o que mudou (conteúdo, enriquecimento, esquema ou modelo);
 *  3. degradar em silêncio: sem modelo baixado, sem worker ou com o índice
 *     corrompido, o app continua com a busca lexical.
 *
 * O que é indexado é o `buildRetrievalText` (título + conteúdo + entidades +
 * palavras-chave + conceitos), nunca o texto cru: é ele que dá recall para
 * perguntas que não repetem as palavras da memória.
 */

/** Modelo de produção. O a25m foi medido e descartado (ver docs/memoria-contextual.md). */
export const MEMORY_MODEL_ID = 'bekko-a8m' as const
export const MEMORY_MODEL_DIM = 256
/** Repositório público de onde o modelo é baixado na primeira vez. */
const MODEL_REPO = 'hotchpotch/bekko-embedding-v1-a8m'
/** O que um download avulso precisa trazer: o grafo e o tokenizador de origem. */
const DOWNLOAD_FILES = ['onnx/model.onnx', 'tokenizer.json']

/** Sem uso por este tempo, o worker se desliga (devolve ~400 MB). */
const IDLE_SHUTDOWN_MS = 5 * 60_000
const READY_TIMEOUT_MS = 60_000
const STALL_TIMEOUT_MS = 60_000
const GRACE_MS = 1_500

export const VECTORS_KEY = 'memory/vectors'

interface StoredVector {
  /** Assinatura do que foi embutido (conteúdo + enriquecimento + esquema + modelo) */
  sig: string
  /** float32 em base64 */
  vec: string
}

interface VectorsPayload {
  v: number
  model: string
  dim: number
  schema: number
  /** Piso de ruído do acervo (maiores cossenos das sondas), ordenado */
  noise?: number[]
  /** Assinatura do acervo que produziu `noise` */
  noiseSig?: string
  items: Record<string, StoredVector>
}

export interface EmbeddingStatus {
  /** Os arquivos do modelo estão no disco */
  installed: boolean
  /** O worker está de pé */
  running: boolean
  /** Memórias com vetor válido */
  indexed: number
  /** Memórias que precisam de (re)indexação */
  pending: number
  model: string
  dim: number
}

// ---------------------------------------------------------------------------
// Modelo em disco
// ---------------------------------------------------------------------------

/**
 * Pasta do modelo dentro do app empacotado: `resources/memory-embed/<id>`,
 * fora do asar (ver `extraResources` no electron-builder).
 *
 * É de onde o modelo vem numa instalação nova. Deixá-lo aqui — em vez de
 * baixar na primeira execução — resolve três coisas de uma vez: funciona
 * offline desde o primeiro abrir, não há tela nem falha de download, e a
 * atualização do app é diferencial (os bytes do modelo não mudam entre
 * releases, então o updater não baixa esses blocos de novo).
 */
function bundledModelDir(id: string): string | null {
  const root = process.resourcesPath
  return root ? path.join(root, 'memory-embed', id) : null
}

/** Pasta do download avulso: `<userData>/memory/models/<id>`. */
export function modelDir(id: string = MEMORY_MODEL_ID): string {
  const custom = process.env.ORBIT_MEMORY_MODEL_DIR
  if (custom) return path.join(custom, id)
  return path.join(app.getPath('userData'), 'memory', 'models', id)
}

function devCacheDir(id: string): string {
  const raiz = process.env.APP_ROOT ?? app.getAppPath()
  return path.join(raiz, '.cache', 'memory-embed', id)
}

/**
 * O que o motor precisa achar: o grafo ONNX e um tokenizador — o `.bin`
 * compilado (9 MB, o que o runtime lê) ou o `.json` de origem (34 MB), que o
 * worker compila na primeira execução quando o pacote trouxe só ele.
 */
const MODEL_CORE = ['onnx/model.onnx']
const TOKENIZERS = ['tokenizer.bin', 'tokenizer.json']

function looksComplete(dir: string): boolean {
  return (
    MODEL_CORE.every((file) => fs.existsSync(path.join(dir, file))) &&
    TOKENIZERS.some((file) => fs.existsSync(path.join(dir, file)))
  )
}

/**
 * Onde procurar o modelo, nesta ordem: override explícito, o que veio no
 * instalador, o que uma instalação antiga baixou, e o cache de desenvolvimento.
 *
 * O pacote vem antes do `userData` de propósito: numa máquina que já teve uma
 * versão anterior, os dois podem existir, e o do pacote é o que está na
 * versão certa.
 */
function modelSearchPath(id: string): string[] {
  const custom = process.env.ORBIT_MEMORY_MODEL_DIR
  const dirs: string[] = custom ? [path.join(custom, id)] : []
  const bundled = bundledModelDir(id)
  if (bundled) dirs.push(bundled)
  dirs.push(path.join(app.getPath('userData'), 'memory', 'models', id))
  dirs.push(devCacheDir(id))
  return dirs
}

export function modelInstalled(): boolean {
  return modelSearchPath(MEMORY_MODEL_ID).some(looksComplete)
}

/** Pasta efetivamente usada (a do pacote numa instalação nova, a do repo no dev). */
function activeModelDir(): string | null {
  for (const dir of modelSearchPath(MEMORY_MODEL_ID)) {
    if (looksComplete(dir)) return dir
  }
  return null
}

export type DownloadProgress = (info: { file: string; received: number; total: number }) => void

/**
 * Baixa o modelo do Hugging Face para `<userData>/memory/models/<id>`.
 * Silencioso por padrão: em falha (offline, proxy), o app segue no lexical.
 */
export async function downloadModel(onProgress?: DownloadProgress): Promise<boolean> {
  // Já veio no instalador: não há nada a baixar, e um download criaria uma
  // segunda cópia de 130 MB no disco.
  const bundled = bundledModelDir(MEMORY_MODEL_ID)
  if (bundled && looksComplete(bundled)) return true
  const dir = modelDir()
  await fsp.mkdir(dir, { recursive: true })
  for (const file of DOWNLOAD_FILES) {
    const target = path.join(dir, file)
    if (fs.existsSync(target)) continue
    await fsp.mkdir(path.dirname(target), { recursive: true })
    const url = `https://huggingface.co/${MODEL_REPO}/resolve/main/${file}`
    const res = await fetch(url, { redirect: 'follow' })
    if (!res.ok || !res.body) throw new Error(`download de ${file} falhou (${res.status})`)
    const total = Number(res.headers.get('content-length') ?? 0)
    const part = `${target}.part`
    const handle = await fsp.open(part, 'w')
    let received = 0
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        await handle.write(chunk)
        received += chunk.byteLength
        onProgress?.({ file, received, total })
      }
    } finally {
      await handle.close()
    }
    await fsp.rename(part, target)
  }
  return true
}

// ---------------------------------------------------------------------------
// Cliente do worker
// ---------------------------------------------------------------------------

interface Pending {
  resolve: (vectors: Float32Array[]) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
}

let child: UtilityProcess | null = null
let ready = false
let starting: Promise<void> | null = null
let stopping = false
let idleTimer: NodeJS.Timeout | null = null
const pending = new Map<string, Pending>()
const log: string[] = []

function pushLog(text: string) {
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t) continue
    log.push(t)
    if (log.length > 40) log.shift()
  }
}

function engineFile(): string {
  const raiz = process.env.APP_ROOT ?? app.getAppPath()
  return path.join(raiz, 'electron', 'memory-embed', 'worker.mjs')
}

function clearIdle() {
  if (idleTimer) {
    clearTimeout(idleTimer)
    idleTimer = null
  }
}

function scheduleIdle() {
  clearIdle()
  if (!child) return
  idleTimer = setTimeout(() => void stopWorker(), IDLE_SHUTDOWN_MS)
  idleTimer.unref?.()
}

function failAll(message: string) {
  for (const [id, entry] of pending) {
    clearTimeout(entry.timer)
    entry.reject(new Error(message))
    pending.delete(id)
  }
}

function onMessage(message: Record<string, unknown>) {
  if (message?.type === 'ready') {
    ready = true
    return
  }
  if (message?.type === 'error' && message.fatal) {
    pushLog(`[memory] worker: ${String(message.message)}`)
    void stopWorker()
    return
  }
  if (typeof message?.id === 'string' && message.done) {
    const entry = pending.get(message.id)
    if (!entry) return
    pending.delete(message.id)
    clearTimeout(entry.timer)
    scheduleIdle()
    if (message.error) {
      entry.reject(new Error(String(message.error)))
      return
    }
    const vectors = (message.vectors as string[] | undefined) ?? []
    entry.resolve(
      vectors.map((b64) => {
        const buf = Buffer.from(b64, 'base64')
        // Cópia alinhada: Float32Array exige offset múltiplo de 4 no buffer.
        return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))
      }),
    )
  }
}

function startWorker(): Promise<void> {
  if (child && ready) return Promise.resolve()
  if (starting) return starting
  const dir = activeModelDir()
  if (!dir) return Promise.reject(new Error('modelo de memória não instalado'))

  // Dentro do app assinado a pasta do modelo é somente-leitura na prática:
  // escrever ali invalidaria a assinatura do bundle. O worker compila o
  // tokenizador fora dela quando for o caso.
  const readonly = dir === bundledModelDir(MEMORY_MODEL_ID)

  starting = new Promise<void>((resolve, reject) => {
    let settled = false
    const proc = utilityProcess.fork(
      engineFile(),
      [
        '--model',
        MEMORY_MODEL_ID,
        '--dir',
        dir,
        '--dim',
        String(MEMORY_MODEL_DIM),
        '--readonly',
        readonly ? '1' : '0',
      ],
      { stdio: 'pipe' },
    )
    child = proc
    stopping = false

    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      reject(new Error('o worker de memória não ficou pronto a tempo'))
    }, READY_TIMEOUT_MS)

    proc.stdout?.on('data', (chunk: Buffer) => pushLog(chunk.toString()))
    proc.stderr?.on('data', (chunk: Buffer) => pushLog(chunk.toString()))

    proc.on('message', (message: Record<string, unknown>) => {
      if (message?.type === 'ready' && !settled) {
        settled = true
        clearTimeout(timeout)
        ready = true
        scheduleIdle()
        resolve()
      }
      onMessage(message)
    })

    proc.on('exit', (code) => {
      if (child === proc) child = null
      ready = false
      clearIdle()
      const asked = stopping
      stopping = false
      if (!settled) {
        settled = true
        clearTimeout(timeout)
        reject(new Error(`o worker de memória encerrou ao iniciar (código ${code})`))
      }
      failAll(`o worker de memória encerrou (código ${code})`)
      pushLog(`[memory] worker encerrou (código ${code})${asked ? ' (ociosidade)' : ''}`)
    })
  }).finally(() => {
    starting = null
  })

  return starting
}

export async function stopWorker(): Promise<void> {
  clearIdle()
  const proc = child
  if (!proc) return
  stopping = true
  child = null
  ready = false
  failAll('worker de memória encerrado')
  try {
    proc.postMessage({ cmd: 'shutdown' })
  } catch {
    // processo já morto
  }
  await new Promise<void>((resolve) => {
    const force = setTimeout(() => {
      proc.kill()
      resolve()
    }, GRACE_MS)
    proc.once('exit', () => {
      clearTimeout(force)
      resolve()
    })
  })
}

/** Vetores de uma lista de textos. Lança quando o modelo não está disponível. */
export async function embedTexts(texts: string[]): Promise<Float32Array[]> {
  if (texts.length === 0) return []
  await startWorker()
  clearIdle()
  return new Promise<Float32Array[]>((resolve, reject) => {
    const id = randomUUID()
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error('o worker de memória parou de responder'))
    }, STALL_TIMEOUT_MS)
    pending.set(id, { resolve, reject, timer })
    child?.postMessage({ id, cmd: 'embed', texts })
  })
}

// ---------------------------------------------------------------------------
// Índice persistido
// ---------------------------------------------------------------------------

let cache: VectorsPayload | null = null

const decode = (b64: string): Float32Array => {
  const buf = Buffer.from(b64, 'base64')
  return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))
}

const encode = (vec: Float32Array): string =>
  Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength).toString('base64')

function emptyIndex(): VectorsPayload {
  return { v: 1, model: MEMORY_MODEL_ID, dim: MEMORY_MODEL_DIM, schema: INDEX_SCHEMA_VERSION, items: {} }
}

/** Índice em memória. Um payload de outro modelo/esquema é descartado inteiro. */
export async function loadIndex(): Promise<VectorsPayload> {
  if (cache) return cache
  try {
    const stored = await readJson<VectorsPayload>(VECTORS_KEY)
    if (
      stored &&
      stored.v === 1 &&
      stored.model === MEMORY_MODEL_ID &&
      stored.dim === MEMORY_MODEL_DIM &&
      stored.schema === INDEX_SCHEMA_VERSION &&
      stored.items
    ) {
      cache = stored
      return stored
    }
  } catch {
    // índice corrompido: começa vazio e reindexa em segundo plano
  }
  cache = emptyIndex()
  return cache
}

let decoded: { payload: VectorsPayload; map: Map<string, Float32Array> } | null = null

/**
 * Vetores decodificados. Memoizado pelo objeto do índice: enquanto ninguém
 * gravar por cima (syncIndex), a mesma tabela é reusada em cada turno.
 */
export async function vectorsById(): Promise<Map<string, Float32Array>> {
  const index = await loadIndex()
  if (decoded && decoded.payload === index) return decoded.map
  const map = new Map<string, Float32Array>()
  for (const [id, item] of Object.entries(index.items)) map.set(id, decode(item.vec))
  decoded = { payload: index, map }
  return map
}

/** Assinatura do acervo inteiro — muda quando qualquer memória muda. */
function corpusSignature(memories: Memory[]): string {
  return indexSignature(
    { text: memories.map((m) => `${m.id}:${indexSignature(m, { id: MEMORY_MODEL_ID, dim: MEMORY_MODEL_DIM })}`).sort().join('|'), tags: [] },
    { id: MEMORY_MODEL_ID, dim: MEMORY_MODEL_DIM },
  )
}

export interface SyncResult {
  indexed: number
  removed: number
  failed: boolean
}

/**
 * Deixa o índice em dia com o acervo: remove o que sumiu e embute só o que
 * mudou. Roda em segundo plano (o chamador não deve esperar), em lotes, para
 * uma reindexação grande não segurar o processo nem inundar o worker.
 */
export async function syncIndex(memories: Memory[], options: { batch?: number } = {}): Promise<SyncResult> {
  const index = await loadIndex()
  const alive = new Set(memories.map((m) => m.id))
  let removed = 0
  for (const id of Object.keys(index.items)) {
    if (!alive.has(id)) {
      delete index.items[id]
      removed++
    }
  }

  const stale = memories.filter((m) => {
    const sig = indexSignature(m, { id: MEMORY_MODEL_ID, dim: MEMORY_MODEL_DIM })
    return index.items[m.id]?.sig !== sig
  })
  if (stale.length === 0 && removed === 0) return { indexed: 0, removed: 0, failed: false }

  const batch = options.batch ?? 16
  let indexed = 0
  try {
    for (let i = 0; i < stale.length; i += batch) {
      const slice = stale.slice(i, i + batch)
      const vectors = await embedTexts(slice.map((m) => buildRetrievalText(m)))
      slice.forEach((memory, k) => {
        index.items[memory.id] = {
          sig: indexSignature(memory, { id: MEMORY_MODEL_ID, dim: MEMORY_MODEL_DIM }),
          vec: encode(vectors[k]),
        }
      })
      indexed += slice.length
      await writeJson(VECTORS_KEY, index)
    }
    if (removed > 0) await writeJson(VECTORS_KEY, index)
    return { indexed, removed, failed: false }
  } catch (err) {
    // O que já foi embutido fica; a próxima chamada continua daqui.
    console.error('[memory] indexação interrompida:', err)
    await writeJson(VECTORS_KEY, index).catch(() => {})
    return { indexed, removed, failed: true }
  }
}

/** Piso de ruído do acervo, guardado junto com o índice (37 vetores por acervo novo). */
export async function noiseFloorFor(probes: string[], memories: Memory[]): Promise<number[] | undefined> {
  const index = await loadIndex()
  const sig = corpusSignature(memories)
  if (index.noise && index.noiseSig === sig) return index.noise
  try {
    const probeVectors = await embedTexts(probes)
    const memoryVectors = [...(await vectorsById()).values()]
    if (memoryVectors.length === 0) return undefined
    const tops = probeVectors
      .map((probe) => {
        let best = -1
        for (const vec of memoryVectors) {
          let s = 0
          for (let i = 0; i < probe.length; i++) s += probe[i] * vec[i]
          if (s > best) best = s
        }
        return best
      })
      .sort((a, b) => a - b)
    index.noise = tops
    index.noiseSig = sig
    await writeJson(VECTORS_KEY, index)
    return tops
  } catch {
    return index.noise
  }
}

export async function embeddingStatus(memories: Memory[]): Promise<EmbeddingStatus> {
  const index = await loadIndex()
  let valid = 0
  for (const memory of memories) {
    const item = index.items[memory.id]
    if (!item) continue
    if (item.sig === indexSignature(memory, { id: MEMORY_MODEL_ID, dim: MEMORY_MODEL_DIM })) valid++
  }
  return {
    installed: modelInstalled(),
    running: Boolean(child && ready),
    indexed: valid,
    pending: memories.length - valid,
    model: MEMORY_MODEL_ID,
    dim: MEMORY_MODEL_DIM,
  }
}

/** Diagnóstico das últimas linhas do worker (app empacotado). */
export function embeddingLog(): string[] {
  return [...log]
}
