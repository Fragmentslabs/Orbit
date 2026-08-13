import type { Task } from '@shared/esteira'

/**
 * Contrato de saída das fases e regras de dependência. Puro de propósito (só
 * tipos como import): é a lógica que decide se uma fase valeu e se uma task
 * pode começar, e errar aqui em silêncio custa caro — separado do engine, fica
 * coberto por teste sem carregar o Electron.
 */

/**
 * Extrai a anotação do bloco ```anotacao. É o único canal entre uma fase e a
 * seguinte: sem ela a fase conta como falha, porque a próxima receberia ruído
 * (ou a narração solta do modelo) no lugar do relato.
 */
export function extrairAnotacao(texto: string): string | undefined {
  const bloco = texto.match(/```anotacao\s*\n([\s\S]*?)```/i)
  const conteudo = bloco?.[1]?.trim()
  return conteudo || undefined
}

/**
 * Hash de commit citado na anotação. Exige contexto de commit por perto: um
 * `\b[0-9a-f]{7,40}\b` solto casa com hash de arquivo, id e até palavras como
 * "added" — o commit errado no relatório é pior que nenhum.
 */
export function extrairCommit(texto: string): string | undefined {
  const comContexto = texto.match(
    /(?:commit|hash|sha)[^0-9a-f]{0,20}\b([0-9a-f]{7,40})\b/i,
  )
  return comContexto?.[1]
}

/** Dependências ainda não concluídas — bloqueiam o início automático (D15). */
export function dependenciasPendentes(task: Task, todas: Task[]): Task[] {
  return task.dependeDe
    .map((id) => todas.find((t) => t.id === id))
    .filter((t): t is Task => !!t && t.status !== 'concluida')
}

/**
 * Detecta ciclo antes de gravar uma dependência: uma task que depende (direta
 * ou indiretamente) de si mesma travaria a fila para sempre, sem erro visível.
 */
export function criaCiclo(taskId: string, novasDeps: string[], todas: Task[]): boolean {
  const porId = new Map(todas.map((t) => [t.id, t]))
  const visitar = (id: string, vistos: Set<string>): boolean => {
    if (id === taskId) return true
    if (vistos.has(id)) return false
    vistos.add(id)
    return (porId.get(id)?.dependeDe ?? []).some((d) => visitar(d, vistos))
  }
  return novasDeps.some((d) => visitar(d, new Set()))
}
