/**
 * Motor de embeddings da memória: onnxruntime-node DIRETO (sem transformers.js,
 * que duplicava a RAM nas medições) + tokenizer compacto (tokenizer.mjs).
 * Mesmo módulo no worker do app (worker.mjs) e no benchmark — o que se mede é o
 * que roda em produção.
 *
 * Saída: vetor float32 com pooling por média e normalizado em L2, truncado para
 * `dim` dimensões (Matryoshka) e renormalizado.
 */
import path from "node:path"
import { createRequire } from "node:module"
import { loadTokenizer } from "./tokenizer.mjs"

export const MODELS = {
  a8m: { repo: "hotchpotch/bekko-embedding-v1-a8m", bytes: 130099079 },
  a25m: { repo: "hotchpotch/bekko-embedding-v1-a25m", bytes: 199300251 },
}

function l2(v) {
  let s = 0
  for (let i = 0; i < v.length; i++) s += v[i] * v[i]
  const n = Math.sqrt(s) || 1
  for (let i = 0; i < v.length; i++) v[i] /= n
  return v
}

/**
 * @param {{ modelPath: string, tokenizerPath: string, dim?: number, maxTokens?: number,
 *           ortModule?: string, threads?: number }} opts
 */
export async function createEmbedder(opts) {
  const ort = opts.ortModule
    ? await import(opts.ortModule)
    : createRequire(import.meta.url)("onnxruntime-node")
  const tok = loadTokenizer(opts.tokenizerPath)
  const session = await ort.InferenceSession.create(opts.modelPath, {
    graphOptimizationLevel: "all",
    // Sem arena: o padrão reserva blocos que nunca devolve ao SO (medido: ~+100 MB).
    enableCpuMemArena: false,
    intraOpNumThreads: opts.threads ?? 2,
  })
  const maxTokens = opts.maxTokens ?? 512
  const dim = opts.dim ?? 256

  async function embedOne(text) {
    const ids = tok.encode(text, maxTokens)
    const n = ids.length
    const input_ids = new ort.Tensor("int64", BigInt64Array.from(ids, BigInt), [1, n])
    const attention_mask = new ort.Tensor("int64", new BigInt64Array(n).fill(1n), [1, n])
    const out = await session.run({ input_ids, attention_mask })
    const h = out.last_hidden_state
    const H = h.dims[2]
    const data = h.data
    const v = new Float32Array(H)
    for (let t = 0; t < n; t++) for (let k = 0; k < H; k++) v[k] += data[t * H + k]
    for (let k = 0; k < H; k++) v[k] /= n
    // Matryoshka: fatia os primeiros `dim` componentes e renormaliza.
    return l2(v.slice(0, Math.min(dim, H)))
  }

  return {
    dim,
    tokenizerBytes: tok.bytes,
    async embed(texts) {
      const res = []
      for (const t of texts) res.push(await embedOne(t))
      return res
    },
    async dispose() {
      await session.release?.()
    },
  }
}

export function modelFiles(root, id) {
  const dir = path.join(root, id)
  return { modelPath: path.join(dir, "onnx", "model.onnx"), tokenizerJson: path.join(dir, "tokenizer.json"), tokenizerPath: path.join(dir, "tokenizer.bin") }
}
