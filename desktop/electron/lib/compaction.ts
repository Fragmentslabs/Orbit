import { generateText, type LanguageModel } from 'ai'
import type { CatalogModel, ChatMessage, TokenUsage } from '@shared/chat'

/**
 * Compactação automática de contexto. O histórico enviado ao modelo é só texto
 * (toModelMessages) — o que cresce sem limite é o acúmulo de turnos user/
 * assistant. Quando os tokens REAIS da última resposta (fase de usage) se
 * aproximam do limite do modelo, o trecho antigo é resumido UMA vez e persistido
 * como mensagem sintética `summary: true`; toModelMessages passa a cortar nela.
 */

const RESERVE_OUTPUT_CAP = 16_000
const RESERVE_PADDING = 4_000
/** Pares user/assistant preservados intactos no fim do histórico */
const TAIL_USER_MESSAGES = 2
/** Guarda-corpo do prompt de resumo (~25k tokens) */
const MAX_SUMMARY_INPUT_CHARS = 100_000

export const COMPACT_PROMPT = `Você compacta o histórico de uma conversa para liberar contexto. Produza notas densas em Markdown preservando, nesta ordem de prioridade:
1. O objetivo do usuário e o estado atual da tarefa (o que já foi feito, o que falta).
2. Decisões tomadas e seus porquês.
3. Arquivos, funções, comandos e valores citados (caminhos exatos).
4. Pendências, erros em aberto e preferências expressas pelo usuário.
Omita cumprimentos, tentativas descartadas e repetições. Responda APENAS com o resumo, sem preâmbulo.`

export function findLastSummaryIndex(history: ChatMessage[]): number {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].summary) return i
  }
  return -1
}

/** Contexto estimado pelos tokens reais da última resposta — sem tokenizer. */
export function shouldCompact(
  lastTokens: TokenUsage | undefined,
  model: CatalogModel | undefined,
): boolean {
  if (!lastTokens?.input || !model?.limit?.context) return false
  const reserve =
    Math.min(model.limit.output || RESERVE_OUTPUT_CAP, RESERVE_OUTPUT_CAP) + RESERVE_PADDING
  return lastTokens.input + lastTokens.output >= model.limit.context - reserve
}

function textOf(message: ChatMessage): string {
  return message.parts
    .filter((p): p is Extract<ChatMessage['parts'][number], { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('\n')
    .trim()
}

/**
 * Define o trecho a resumir: do último summary (inclusive — o resumo anterior
 * é refundido no novo) até antes da cauda preservada. null = nada a compactar.
 */
export function splitForCompaction(
  history: ChatMessage[],
): { old: ChatMessage[]; cutIndex: number } | null {
  const start = Math.max(0, findLastSummaryIndex(history))
  let usersSeen = 0
  let cut = -1
  for (let i = history.length - 1; i >= start; i--) {
    if (history[i].role === 'user') {
      usersSeen++
      if (usersSeen === TAIL_USER_MESSAGES) {
        cut = i
        break
      }
    }
  }
  // Precisa sobrar pelo menos um par completo antes da cauda para valer o custo
  if (cut < start + 2) return null
  return { old: history.slice(start, cut), cutIndex: cut }
}

function newId(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
}

/**
 * Resume o trecho antigo e INSERE a mensagem summary no histórico (mutação).
 * Retorna a mensagem criada, ou null quando não há o que compactar.
 */
export async function compactHistory(
  history: ChatMessage[],
  model: LanguageModel,
): Promise<ChatMessage | null> {
  const split = splitForCompaction(history)
  if (!split) return null

  const transcript = split.old
    .map((m) => {
      const text = textOf(m)
      return text ? `${m.role === 'user' ? 'Usuário' : 'Assistente'}: ${text}` : null
    })
    .filter(Boolean)
    .join('\n\n')
  if (!transcript) return null

  const { text } = await generateText({
    model,
    system: COMPACT_PROMPT,
    prompt: transcript.slice(-MAX_SUMMARY_INPUT_CHARS),
  })
  if (!text.trim()) return null

  const summaryMessage: ChatMessage = {
    id: newId('msg'),
    role: 'assistant',
    summary: true,
    parts: [
      {
        id: newId('prt'),
        type: 'text',
        text: `Resumo da conversa até aqui:\n\n${text.trim()}`,
        state: 'done',
      },
    ],
    createdAt: Date.now(),
  }
  history.splice(split.cutIndex, 0, summaryMessage)
  return summaryMessage
}
