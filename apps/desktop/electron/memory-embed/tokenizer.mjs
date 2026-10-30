/**
 * Lean BPE tokenizer for Bekko (256k-token vocabulary, Gemma style).
 *
 * Why not load tokenizer.json (34 MB): parsing it creates ~580 thousand
 * merge strings and hundreds of MB of heap. Here tokenizer.json is compiled
 * ONCE into a compact binary (tokenizer.bin) and the runtime reads only typed
 * arrays — the merges become (numeric key → rank, merged id), without strings.
 *
 * Equivalence: Replace normalizer (" "→"▁") + Metaspace(prepend always,
 * split) + BPE with byte fallback + <bos> … <eos>. Checked against
 * transformers.js in tokenizer.test.ts (when tokenizer.json exists).
 */
import fs from "node:fs"

const MAGIC = 0x4f425431 // "OBT1"
const SPACE = "▁"

/** Compiles the Hugging Face tokenizer.json into the compact binary format. */
export function compileTokenizer(jsonPath, outPath) {
  const t = JSON.parse(fs.readFileSync(jsonPath, "utf8"))
  const vocab = t.model.vocab // { token: id }
  let V = 0
  for (const id of Object.values(vocab)) if (id >= V) V = id + 1
  const chars = []
  for (const [tok, id] of Object.entries(vocab)) {
    const cps = [...tok]
    if (cps.length === 1) chars.push([cps[0].codePointAt(0), id])
  }
  chars.sort((a, b) => a[0] - b[0])
  const byteIds = new Int32Array(256).fill(-1)
  for (let b = 0; b < 256; b++) {
    const id = vocab[`<0x${b.toString(16).toUpperCase().padStart(2, "0")}>`]
    if (id != null) byteIds[b] = id
  }
  const rows = []
  t.model.merges.forEach((m, rank) => {
    const [a, b] = Array.isArray(m) ? m : m.split(" ")
    const ia = vocab[a], ib = vocab[b], im = vocab[a + b]
    if (ia != null && ib != null && im != null) rows.push([ia * V + ib, rank, im])
  })
  rows.sort((x, y) => x[0] - y[0])
  const n = rows.length
  const added = Buffer.from(JSON.stringify(t.added_tokens.map((a) => [a.content, a.id])))
  const head = new Int32Array([MAGIC, V, chars.length, n, t.model.unk_token ? vocab[t.model.unk_token] : 3, 2, 1, added.length])
  const cp = Int32Array.from(chars, (c) => c[0])
  const ci = Int32Array.from(chars, (c) => c[1])
  const keys = new Float64Array(n), ranks = new Int32Array(n), merged = new Int32Array(n)
  rows.forEach((r, i) => { keys[i] = r[0]; ranks[i] = r[1]; merged[i] = r[2] })
  const buf = Buffer.concat([head, cp, ci, byteIds, ranks, merged].map((a) => Buffer.from(a.buffer, a.byteOffset, a.byteLength)).concat([Buffer.from(keys.buffer), added]))
  fs.writeFileSync(outPath, buf)
  return { bytes: buf.length, merges: n, vocab: V }
}

/** Loads the binary. No copies: the typed arrays point to a single Buffer. */
export function loadTokenizer(binPath) {
  const buf = fs.readFileSync(binPath)
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  const head = new Int32Array(ab, 0, 8)
  if (head[0] !== MAGIC) throw new Error("invalid tokenizer.bin")
  const [, V, nc, n, UNK, BOS, EOS, addedLen] = head
  let off = 32
  const take = (Ctor, len) => { const a = new Ctor(ab, off, len); off += len * Ctor.BYTES_PER_ELEMENT; return a }
  const cp = take(Int32Array, nc), ci = take(Int32Array, nc), byteIds = take(Int32Array, 256)
  const ranks = take(Int32Array, n), merged = take(Int32Array, n)
  if (off % 8) off += 8 - (off % 8)
  const keys = new Float64Array(ab, off, n)
  // Added tokens (\n, \n\n…, <pad>, HTML tags…): they match in the raw text, before the BPE.
  const addedList = JSON.parse(Buffer.from(ab, off + n * 8, addedLen).toString("utf8"))
  const addedId = new Map(addedList)
  const addedRe = new RegExp(
    `(${addedList.map(([c]) => c).sort((a, b) => b.length - a.length).map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`,
  )

  const charId = (code) => {
    let lo = 0, hi = nc - 1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (cp[mid] === code) return ci[mid]
      if (cp[mid] < code) lo = mid + 1; else hi = mid - 1
    }
    return -1
  }
  const find = (key) => {
    let lo = 0, hi = n - 1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      const k = keys[mid]
      if (k === key) return mid
      if (k < key) lo = mid + 1; else hi = mid - 1
    }
    return -1
  }
  const enc = new TextEncoder()

  function bpeWord(word) {
    let ids = []
    for (const ch of word) {
      const id = charId(ch.codePointAt(0))
      if (id >= 0) ids.push(id)
      else for (const b of enc.encode(ch)) ids.push(byteIds[b] >= 0 ? byteIds[b] : UNK)
    }
    while (ids.length > 1) {
      let best = -1, bestRank = 0x7fffffff
      for (let i = 0; i < ids.length - 1; i++) {
        const j = find(ids[i] * V + ids[i + 1])
        if (j >= 0 && ranks[j] < bestRank) { bestRank = ranks[j]; best = i }
      }
      if (best < 0) break
      const j = find(ids[best] * V + ids[best + 1])
      ids.splice(best, 2, merged[j])
    }
    return ids
  }

  /** Ids with <bos> … <eos>, truncated at `maxTokens` (keeping the <eos>). */
  function encode(text, maxTokens = 512) {
    // Each snippet between added tokens is pre-tokenized separately: it gets "▁"
    // in front and, inside it, each "▁" starts a piece (Metaspace).
    const pieces = []
    for (const seg of text.split(addedRe)) {
      if (!seg) continue
      if (addedId.has(seg)) { pieces.push(seg); continue }
      const norm = seg.replaceAll(" ", SPACE)
      let cur = ""
      for (const ch of norm.startsWith(SPACE) ? norm : SPACE + norm) {
        if (ch === SPACE && cur) { pieces.push(cur); cur = "" }
        cur += ch
      }
      if (cur) pieces.push(cur)
    }
    const out = [BOS]
    for (const p of pieces) {
      if (addedId.has(p)) out.push(addedId.get(p))
      else for (const id of bpeWord(p)) out.push(id)
      if (out.length >= maxTokens) break
    }
    if (out.length > maxTokens - 1) out.length = maxTokens - 1
    out.push(EOS)
    return out
  }
  return { encode, vocabSize: V, bytes: buf.length }
}
