import { app, utilityProcess, type UtilityProcess } from 'electron'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Memory } from '@shared/memory'
import { INDEX_SCHEMA_VERSION, buildRetrievalText, indexSignature } from '@shared/memory-retrieval'
import { readJson, writeJson } from '../storage'
import { getAppSettings } from '../app-settings'

/**
 * Memory embedding index, on the main side.
 *
 * Three responsibilities:
 *  1. start/stop the worker (`electron/memory-embed/worker.mjs`) when
 *     idle — the model costs ~400 MB of RSS and cannot stay up forever;
 *  2. keep the vectors on disk, with a signature per memory, to reindex only
 *     what changed (content, enrichment, schema or model);
 *  3. degrade silently: with no model downloaded, no worker or a corrupted
 *     index, the app carries on with the lexical search.
 *
 * What gets indexed is `buildRetrievalText` (title + content + entities +
 * keywords + concepts), never the raw text: it is what gives recall for
 * questions that do not repeat the words of the memory.
 */

/** Production model. a25m was measured and discarded (see docs/contextual-memory.md). */
export const MEMORY_MODEL_ID = 'bekko-a8m' as const
export const MEMORY_MODEL_DIM = 256
/** Public repository the model is downloaded from the first time. */
const MODEL_REPO = 'hotchpotch/bekko-embedding-v1-a8m'
/** What a standalone download has to bring: the graph and the source tokenizer. */
const DOWNLOAD_FILES = ['onnx/model.onnx', 'tokenizer.json']

/** Unused for this long, the worker shuts down (gives back ~400 MB). */
const IDLE_SHUTDOWN_MS = 5 * 60_000
const READY_TIMEOUT_MS = 60_000
const STALL_TIMEOUT_MS = 60_000
const GRACE_MS = 1_500

export const VECTORS_KEY = 'memory/vectors'

interface StoredVector {
  /** Signature of what was embedded (content + enrichment + schema + model) */
  sig: string
  /** float32 in base64 */
  vec: string
}

interface VectorsPayload {
  v: number
  model: string
  dim: number
  schema: number
  /** Noise floor of the pool (highest cosines of the probes), sorted */
  noise?: number[]
  /** Signature of the pool that produced `noise` */
  noiseSig?: string
  items: Record<string, StoredVector>
}

export interface EmbeddingStatus {
  /** The user's switch (Preferences). Off = the worker never starts and every consumer falls back. */
  enabled: boolean
  /** The model files are on disk */
  installed: boolean
  /** The worker is up */
  running: boolean
  /** Memories with a valid vector */
  indexed: number
  /** Memories that need (re)indexing */
  pending: number
  model: string
  dim: number
}

// ---------------------------------------------------------------------------
// Model on disk
// ---------------------------------------------------------------------------

/**
 * Model folder inside the packaged app: `resources/memory-embed/<id>`,
 * outside the asar (see `extraResources` in electron-builder).
 *
 * It is where the model comes from on a fresh install. Keeping it here — instead of
 * downloading it on first run — solves three things at once: it works
 * offline from the very first launch, there is no screen and no download failure, and the
 * app update is differential (the model bytes do not change between
 * releases, so the updater does not download those blocks again).
 */
function bundledModelDir(id: string): string | null {
  const root = process.resourcesPath
  return root ? path.join(root, 'memory-embed', id) : null
}

/** Folder of the standalone download: `<userData>/memory/models/<id>`. */
export function modelDir(id: string = MEMORY_MODEL_ID): string {
  const custom = process.env.ORBIT_MEMORY_MODEL_DIR
  if (custom) return path.join(custom, id)
  return path.join(app.getPath('userData'), 'memory', 'models', id)
}

function devCacheDir(id: string): string {
  const root = process.env.APP_ROOT ?? app.getAppPath()
  return path.join(root, '.cache', 'memory-embed', id)
}

/**
 * What the engine has to find: the ONNX graph and a tokenizer — the compiled
 * `.bin` (9 MB, what the runtime reads) or the source `.json` (34 MB), which the
 * worker compiles on first run when the package brought only that.
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
 * Where to look for the model, in this order: explicit override, what came in the
 * installer, what an old install downloaded, and the development cache.
 *
 * The bundle comes before `userData` on purpose: on a machine that already had a
 * previous version, both may exist, and the bundled one is the one at the
 * right version.
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

/**
 * The user's switch. Every entry point below checks it, so turning it off is enough to get
 * back the lexical behaviour everywhere (memory, skills, tool families) with no other flag.
 */
export function embeddingsEnabled(): boolean {
  return getAppSettings().embeddings
}

export function modelInstalled(): boolean {
  return modelSearchPath(MEMORY_MODEL_ID).some(looksComplete)
}

/** Folder actually used (the bundled one on a fresh install, the repo one in dev). */
function activeModelDir(): string | null {
  for (const dir of modelSearchPath(MEMORY_MODEL_ID)) {
    if (looksComplete(dir)) return dir
  }
  return null
}

export type DownloadProgress = (info: { file: string; received: number; total: number }) => void

/**
 * Downloads the model from Hugging Face to `<userData>/memory/models/<id>`.
 * Silent by default: on failure (offline, proxy), the app carries on with the lexical search.
 */
