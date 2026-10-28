import { parseMessageReply, type ChatMessage, type MessageReplyQuote } from "@shared/chat"
import { visibleMessageText } from "@/src/lib/message-utils"

/**
 * Histórico de ↑/↓ do compositor: os textos que a pessoa já enviou nesta
 * conversa, do mais recente para o mais antigo.
 *
 * A fonte é `messages` da sessão — a mesma lista que a bolha desenha. É por isso
 * que mensagem revertida não entra: o revert TRUNCA a lista e guarda o
 * descartado em `SessionRevert.discardedMessages` (ver revertToMessage), que
 * daqui não é lido. Desfazer o revert devolve as mensagens e elas voltam a
 * contar, como qualquer outra.
 *
 * A única decisão de UX mora aqui, e é pura para poder ser testada: a seta é do
 * CARET enquanto ele tem para onde ir. Só na ponta do campo (↑ na primeira
 * posição, ↓ na última) ela vira histórico — é o que deixa um prompt de várias
 * linhas ser navegado linha a linha antes de trocar de mensagem.
 */

export interface HistoryEntry {
  /** O que a pessoa escreveu, sem a citação da resposta. */
  text: string
  /** A resposta armada que acompanhava o envio, se havia. */
  reply: MessageReplyQuote | null
}

export interface HistoryCursor {
  /** Posição na lista (0 = a mais recente); null = fora da navegação. */
  index: number | null
  /** O que estava no campo quando a navegação começou. */
  draft: string
  /** A citação que estava armada nesse momento. */
  reply: MessageReplyQuote | null
}

export const NO_HISTORY: HistoryCursor = { index: null, draft: "", reply: null }

export interface HistoryInput {
  /** O que está no campo agora. */
  text: string
  /** O caret está na primeira posição — só aí ↑ é do histórico. */
  atStart: boolean
  /** O caret está na última posição — só aí ↓ é do histórico. */
  atEnd: boolean
}

export interface HistoryStep {
  cursor: HistoryCursor
  entry: HistoryEntry
}

/**
 * O que o CAMPO informa para a navegação: o texto e onde o caret está. `null`
 * quando a seta não é do histórico — com um trecho selecionado ela substitui a
 * seleção, como em qualquer campo.
 *
 * A regra é só de PONTA, e vale para todo texto, de uma linha ou de várias: um
 * texto comprido QUEBRA em várias linhas na tela sem ter um "\n" sequer, e ali
 * ↑ no meio tem que subir uma linha visual, não trocar de mensagem. Por isso a
 * decisão olha a posição do caret, nunca o número de linhas do valor.
 *
 * Recebe o textarea e lê `value`/`selectionStart` DELE, não o estado do React:
 * o que vale é o que está na tela.
 */
export function historyKeyInput(field: {
  value: string
  selectionStart: number
  selectionEnd: number
}): HistoryInput | null {
  if (field.selectionStart !== field.selectionEnd) return null
  return {
    text: field.value,
    atStart: field.selectionStart === 0,
    atEnd: field.selectionStart === field.value.length,
  }
}

/**
 * Textos enviados pela pessoa nesta sessão, do mais recente para o mais antigo.
 *
 * - só `role: "user"` — o que o modelo disse não é histórico de composição;
 * - só o que a pessoa digitou: `visibleMessageText` deixa de fora o texto
 *   extraído de anexo, e `parseMessageReply` separa a citação do corpo (o
 *   `> [assistant] …` voltaria cru para o campo);
 * - mensagem sem texto (só anexo) não entra, e nem texto repetido em sequência:
 *   subir duas vezes tem que trazer coisas diferentes.
 */
export function inputHistory(messages: ChatMessage[] | undefined): HistoryEntry[] {
  if (!messages?.length) return []
  const entries: HistoryEntry[] = []
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.role !== "user") continue
    const { reply, body } = parseMessageReply(visibleMessageText(message))
    const text = body.trim()
    if (!text) continue
    if (entries[entries.length - 1]?.text === text) continue
    entries.push({ text, reply })
  }
  return entries
}

/**
 * Um passo na navegação. `null` quando a tecla não é do histórico — e aí o
 * caret segue o seu caminho normal: sem nada para trazer, ↑ no topo da lista,
 * ↓ fora da navegação, ou uma seta no meio de um texto com várias linhas.
 */
export function historyStep(
  history: HistoryEntry[],
  cursor: HistoryCursor,
  input: HistoryInput,
  direction: "older" | "newer",
  currentReply: MessageReplyQuote | null,
): HistoryStep | null {
  if (history.length === 0) return null

  if (direction === "older") {
    // ↑ no meio do texto move o caret; o histórico só começa na primeira posição.
    if (!input.atStart) return null
    if (cursor.index === null) {
      // A navegação começa: o que estava digitado vira o rascunho do fim da lista.
      return {
        cursor: { index: 0, draft: input.text, reply: currentReply },
        entry: history[0],
      }
    }
    const index = Math.min(cursor.index + 1, history.length - 1)
    if (index === cursor.index) return null
    return { cursor: { ...cursor, index }, entry: history[index] }
  }

  // ↓ só na última posição, e só de dentro da navegação.
  if (!input.atEnd || cursor.index === null) return null
  const index = cursor.index - 1
  // Desceu além da mais recente: devolve o que estava sendo digitado.
  if (index < 0) {
    return {
      cursor: NO_HISTORY,
      entry: { text: cursor.draft, reply: cursor.reply },
    }
  }
  return { cursor: { ...cursor, index }, entry: history[index] }
}
