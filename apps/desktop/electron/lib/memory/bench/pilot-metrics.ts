/**
 * Triagem de rótulos e métricas do piloto — puro: sem modelo, sem I/O, sem
 * memórias reais. É a parte do avaliador que decide *quais* cenários entram em
 * cada denominador, e por isso precisa ser testável sozinha.
 *
 * Regra central: um cenário não revisado NUNCA é interpretado como "nenhuma
 * memória". Ele simplesmente não entra em nenhuma conta.
 */

/** Decisões aceitas como rótulo. Qualquer outra coisa = decisão ausente. */
export const DECISIONS = ['inject', 'pointer', 'none'] as const
export type Decision = (typeof DECISIONS)[number]

export interface LabelEntry {
  id: string
  memoryId: string | null
  query?: string
  decision?: string
  reason?: string
  role?: string
}

export interface QueueEntry {
  id: string
  memoryId: string | null
  role?: string
}

export interface Triage {
  /** entradas presentes no arquivo, incluindo as descartadas */
  total: number
  /** no lote, mas ausentes do arquivo (export omitiu) */
  notInFile: string[]
  /** no arquivo, sem consulta escrita */
  unreviewed: string[]
  /** marcados como inconclusivos pelo revisor */
  inconclusive: string[]
  /** id que não existe no lote (rótulo órfão de um lote anterior) */
  invalidId: string[]
  /** memória-alvo que não existe mais no acervo */
  invalidTarget: string[]
  /** revisados e válidos, mas sem decisão escolhida */
  missingDecision: string[]
  /** base do ranking: consulta + alvo válido */
  valid: LabelEntry[]
  /** base das métricas de decisão: válidos e com decisão */
  decided: LabelEntry[]
}

/**
 * Separa os rótulos em conjuntos explícitos. A ordem das checagens importa:
 * id órfão é descartado antes de tudo (não sabemos a qual cenário pertence),
 * consulta vazia é "não revisado", e alvo inexistente é erro de dados.
 */
export function triage(labels: LabelEntry[], queue: QueueEntry[], corpusIds: Set<string>): Triage {
  const byId = new Map(queue.map((q) => [q.id, q]))
  const seen = new Set<string>()
  const t: Triage = {
    total: labels.length,
    notInFile: [],
    unreviewed: [],
    inconclusive: [],
    invalidId: [],
    invalidTarget: [],
    missingDecision: [],
    valid: [],
    decided: [],
  }

  for (const l of labels) {
    seen.add(l.id)
    if (!byId.has(l.id)) {
      t.invalidId.push(l.id)
      continue
    }
    if (!l.query || !l.query.trim()) {
      t.unreviewed.push(l.id)
      continue
    }
    const decision = (l.decision ?? '').trim()
    if (decision === 'inconclusive') {
      t.inconclusive.push(l.id)
      continue
    }
    if (l.memoryId && !corpusIds.has(l.memoryId)) {
      t.invalidTarget.push(l.id)
      continue
    }
    t.valid.push(l)
    if ((DECISIONS as readonly string[]).includes(decision)) t.decided.push(l)
    else t.missingDecision.push(l.id)
  }

  t.notInFile = queue.map((q) => q.id).filter((id) => !seen.has(id))
  return t
}

export interface RankRow {
  id: string
  role: string
  memoryId: string | null
  lexRank: number | null
  hybRank: number | null
  lexHits: number
  hybTopCos: number | null
  tier: string
  decision: string
}

export interface RankSummary {
  n: number
  r1: number
  r5: number
  mrr: number
}

export interface PilotReport {
  targets: {
    n: number
    lexical: RankSummary
    hybrid: RankSummary
    /** alvo no top-5 do híbrido e fora do top-5 do lexical */
    hybOnly: string[]
    /** alvo no top-5 do lexical e fora do top-5 do híbrido */
    lexOnly: string[]
    /** alvo no top-5 dos dois */
    both: string[]
    /** alvo fora do top-5 dos dois */
    neither: string[]
  }
  noMemory: {
    n: number
    /** consultas que não precisam de memória e receberam candidato do lexical */
    lexReturned: number
    /** ... e cujo topo do híbrido passou do piso calibrado */
    hybAboveFloor: number
  }
  decision: Array<{ expected: Decision; n: number; match: number; tiers: Record<string, number> }>
}

const emptySummary = (): RankSummary => ({ n: 0, r1: 0, r5: 0, mrr: 0 })

function summariseRank(rows: RankRow[], pick: (r: RankRow) => number | null): RankSummary {
  const s = emptySummary()
  s.n = rows.length
  if (!rows.length) return s
  let hits1 = 0
  let hits5 = 0
  let rr = 0
  for (const r of rows) {
    const rank = pick(r)
    if (rank === 1) hits1++
    if (rank !== null && rank <= 5) hits5++
    if (rank !== null && rank > 0) rr += 1 / rank
  }
  s.r1 = hits1 / s.n
  s.r5 = hits5 / s.n
  s.mrr = rr / s.n
  return s
}

/**
 * Agrega as linhas já calculadas. `floor` é o piso de ruído do acervo, usado só
 * para dizer se o topo do híbrido passaria do limiar de ponteiro.
 */
export function summarize(rows: RankRow[], floor: number): PilotReport {
  const targets = rows.filter((r) => r.role !== 'no-memory' && r.memoryId)
  const noMem = rows.filter((r) => r.role === 'no-memory' || !r.memoryId)

  const inTop5 = (rank: number | null) => rank !== null && rank > 0 && rank <= 5
  const hybOnly = targets.filter((r) => inTop5(r.hybRank) && !inTop5(r.lexRank)).map((r) => r.id)
  const lexOnly = targets.filter((r) => inTop5(r.lexRank) && !inTop5(r.hybRank)).map((r) => r.id)
  const both = targets.filter((r) => inTop5(r.lexRank) && inTop5(r.hybRank)).map((r) => r.id)
  const neither = targets.filter((r) => !inTop5(r.lexRank) && !inTop5(r.hybRank)).map((r) => r.id)

  const decision: PilotReport['decision'] = []
  for (const expected of DECISIONS) {
    const set = rows.filter((r) => r.decision === expected)
    if (!set.length) continue
    const tiers: Record<string, number> = {}
    for (const r of set) tiers[r.tier] = (tiers[r.tier] ?? 0) + 1
    decision.push({ expected, n: set.length, match: set.filter((r) => r.tier === expected).length, tiers })
  }

  return {
    targets: {
      n: targets.length,
      lexical: summariseRank(targets, (r) => r.lexRank),
      hybrid: summariseRank(targets, (r) => r.hybRank),
      hybOnly,
      lexOnly,
      both,
      neither,
    },
    noMemory: {
      n: noMem.length,
      lexReturned: noMem.filter((r) => r.lexHits > 0).length,
      hybAboveFloor: noMem.filter((r) => (r.hybTopCos ?? -1) >= floor).length,
    },
    decision,
  }
}
