/**
 * Como a escrita do agente entra no buffer aberto no painel.
 *
 * O agente não digita: ele chama `write` (arquivo inteiro) ou `edit`
 * (substituição de trecho) e grava de uma vez. O renderer já recebe essas
 * chamadas pelo evento `part` do chat, com o input — então dá para aplicar a
 * mudança DENTRO do documento aberto em vez de recarregá-lo por cima.
 *
 * A diferença importa: recarregar joga fora cursor, seleção, scroll, histórico
 * de undo e qualquer rascunho não salvo. Aplicar como alteração pontual
 * preserva tudo isso, e é o que faz a edição do agente parecer que acontece
 * ali, em vez de o arquivo piscar.
 *
 * O `edit` ainda traz uma vantagem que o `write` não tem: ele diz a INTENÇÃO
 * (troque isto por aquilo), não só os bytes finais. Com a intenção dá para
 * fundir com segurança mesmo que a pessoa tenha mexido em OUTRA parte do
 * arquivo — e dá para saber, com precisão, quando não dá.
 */

export type AgentWrite =
  | { kind: 'edit'; oldString: string; newString: string; replaceAll?: boolean }
  | { kind: 'write'; content: string }

export interface DocChange {
  from: number
  to: number
  insert: string
}

export type MergePlan =
  /** Dá para aplicar sem ambiguidade. */
  | { kind: 'apply'; changes: DocChange[] }
  /** O buffer já está como o agente quer (ou o agente não mudou nada). */
  | { kind: 'noop' }
  /**
   * O trecho que o agente esperava não existe mais no buffer, ou existe em
   * vários lugares. Aplicar seria adivinhar — quem decide é a pessoa.
   */
  | { kind: 'conflict'; reason: 'not-found' | 'ambiguous' }

function occurrences(doc: string, needle: string): number[] {
  if (!needle) return []
  const found: number[] = []
  let at = doc.indexOf(needle)
  while (at >= 0) {
    found.push(at)
    at = doc.indexOf(needle, at + needle.length)
  }
  return found
}

/**
 * A menor alteração que transforma `doc` em `next`: recorta o prefixo e o
 * sufixo em comum e troca só o miolo.
 *
 * Não é um diff de verdade — duas alterações distantes uma da outra viram um
 * miolo grande que engloba as duas. Mas o caso normal do agente é uma região
 * só, e aí o que sobra é exatamente ela: o cursor de quem está lendo o resto
 * do arquivo não se mexe.
 */
export function minimalChange(doc: string, next: string): DocChange | null {
  if (doc === next) return null
  const max = Math.min(doc.length, next.length)
  let start = 0
  while (start < max && doc[start] === next[start]) start++
  let endDoc = doc.length
  let endNext = next.length
  while (endDoc > start && endNext > start && doc[endDoc - 1] === next[endNext - 1]) {
    endDoc--
    endNext--
  }
  return { from: start, to: endDoc, insert: next.slice(start, endNext) }
}

/** O que fazer com a escrita do agente, dado o conteúdo atual do buffer. */
export function planMerge(doc: string, write: AgentWrite): MergePlan {
  if (write.kind === 'write') {
    const change = minimalChange(doc, write.content)
    return change ? { kind: 'apply', changes: [change] } : { kind: 'noop' }
  }

  const { oldString, newString, replaceAll } = write
  if (oldString === newString) return { kind: 'noop' }
  const at = occurrences(doc, oldString)
  if (at.length === 0) {
    // Ou a pessoa editou justamente esse trecho, ou o arquivo já estava
    // diferente do que o agente leu. Nos dois casos, não dá para adivinhar.
    return { kind: 'conflict', reason: 'not-found' }
  }
  if (at.length > 1 && !replaceAll) {
    // O agente contava com um trecho único. Se agora há vários, o buffer
    // divergiu do que ele leu e aplicar no primeiro seria chute.
    return { kind: 'conflict', reason: 'ambiguous' }
  }
  const targets = replaceAll ? at : [at[0]]
  return {
    kind: 'apply',
    changes: targets.map((from) => ({ from, to: from + oldString.length, insert: newString })),
  }
}

/** A escrita descrita por uma tool call do agente, ou null se não for uma. */
export function agentWriteFromTool(
  tool: string,
  input: Record<string, unknown> | undefined,
): { filePath: string; write: AgentWrite } | null {
  if (!input || typeof input.filePath !== 'string') return null
  if (tool === 'write' && typeof input.content === 'string') {
    return { filePath: input.filePath, write: { kind: 'write', content: input.content } }
  }
  if (tool === 'edit' && typeof input.oldString === 'string' && typeof input.newString === 'string') {
    return {
      filePath: input.filePath,
      write: {
        kind: 'edit',
        oldString: input.oldString,
        newString: input.newString,
        replaceAll: input.replaceAll === true,
      },
    }
  }
  return null
}
