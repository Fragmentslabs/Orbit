import { generateText, type LanguageModel } from 'ai'
import type { CatalogModel, ChatMessage, TokenUsage } from '@shared/chat'
import { messageContextText } from './todo-context'

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
/** Teto absoluto de contexto pra decidir compactar, independente do
 * model.limit.context anunciado pelo catálogo — modelos de contexto muito
 * grande (1M+) só disparariam a compactação relativa perto de ~1M, deixando
 * a conversa operar rotineiramente com centenas de milhares de tokens de
 * histórico antes de cortar qualquer coisa. */
const ABSOLUTE_CONTEXT_CAP = 300_000

export const COMPACT_PROMPT = `You compact a conversation's history to free up context. Produce dense Markdown notes preserving, in this priority order:
1. The user's goal and the task's current state (what's been done, what's left).
2. Decisions made and their reasoning.
3. Files, functions, commands, and values cited (exact paths).
4. Pending items, open errors, and preferences expressed by the user.

For item 1, "what's been done" MUST be grounded in the "[Verified record: ...]" lines, which are measured by the engine from filesystem snapshots — not in the assistant's own prose. Where they disagree, the verified record wins. Summarize their verdicts in your own words with the exact file counts (e.g. "engine-verified: 18 files modified", "engine-verified: no files changed"), WITHOUT quoting the "[Verified record: ...]" line itself — it is internal bookkeeping and must never appear in the summary. Never merge a turn marked "NO file was modified" into a list of completed work.

Omit greetings, discarded attempts, and repetition. Reply with ONLY the summary, no preamble.`

export function findLastSummaryIndex(history: ChatMessage[]): number {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].summary) return i
  }
  return -1
}

/** Contexto estimado pelos tokens reais da última resposta — sem tokenizer.
 * Usa `lastTokens.lastStep` (usage da última chamada ao modelo) quando
 * disponível: é o tamanho real do contexto acumulado, ao contrário de
 * `input`/`output` (soma de todos os steps do turno, inflada por
 * idas-e-vindas de tool). Mensagens antigas sem `lastStep` caem no fallback
 * do total, que superestima o contexto mas nunca deixa de compactar. */
export function shouldCompact(
  lastTokens: TokenUsage | undefined,
  model: CatalogModel | undefined,
): boolean {
  if (lastTokens == null || !model?.limit?.context) return false
  const reserve =
    Math.min(model.limit.output || RESERVE_OUTPUT_CAP, RESERVE_OUTPUT_CAP) + RESERVE_PADDING
  const effectiveContext = Math.min(model.limit.context, ABSOLUTE_CONTEXT_CAP)
  const used = lastTokens.lastStep
    ? lastTokens.lastStep.input + lastTokens.lastStep.output
    : lastTokens.input + lastTokens.output
  return used >= effectiveContext - reserve
}

function textOf(message: ChatMessage): string {
  const text = message.parts
    .filter((p): p is Extract<ChatMessage['parts'][number], { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('\n')
    .trim()
  // Inclui o estado da TODO (se houver) no que vai pro resumo — senão essa
  // informação nunca chega ao prompt de compactação (ToolParts são ignorados
  // acima) e o item 1 do COMPACT_PROMPT ("o que já foi feito, o que falta")
  // fica sem a fonte mais confiável desse estado.
  return messageContextText(message, text)
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
