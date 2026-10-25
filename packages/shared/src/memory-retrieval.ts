/**
 * Recuperação de memórias: peças puras (sem I/O, sem Electron) compartilhadas
 * entre o main, o renderer e o benchmark.
 *
 *  - texto de índice enriquecido por memória (`buildRetrievalText`)
 *  - busca lexical BM25 sobre campos, com tokenização Unicode independente de
 *    idioma (sem stopwords nem stemming de um idioma só: o IDF já rebaixa o que
 *    aparece em todo lugar)
 *  - fusão de rankings por Reciprocal Rank Fusion
 *
 * A busca semântica (embeddings) vive no main; aqui só existem as funções que
 * não dependem do modelo.
 */

import type { Memory } from "./memory"

// ---------------------------------------------------------------------------
// Texto e tokens
// ---------------------------------------------------------------------------

/**
 * Minúsculas + NFKC + sem diacríticos, mas só em alfabetos que os dispensam
 * (latino, cirílico, grego): arrancar marcas de kana (dakuten) ou de devanágari
 * muda a palavra.
 */
export function foldText(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .normalize("NFD")
    .replace(/(?<=[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}])\p{M}+/gu, "")
    .normalize("NFC")
}

/** Escritas sem espaço entre palavras: viram bigramas de caractere. */
const UNSEGMENTED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]+/gu
const WORD = /[\p{L}\p{N}\p{M}]+(?:[-_./][\p{L}\p{N}\p{M}]+)*/gu

/**
 * Tokens de busca. Identificadores com número ("ATL-2291", "v2.3.1", "SF-88213")
 * entram inteiros E divididos; texto sem espaço (japonês, chinês, tailandês…)
 * entra como bigramas.
 */
export function lexTokens(text: string): string[] {
  const out: string[] = []
  const folded = foldText(text)
  for (const match of folded.matchAll(WORD)) {
    const word = match[0]
    const parts = word.split(/[-_./]/)
    if (parts.length > 1 && /\p{N}/u.test(word)) out.push(word)
    for (const part of parts) pushPart(part, out)
  }
  return out
}

function pushPart(part: string, out: string[]) {
  let last = 0
  for (const m of part.matchAll(UNSEGMENTED)) {
    const before = part.slice(last, m.index)
    if (before.length >= 2 || /\p{N}/u.test(before)) out.push(before)
    const run = [...m[0]]
    if (run.length === 1) out.push(run[0])
    for (let i = 0; i < run.length - 1; i++) out.push(run[i] + run[i + 1])
    last = (m.index ?? 0) + m[0].length
  }
  const rest = part.slice(last)
  if (rest.length >= 2 || (rest.length === 1 && /\p{N}/u.test(rest))) out.push(rest)
}

// ---------------------------------------------------------------------------
// Campos derivados da memória (enriquecimento)
// ---------------------------------------------------------------------------

/**
 * Versão do esquema do texto de índice. Subir este número invalida os vetores
 * de todas as memórias (o indexador reprocessa em segundo plano).
 */
export const INDEX_SCHEMA_VERSION = 1

/** Teto do texto de índice — mantém o custo de embedding e de índice controlado. */
export const RETRIEVAL_TEXT_MAX_CHARS = 700

type IndexSource = Pick<Memory, "text" | "tags"> &
  Partial<Pick<Memory, "title" | "summary" | "entities" | "keywords" | "concepts">>

const clean = (s: string) => s.replace(/\s+/g, " ").trim()

/** Título curto. O do LLM manda; sem ele, a primeira oração do texto. */
export function deriveTitle(memory: IndexSource): string {
  if (memory.title?.trim()) return clean(memory.title)
  const first = clean(memory.text)
    .split(/(?<=[.!?。！？])\s|\n/)[0]
    ?.replace(/[.!?。！？]+$/, "") ?? ""
  return first.length > 80 ? `${first.slice(0, 77).trimEnd()}…` : first
}

/**
 * Entidades. As do LLM mandam; sem elas, uma heurística conservadora e sem
 * idioma específico: identificadores com dígito/hífen/ponto e sequências de
 * palavras Capitalizadas fora do início de frase. Não inventa nada: só devolve
 * trechos que já estão no texto.
 */