export async function downloadModel(onProgress?: DownloadProgress): Promise<boolean> {
  // It already came in the installer: there is nothing to download, and a download would create a
  // second 130 MB copy on disk.
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
    if (!res.ok || !res.body) throw new Error(`download of ${file} failed (${res.status})`)
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
// Worker client
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
  const root = process.env.APP_ROOT ?? app.getAppPath()
  return path.join(root, 'electron', 'memory-embed', 'worker.mjs')
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
        // Aligned copy: Float32Array requires an offset that is a multiple of 4 in the buffer.
        return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))
      }),
    )
  }
}

function startWorker(): Promise<void> {
  if (child && ready) return Promise.resolve()
  if (starting) return starting
  const dir = activeModelDir()
  if (!dir) return Promise.reject(new Error('memory model not installed'))

  // Inside the signed app the model folder is read-only in practice:
  // writing there would invalidate the bundle signature. The worker compiles the
  // tokenizer outside it when that is the case.
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
      reject(new Error('the memory worker was not ready in time'))
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
        reject(new Error(`the memory worker exited while starting (code ${code})`))
      }
      failAll(`the memory worker exited (code ${code})`)
      pushLog(`[memory] worker exited (code ${code})${asked ? ' (idle)' : ''}`)
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
  failAll('memory worker exited')
  try {
    proc.postMessage({ cmd: 'shutdown' })
  } catch {
    // process already dead
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

/**
 * The worker is up right now. Features that are only a bonus (skill suggestions) use this
 * as their criterion instead of `modelInstalled()`: the worker shuts down after 5 idle
 * minutes and waking it costs ~400 MB of RSS plus latency — not worth it for a hint.
 */
export function workerActive(): boolean {
  return embeddingsEnabled() && Boolean(child && ready)
}

/** Embeds one text for the turn. `wake: false` never starts the worker; null = no vector. */
export type TurnEmbedder = (text: string, options?: { wake?: boolean }) => Promise<Float32Array | null>

/**
 * One query vector per turn, shared by everything that searches with the message
 * (memory, skills): the same text is embedded once, however many consumers ask.
 */
export function createTurnEmbedder(): TurnEmbedder {
  const done = new Map<string, Promise<Float32Array | null>>()
  return (text, options = {}) => {
    const hit = done.get(text)
    if (hit) return hit
    if (!embeddingsEnabled()) return Promise.resolve(null)
    if (options.wake === false && !workerActive()) return Promise.resolve(null)
    const run = embedTexts([text]).then(([vec]) => vec ?? null).catch(() => null)
    done.set(text, run)
    return run
  }
}

/** Vectors for a list of texts. Throws when the model is not available. */
export async function embedTexts(texts: string[]): Promise<Float32Array[]> {
  if (texts.length === 0) return []
  if (!embeddingsEnabled()) throw new Error('embeddings are turned off')
  await startWorker()
  clearIdle()
  return new Promise<Float32Array[]>((resolve, reject) => {
    const id = randomUUID()
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error('the memory worker stopped responding'))
    }, STALL_TIMEOUT_MS)
    pending.set(id, { resolve, reject, timer })
    child?.postMessage({ id, cmd: 'embed', texts })
  })
}

// ---------------------------------------------------------------------------
// Persisted index
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

/** In-memory index. A payload from another model/schema is discarded entirely. */
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
    // corrupted index: starts empty and reindexes in the background
  }
  cache = emptyIndex()
  return cache
}

let decoded: { payload: VectorsPayload; map: Map<string, Float32Array> } | null = null

/**
 * Decoded vectors. Memoized by the index object: as long as nobody writes over it
 * (syncIndex), the same table is reused on every turn.
 */
export async function vectorsById(): Promise<Map<string, Float32Array>> {
  if (!embeddingsEnabled()) return new Map()
  const index = await loadIndex()
  if (decoded && decoded.payload === index) return decoded.map
  const map = new Map<string, Float32Array>()
  for (const [id, item] of Object.entries(index.items)) map.set(id, decode(item.vec))
  decoded = { payload: index, map }
  return map
}

/** Signature of the whole pool — it changes when any memory changes. */
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
 * Brings the index up to date with the pool: removes what is gone and embeds only what
 * changed. Runs in the background (the caller must not wait), in batches, so that
 * a large reindex does not hold up the process or flood the worker.
 */
export async function syncIndex(memories: Memory[], options: { batch?: number } = {}): Promise<SyncResult> {
  if (!embeddingsEnabled()) return { indexed: 0, removed: 0, failed: false }
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
    // What was already embedded stays; the next call continues from here.
    console.error('[memory] indexing interrupted:', err)
    await writeJson(VECTORS_KEY, index).catch(() => {})
    return { indexed, removed, failed: true }
  }
}

/** Noise floor of the pool, stored together with the index (37 vectors per new pool). */
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
    enabled: embeddingsEnabled(),
    installed: modelInstalled(),
    running: Boolean(child && ready),
    indexed: valid,
    pending: memories.length - valid,
    model: MEMORY_MODEL_ID,
    dim: MEMORY_MODEL_DIM,
  }
}

/** Diagnostics of the worker's last lines (packaged app). */
export function embeddingLog(): string[] {
  return [...log]
}
