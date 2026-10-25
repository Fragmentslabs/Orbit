/**
 * Métricas da avaliação por JSON — puro, sem I/O, sem modelo.
 *
 * Regras que valem aqui e estão explicadas no guia:
 *
 * - Só entram nas métricas os resultados classificados como `relevant` ou
 *   `irrelevant`. `conclusive` (vazio) e `inconclusive` NUNCA contam como
 *   irrelevantes: eles saem do denominador.
 * - Consulta sem nenhum julgamento não entra na média.
 * - Precision@5 é a média, por consulta, de relevantes / julgados no top 5.
 * - MRR é a média de 1/posição do primeiro `relevant`; se a consulta foi
 *   julgada e não tem nenhum relevante, vale 0.
 * - Consultas com `esperado: "nenhuma"` não entram em P@5 nem MRR: elas medem
 *   candidato indevido, que é outra pergunta.
 */

export type Classificacao = '' | 'relevant' | 'irrelevant' | 'inconclusive'

export interface ReviewHit {
  rank: number
  id: string
  score?: number
  cos?: number
  cobertura?: number
}

export interface ReviewMemoryEntry {
  texto?: string
  classificacao?: string
  obs?: string
}

export interface ReviewQueryJson {
  id: string
  tipo?: string
  esperado?: 'recuperar' | 'nenhuma'
  lexical?: { top5?: ReviewHit[] }
  hibrido?: { top5?: ReviewHit[] }
  memorias?: Record<string, ReviewMemoryEntry>
}

export type Mechanism = 'lexical' | 'hibrido'

export interface MechanismScore {
  /** consultas com `esperado: recuperar` */
  consultas: number
  /** consultas com ao menos um julgamento — base das médias */
  avaliadas: number
  p5: number
  mrr: number
  /** fração das avaliadas com pelo menos um `relevant` no top 5 */
  hit5: number
  relevantes: number
  irrelevantes: number
  inconclusivos: number
  semJulgamento: number
}

export interface NoMemoryScore {
  consultas: number
  /** consultas em que o mecanismo devolveu algum resultado */
  retornou: number
  /** resultados marcados `relevant` em consulta que não deveria recuperar nada */
  marcouRelevante: number
  conflitos: string[]
}

export interface Comparison {
  ambos: string[]
  soHibrido: string[]
  soLexical: string[]
  nenhum: string[]
}

function classe(q: ReviewQueryJson, id: string): Classificacao {
  const raw = (q.memorias?.[id]?.classificacao ?? '').trim()
  if (raw === 'relevant' || raw === 'irrelevant' || raw === 'inconclusive') return raw
  return ''
}

function hits(q: ReviewQueryJson, mech: Mechanism): ReviewHit[] {
  const list = mech === 'lexical' ? q.lexical?.top5 : q.hibrido?.top5
  return Array.isArray(list) ? list : []
}

export function scoreMechanism(queries: ReviewQueryJson[], mech: Mechanism): MechanismScore {
  const rows = queries.filter((q) => q.esperado !== 'nenhuma')
  const out: MechanismScore = {
    consultas: rows.length,
    avaliadas: 0,
    p5: 0,
    mrr: 0,
    hit5: 0,
    relevantes: 0,
    irrelevantes: 0,
    inconclusivos: 0,
    semJulgamento: 0,
  }
  let somaP5 = 0
  let somaMrr = 0
  let somaHit = 0

  for (const q of rows) {
    let judged = 0
    let relevant = 0
    let firstRelevant = 0
    for (const h of hits(q, mech).slice(0, 5)) {
      const c = classe(q, h.id)
      if (c === '') out.semJulgamento++
      else if (c === 'inconclusive') out.inconclusivos++
      else {
        judged++
        if (c === 'relevant') {
          relevant++
          if (!firstRelevant) firstRelevant = h.rank
        }
      }
    }
    out.relevantes += relevant
    out.irrelevantes += judged - relevant
    if (!judged) continue
    out.avaliadas++
    somaP5 += relevant / judged
    somaMrr += firstRelevant ? 1 / firstRelevant : 0
    somaHit += relevant > 0 ? 1 : 0
  }

  if (out.avaliadas) {
    out.p5 = somaP5 / out.avaliadas
    out.mrr = somaMrr / out.avaliadas
    out.hit5 = somaHit / out.avaliadas
  }
  return out
}

export function scoreNoMemory(queries: ReviewQueryJson[], mech: Mechanism): NoMemoryScore {
  const rows = queries.filter((q) => q.esperado === 'nenhuma')
  const out: NoMemoryScore = { consultas: rows.length, retornou: 0, marcouRelevante: 0, conflitos: [] }
  for (const q of rows) {
    const list = hits(q, mech).slice(0, 5)
    if (list.length) out.retornou++
    const relevantes = list.filter((h) => classe(q, h.id) === 'relevant')
    if (relevantes.length) {
      out.marcouRelevante += relevantes.length
      out.conflitos.push(q.id)
    }
  }
  return out
}

/** Em quais consultas cada mecanismo achou algo julgado relevante. */
export function compareMechanisms(queries: ReviewQueryJson[]): Comparison {
  const out: Comparison = { ambos: [], soHibrido: [], soLexical: [], nenhum: [] }
  for (const q of queries.filter((x) => x.esperado !== 'nenhuma')) {
    const lex = hits(q, 'lexical').some((h) => classe(q, h.id) === 'relevant')
    const hyb = hits(q, 'hibrido').some((h) => classe(q, h.id) === 'relevant')
    if (lex && hyb) out.ambos.push(q.id)
    else if (hyb) out.soHibrido.push(q.id)
    else if (lex) out.soLexical.push(q.id)
    else out.nenhum.push(q.id)
  }
  return out
}