export function deriveEntities(memory: IndexSource): string[] {
  if (memory.entities?.length) return unique(memory.entities.map(clean).filter(Boolean)).slice(0, 12)
  const found: string[] = []
  const text = memory.text
  for (const m of text.matchAll(/\b[\p{L}\p{N}]+(?:[-_./][\p{L}\p{N}]+)+\b/gu)) {
    if (/\p{N}/u.test(m[0])) found.push(m[0])
  }
  const sentenceStart = /(^|[.!?。！？]\s+|\n)$/
  for (const m of text.matchAll(/\p{Lu}[\p{L}\p{N}]*(?:\s+\p{Lu}[\p{L}\p{N}]*)*/gu)) {
    const before = text.slice(0, m.index ?? 0)
    if (sentenceStart.test(before) && !m[0].includes(" ")) continue
    if (m[0].length >= 3) found.push(m[0])
  }
  return unique(found).slice(0, 12)
}

/** Palavras-chave: as do LLM, mais as tags. */
export function deriveKeywords(memory: IndexSource): string[] {
  return unique([...(memory.keywords ?? []), ...memory.tags].map(clean).filter(Boolean)).slice(0, 16)
}

function unique(items: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of items) {
    const key = foldText(item)
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(item)
  }
  return out
}

/**
 * Representação consolidada para o embedding: título, conteúdo original,
 * entidades, palavras-chave e conceitos. Rótulos de idioma ficam de fora de
 * propósito (a memória pode estar em qualquer língua); o que não está na
 * memória não entra. O conteúdo original é sempre preservado por inteiro e os
 * extras são cortados primeiro quando passa do teto.
 */
export function buildRetrievalText(memory: IndexSource, options: { extras?: boolean } = {}): string {
  const text = clean(memory.text)
  if (options.extras === false) return text
  const title = deriveTitle(memory)
  // O corte do sufixo tem de vir ANTES de dobrar: o foldText passa por NFKC, e
  // NFKC transforma "…" em "...". Comparando depois, o título derivado (que
  // termina em "…") nunca era reconhecido como parte do texto.
  const head = title && foldText(text).includes(foldText(title.replace(/…$/, ""))) ? "" : title
  const extras: string[] = []
  const seen = new Set(lexTokens(`${head} ${text}`))
  const novel = (items: string[]) => items.filter((item) => lexTokens(item).some((t) => !seen.has(t)))
  for (const group of [novel(deriveEntities(memory)), novel(deriveKeywords(memory)), novel(memory.concepts ?? [])]) {
    if (group.length === 0) continue
    extras.push(group.join(", "))
    for (const item of group) for (const t of lexTokens(item)) seen.add(t)
  }
  const parts = [memory.summary && memory.summary !== memory.text ? clean(memory.summary) : "", ...extras]
  // O texto é o conteúdo e entra SEMPRE inteiro. O teto existe para o
  // enriquecimento não diluir o vetor, nunca para cortar o fato: antes, um
  // título que não coubesse junto do texto fazia o índice guardar só o título.
  let out = head ? `${head}. ${text}` : text
  for (const part of parts) {
    if (!part) continue
    const next = `${out}. ${part}`
    if (next.length > RETRIEVAL_TEXT_MAX_CHARS) break
    out = next
  }
  return out
}

/** Hash FNV-1a (53 bits) — barato, estável, suficiente para invalidar vetores. */
export function hashString(input: string): string {
  let h1 = 0xdeadbeef ^ 0
  let h2 = 0x41c6ce57 ^ 0
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)
}

/**
 * Assinatura do que alimenta o vetor de uma memória. Mudou conteúdo, campos de
 * enriquecimento, esquema, modelo ou dimensões ⇒ a assinatura muda ⇒ o vetor é
 * elegível para reindexação.
 */
export function indexSignature(memory: IndexSource, model: { id: string; dim: number }): string {
  return hashString(`${INDEX_SCHEMA_VERSION}|${model.id}|${model.dim}|${buildRetrievalText(memory)}`)
}

// ---------------------------------------------------------------------------
// BM25 sobre campos
// ---------------------------------------------------------------------------

export interface LexicalDoc {
  id: string
  /** Conteúdo original + título (peso base) */
  text: string
  /** Tags, palavras-chave e entidades (pesam mais) */
  boosted?: string
  /** Conceitos e paráfrases (peso base) */
  concepts?: string
  /** Documento markdown anexado (peso base; é o que torna o .md encontrável) */
  body?: string
}

export interface Bm25Options {
  k1?: number
  b?: number
  /** Peso de cada campo na frequência do termo */
  weights?: { text?: number; boosted?: number; concepts?: number; body?: number }
}

