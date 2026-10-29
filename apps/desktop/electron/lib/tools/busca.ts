/**
 * Busca lexical no catálogo de tools — BM25 com coverage gate.
 *
 * Por que BM25 antes de embedding: o vocabulário de tools é curto e cheio de
 * identificadores (`pdf_extract_images`), exatamente o caso em que lexical
 * ganha. Embedding só se medir perda — e medir exige a telemetria de desfecho
 * (ver `carregar.ts`).
 */

export interface RegistroBusca {
  nome: string
  /** Nome + descrição + nomes de argumentos, já em texto plano. */
  texto: string
}

export interface ResultadoBusca {
  nome: string
  score: number
}

const K1 = 1.5
const B = 0.75
/** ≥ 50% dos termos da query presentes. */
const COBERTURA_MINIMA = 0.5
/** Cobertura só é exigida a partir de 4 termos — senão "pdf" sozinho cai. */
const TERMOS_PARA_EXIGIR_COBERTURA = 4
export const MAX_QUERIES_POR_CHAMADA = 7

/**
 * Tokeniza de forma estável: minúsculas, sem acento, e `_` preservado porque
 * `pdf_extract_images` é UM identificador, não três palavras.
 */
export function termosDe(texto: string): string[] {
  return texto
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z0-9_]+/)
    .filter((t) => t.length >= 2)
}

/** BM25 clássico sobre uma lista de termos de documento já tokenizada. */
function bm25(
  query: string[],
  doc: string[],
  df: ReadonlyMap<string, number>,
  totalDocs: number,
  tamanhoMedio: number,
): number {
  if (doc.length === 0 || tamanhoMedio === 0) return 0
  const frequencias = new Map<string, number>()
  for (const termo of doc) frequencias.set(termo, (frequencias.get(termo) ?? 0) + 1)
  let score = 0
  for (const termo of query) {
    const tf = frequencias.get(termo) ?? 0
    if (tf === 0) continue
    const n = df.get(termo) ?? 0
    const idf = Math.log(1 + (totalDocs - n + 0.5) / (n + 0.5))
    const denominador = tf + K1 * (1 - B + (B * doc.length) / tamanhoMedio)
    score += idf * ((tf * (K1 + 1)) / denominador)
  }
  return score
}

/**
 * Busca em várias queries de uma vez (até 7, como o Hermes — o limite vem do
 * custo de uma chamada com muitas queries, medida lá).
 *
 * Regras:
 * - **Nome exato primeiro.** Buscar `pdf_extract_images` não pode devolver
 *   oito vizinhos com score parecido; o casamento exato sobe para o topo.
 * - **Coverage gate** reduz falso positivo em query longa.
 */
export function buscar(
  registros: readonly RegistroBusca[],
  queries: readonly string[],
  limite = 5,
): ResultadoBusca[] {
  if (registros.length === 0) return []
  const docs = registros.map((registro) => ({ registro, tokens: termosDe(registro.texto) }))
  const totalDocs = docs.length
  const df = new Map<string, number>()
  for (const doc of docs) {
    for (const termo of new Set(doc.tokens)) df.set(termo, (df.get(termo) ?? 0) + 1)
  }
  const tamanhoMedio = docs.reduce((soma, doc) => soma + doc.tokens.length, 0) / totalDocs
  const melhor = new Map<string, number>()

  for (const query of queries.slice(0, MAX_QUERIES_POR_CHAMADA)) {
    const termos = termosDe(query)
    if (termos.length === 0) continue
    for (const doc of docs) {
      const presentes = new Set(doc.tokens)
      const cobertos = termos.filter((t) => presentes.has(t)).length
      if (
        termos.length >= TERMOS_PARA_EXIGIR_COBERTURA &&
        cobertos / termos.length < COBERTURA_MINIMA
      ) {
        continue
      }
      const score = bm25(termos, doc.tokens, df, totalDocs, tamanhoMedio)
      if (score > 0) melhor.set(doc.registro.nome, Math.max(melhor.get(doc.registro.nome) ?? 0, score))
    }
  }

  const exatos = new Set(queries.map((q) => q.trim().toLowerCase()))
  return [...melhor.entries()]
    .map(([nome, score]) => ({ nome, score }))
    .sort(
      (a, b) =>
        Number(exatos.has(b.nome.toLowerCase())) - Number(exatos.has(a.nome.toLowerCase())) ||
        b.score - a.score ||
        a.nome.localeCompare(b.nome),
    )
    .slice(0, Math.max(1, Math.min(50, Math.floor(limite))))
}
