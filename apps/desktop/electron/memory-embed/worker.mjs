/**
 * Worker de embeddings da memória: processo filho do main (utilityProcess) que
 * roda o Bekko no onnxruntime-node direto (sem transformers.js — ele duplicava
 * a RAM nas medições).
 *
 * Por que processo separado: carregar ~130 MB de ONNX e rodar inferência no
 * thread do main congelaria janelas e IPC. Aqui o pico de memória (~400 MB) não
 * é o do app e o processo pode ser morto por ociosidade, devolvendo tudo.
 *
 * Protocolo (lib/memory/embedding.ts):
 *   entrada: { id, cmd: "embed", texts: string[] }
 *            { cmd: "status" } | { cmd: "shutdown" }
 *   saída:   { type: "ready", model, dim, loadMs, tokenizerBytes }
 *            { type: "error", message, fatal? }
 *            { id, done: true, vectors: string[], ms }   // base64 float32
 *            { id, done: true, error: "..." }
 *
 * O vetor vai em base64 porque é pequeno (256 floats = 1 KB) e atravessa o
 * MessagePort sem depender de clone de typed array.
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
/** Modelo dentro do app assinado: a pasta dele não pode ser escrita. */
const READONLY = arg('readonly', '0') === '1'

let embedder = null
let booting = null

const toBase64 = (vec) => Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength).toString('base64')

/**
 * Devolve o `tokenizer.bin`, compilando-o do `.json` na primeira execução (o
 * JSON de 34 MB não é lido no runtime).
 *
 * Quando o modelo veio dentro do app, compilar ao lado dele invalidaria a
 * assinatura do bundle — e o macOS passa a tratar o app como adulterado. Nesse
 * caso o binário vai para o temporário, com nome estável por modelo para não
 * recompilar a cada execução.
 */
function ensureTokenizer(dir) {
  const bin = path.join(dir, 'tokenizer.bin')
  if (fs.existsSync(bin)) return bin
  const json = path.join(dir, 'tokenizer.json')
  if (!fs.existsSync(json)) throw new Error(`tokenizer.json ausente em ${dir}`)
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
    if (!MODEL_DIR) throw new Error('pasta do modelo não informada (--dir)')
    const modelPath = path.join(MODEL_DIR, 'onnx', 'model.onnx')
    if (!fs.existsSync(modelPath)) throw new Error(`modelo ausente em ${modelPath}`)
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
      // o processo vai morrer de qualquer forma
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
      // Um texto por vez de propósito: o batch do Bekko não reduz o custo
      // (o modelo é pequeno) e o laço mantém o pico de memória previsível.
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

// O main manda "embed" e o modelo sobe na primeira chamada — mas subir antes
// evita pagar a leitura do ONNX na primeira pergunta do usuário.
boot().catch((err) => send({ type: 'error', message: String(err?.message ?? err), fatal: true }))
