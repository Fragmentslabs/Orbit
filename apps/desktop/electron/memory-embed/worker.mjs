/**
 * Memory embedding worker: child process of the main (utilityProcess) that
 * runs Bekko on onnxruntime-node directly (without transformers.js — it duplicated
 * the RAM in the measurements).
 *
 * Why a separate process: loading ~130 MB of ONNX and running inference on
 * the main thread would freeze windows and IPC. Here the memory peak (~400 MB) is not
 * the app's and the process can be killed for idleness, giving everything back.
 *
 * Protocol (lib/memory/embedding.ts):
 *   input:  { id, cmd: "embed", texts: string[] }
 *            { cmd: "status" } | { cmd: "shutdown" }
 *   output:  { type: "ready", model, dim, loadMs, tokenizerBytes }
 *            { type: "error", message, fatal? }
 *            { id, done: true, vectors: string[], ms }   // base64 float32
 *            { id, done: true, error: "..." }
 *
 * The vector goes in base64 because it is small (256 floats = 1 KB) and crosses the
 * MessagePort without depending on a typed array clone.
 */

import fs from 'fs'
import os from 'os'
import path from 'path'
import { createEmbedder } from './engine.mjs'
import { compileTokenizer } from './tokenizer.mjs'

const parentPort = process.parentPort
const send = (msg) => parentPort.postMessage(msg)

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const MODEL_ID = arg('model', 'bekko-a8m')
const MODEL_DIR = arg('dir', '')
const DIM = Number(arg('dim', '256'))
const THREADS = Number(arg('threads', '2'))
/** Model inside the signed app: its folder cannot be written. */
const READONLY = arg('readonly', '0') === '1'

let embedder = null
let booting = null

const toBase64 = (vec) => Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength).toString('base64')

/**
 * Returns the `tokenizer.bin`, compiling it from the `.json` on the first run (the
 * 34 MB JSON is not read at runtime).
 *
 * When the model came inside the app, compiling next to it would invalidate the
 * signature of the bundle — and macOS starts treating the app as tampered with. In that
 * case the binary goes to the temporary folder, with a name stable per model so it does not
 * recompile on every run.
 */
function ensureTokenizer(dir) {
  const bin = path.join(dir, 'tokenizer.bin')
  if (fs.existsSync(bin)) return bin
  const json = path.join(dir, 'tokenizer.json')
  if (!fs.existsSync(json)) throw new Error(`tokenizer.json missing in ${dir}`)
  const target = READONLY
    ? path.join(os.tmpdir(), 'orbit-memory-embed', `${path.basename(dir)}-tokenizer.bin`)
    : bin
  if (!fs.existsSync(target)) {
    fs.mkdirSync(path.dirname(target), { recursive: true })
    compileTokenizer(json, target)
  }
  return target
}

async function boot() {
  if (embedder) return embedder
  if (booting) return booting
  booting = (async () => {
    const t0 = Date.now()
    if (!MODEL_DIR) throw new Error('model folder not given (--dir)')
    const modelPath = path.join(MODEL_DIR, 'onnx', 'model.onnx')
    if (!fs.existsSync(modelPath)) throw new Error(`model missing in ${modelPath}`)
    const tokenizerPath = ensureTokenizer(MODEL_DIR)
    embedder = await createEmbedder({ modelPath, tokenizerPath, dim: DIM, threads: THREADS })
    send({ type: 'ready', model: MODEL_ID, dim: embedder.dim, loadMs: Date.now() - t0, tokenizerBytes: embedder.tokenizerBytes })
    return embedder
  })().finally(() => {
    booting = null
  })
  return booting
}

parentPort.on('message', async (event) => {
  const msg = event?.data ?? event
  if (!msg || typeof msg !== 'object') return

  if (msg.cmd === 'shutdown') {
    try {
      await embedder?.dispose()
    } catch {
      // the process is going to die anyway
    }
    process.exit(0)
  }

  if (msg.cmd === 'status') {
    send({ type: 'status', model: MODEL_ID, ready: Boolean(embedder), dir: MODEL_DIR })
    return
  }

  if (msg.cmd === 'embed' && msg.id) {
    try {
      const engine = await boot()
      const t0 = Date.now()
      const vectors = []
      // One text at a time on purpose: the Bekko batch does not reduce the cost
      // (the model is small) and the loop keeps the memory peak predictable.
      for (const text of msg.texts ?? []) {
        const [vec] = await engine.embed([String(text ?? '')])
        vectors.push(toBase64(vec))
      }
      send({ id: msg.id, done: true, vectors, ms: Date.now() - t0 })
    } catch (err) {
      send({ id: msg.id, done: true, error: String(err?.message ?? err) })
    }
  }
})

parentPort.start()

// The main sends "embed" and the model comes up on the first call — but coming up before
// avoids paying for reading the ONNX on the user's first question.
boot().catch((err) => send({ type: 'error', message: String(err?.message ?? err), fatal: true }))
