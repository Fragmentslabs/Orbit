/**
 * Quais imagens de um turno eram rascunho.
 *
 * Função pura, separada do chat-engine, porque a regra é a parte sutil: a
 * primeira versão dela só enxergava ESCADA — `edit(edit(x))`, cada imagem
 * virando entrada da próxima — e deixava passar inteiro o caso que de fato
 * acontece, que é LEQUE: o agente olha o resultado, não gosta, e refaz a
 * mesma edição a partir da MESMA base com outro parâmetro. Nenhuma tentativa
 * é pai da seguinte, então nenhuma parecia descartável, e a galeria enchia
 * com quatro recortes do mesmo original.
 */

export interface DraftSelection {
  /** URLs produzidas neste turno, na ordem em que entraram na resposta. */
  produced: Iterable<string>
  /** Filho → base de onde ele saiu, na ordem das chamadas. */
  parents: Map<string, string>
  /** O que o agente marcou como entrega (keep), e que nunca é rascunho. */
  keep: Set<string>
}

/**
 * Devolve as URLs a descartar. São dois formatos:
 *
 * - DEGRAU: a imagem virou entrada de outra imagem do mesmo turno. Só o topo
 *   da escada interessa.
 * - TENTATIVA: duas ou mais imagens saíram da mesma base neste turno. Fica a
 *   última; as anteriores foram as que não deram certo.
 *
 * O anexo do usuário não aparece aqui por construção — ele nunca entra em
 * `produced`, que só lista o que o turno gerou.
 */
export function selectDraftImages({ produced, parents, keep }: DraftSelection): string[] {
  const doTurno = new Set(produced)
  const rascunhos = new Set<string>()

  for (const base of parents.values()) {
    if (doTurno.has(base)) rascunhos.add(base)
  }

  const porBase = new Map<string, string[]>()
  for (const [filho, base] of parents) {
    const irmas = porBase.get(base) ?? []
    irmas.push(filho)
    porBase.set(base, irmas)
  }
  for (const irmas of porBase.values()) {
    for (const url of irmas.slice(0, -1)) rascunhos.add(url)
  }

  for (const url of keep) rascunhos.delete(url)
  // Só descarta o que este turno produziu: uma base de turno anterior é
  // história já aceita pelo usuário, não rascunho desta resposta.
  return [...rascunhos].filter((url) => doTurno.has(url))
}