export interface ScoredId {
  id: string
  score: number
}

/**
 * Documento lexical de uma memória: o mesmo recorte para o índice e para os
 * testes. `doc` é o markdown anexado, quando existe — sem ele o documento é
 * idêntico ao de antes.
 */
export function lexicalDocOf(memory: Memory & Partial<IndexSource>, doc?: string | null): LexicalDoc {
  return {
    id: memory.id,
    text: `${deriveTitle(memory)} ${memory.text}`,
    boosted: [...deriveKeywords(memory), ...deriveEntities(memory)].join(" "),
    concepts: (memory.concepts ?? []).join(" "),
    body: doc ? clean(doc) : undefined,
  }
}

export class Bm25Index {
  private readonly k1: number
  private readonly b: number
  private readonly postings = new Map<string, Array<[number, number]>>()
  private readonly lengths: number[] = []
  private readonly ids: string[] = []
  private avgLen = 0

  constructor(docs: LexicalDoc[], options: Bm25Options = {}) {
    this.k1 = options.k1 ?? 1.2
    this.b = options.b ?? 0.75
    const w = { text: 1, boosted: 2, concepts: 1, body: 1, ...options.weights }
    let total = 0
    docs.forEach((doc, index) => {
      const tf = new Map<string, number>()
      const add = (text: string | undefined, weight: number) => {
        if (!text) return
        for (const t of lexTokens(text)) tf.set(t, (tf.get(t) ?? 0) + weight)
      }
      add(doc.text, w.text)
      add(doc.boosted, w.boosted)
      add(doc.concepts, w.concepts)
      add(doc.body, w.body)
      let len = 0
      for (const [token, freq] of tf) {
        len += freq
        const list = this.postings.get(token)
        if (list) list.push([index, freq])
        else this.postings.set(token, [[index, freq]])
      }
      this.ids.push(doc.id)
      this.lengths.push(len)
      total += len
    })
    this.avgLen = docs.length ? total / docs.length : 0
  }

  get size(): number {
    return this.ids.length
  }

  /**
   * Massa de IDF da consulta (termos desconhecidos contam como os mais raros):
   * o denominador da "cobertura" — quanto do que se perguntou o documento tem.
   */
  queryMass(query: string): number {
    const n = this.ids.length
    let mass = 0
    for (const token of new Set(lexTokens(query))) {
      const df = this.postings.get(token)?.length ?? 0
      mass += Math.log(1 + (n - df + 0.5) / (df + 0.5))
    }
    return mass
  }

  search(query: string, limit = 20): ScoredId[] {
    const n = this.ids.length
    if (n === 0) return []
    const scores = new Map<number, number>()
    for (const token of new Set(lexTokens(query))) {
      const list = this.postings.get(token)
      if (!list) continue
      const idf = Math.log(1 + (n - list.length + 0.5) / (list.length + 0.5))
      for (const [doc, freq] of list) {
        const norm = 1 - this.b + (this.b * this.lengths[doc]) / (this.avgLen || 1)
        const s = (idf * freq * (this.k1 + 1)) / (freq + this.k1 * norm)
        scores.set(doc, (scores.get(doc) ?? 0) + s)
      }
    }
    return [...scores]
      .map(([doc, score]) => ({ id: this.ids[doc], score }))
      .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1))
      .slice(0, limit)
  }
}

// ---------------------------------------------------------------------------
// Fusão
// ---------------------------------------------------------------------------

export interface RankedList {
  ids: string[]
  weight?: number
}

/**
 * Reciprocal Rank Fusion: score(id) = Σ peso / (k + posição). Opera só sobre
 * posições, então não mistura a escala do cosseno com a do BM25 — que não são
 * comparáveis. k=60 é o valor clássico (Cormack et al., 2009).
 */
export function reciprocalRankFusion(lists: RankedList[], k = 60): ScoredId[] {
  const scores = new Map<string, number>()
  for (const list of lists) {
    const weight = list.weight ?? 1
    list.ids.forEach((id, position) => {
      scores.set(id, (scores.get(id) ?? 0) + weight / (k + position + 1))
    })
  }
  return [...scores]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1))
}

// ---------------------------------------------------------------------------
// Vetores
// ---------------------------------------------------------------------------

export function dot(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let s = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) s += a[i] * b[i]
  return s
}
