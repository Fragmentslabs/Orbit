/**
 * Busca de conversas passadas — usada APENAS quando o usuário pergunta
 * explicitamente sobre conversas anteriores (intenção detectada no texto da
 * mensagem). O resultado é injetado como contexto no system prompt de um único
 * turno; nunca é acionado automaticamente pelo agente, para não desperdiçar
 * tokens. Em modo código a busca é filtrada pela pasta de trabalho atual.
 */
import type { ChatMessage, SendMessageInput, SessionInfo } from '@shared/chat'
import { StorageKeys } from '@shared/chat'
import { normalizeText, tokenize } from '@shared/memory'
import { listKeys, readJson } from './storage'

const MAX_CANDIDATES = 30
const MAX_RESULTS = 4
/** Mensagens mais recentes lidas de cada sessão candidata */
const TAIL_MESSAGES = 30
/** Teto por mensagem para limitar o custo de scoring */
const MESSAGE_TEXT_CAP = 600
const EXCERPT_LEN = 280
/** Teto total do bloco de contexto injetado (~1500 tokens) */
const BLOCK_BUDGET = 2200

interface Candidate {
  info: SessionInfo
  texts: string[]
}

interface Scored extends Candidate {
  score: number
  snippet: string | null
}

/**
 * Padrões de intenção avaliados sobre o texto normalizado (minúsculo, sem
 * acentos). São propositalmente conservadores: só disparam em referências
 * claras a conversas/atividades passadas — nunca em instruções genéricas.
 */
const INTENT_PATTERNS: RegExp[] = [
  // Marcador explícito (overriding manual)
  /@(historico|history|passado)/,

  // pt: referência direta a uma conversa/chat/sessão passada
  /(conversa|chat|sessao|discussao|dialogo)\s+(anterior|passada|passado|antiga|antigo|velha|velho|de ontem)/,
  /(outra conversa|outro chat|outra sessao|outro dialogo)/,
  /qual\s+(chat|conversa|sessao|discussao)/,
  /em qual\s+(chat|conversa|sessao)/,
  /naquele\s+(chat|conversa|sessao)/,
  /nesse\s+(chat|conversa|sessao)/,

  // pt: pergunta sobre atividade passada (ex.: "O que havíamos feito nesse projeto?")
  /o que\s+(haviamos|fizemos|falamos|conversamos|combinamos|deixamos|vinhamos|estavamos|trabalhamos|tratamos|ja fizemos|ja foi feito|ja foi discutido|ja foi decidido)/,
  /o que\s+eu\s+(te\s+)?(disse|pedi|falei|prometi|combinamos)/,
  /o que\s+(voce|vc|a gente|nos|eu)\s+(estava|estavamos|vinhamos|tinhamos|andava)\s+(fazendo|trabalhando|planejando|discutindo|investigando)/,
  /(me\s+)?(lembra|lembre|relembra|lembra\s+de)\s+(o que|qual|quando)/,
  /(da|na|a|desde)\s+(ultima vez|ultima conversa|ultimo chat|ultima sessao)/,
  /ja\s+(discutimos|falamos|conversamos|tratamos|abordamos)/,

  // en
  /what did we\b/,
  /what\s+(have we|we have|we had)\s+(done|discussed|talked|worked)/,
  /which\s+(chat|conversation|session|discussion)/,
  /previous\s+(chat|conversation|session|discussion|talk)/,
  /another\s+(chat|conversation|session)/,
  /earlier\s+(we|you|i)\b/,
  /(remind|remember)\s+me\s+what/,
  /the\s+last\s+time\b/,
  /did\s+i\s+(mention|say|tell|ask|talk)/,
  /we\s+(discussed|talked|agreed|decided)\s+(before|earlier|yesterday|last)/,
]

/** True quando a mensagem referencia explicitamente conversas anteriores. */
export function detectPastChatsIntent(text: string): boolean {
  const norm = normalizeText(text)
  return INTENT_PATTERNS.some((re) => re.test(norm))
}

/** Texto das mensagens (sem conteúdo extraído de anexos, que pode ser enorme). */
function extractTexts(msgs: ChatMessage[]): string[] {
  const out: string[] = []
  for (const msg of msgs) {
    for (const part of msg.parts) {
      if (part.type !== 'text' || part.source === 'attachment') continue
      const text = part.text.trim()
      if (text) out.push(text.slice(0, MESSAGE_TEXT_CAP))
    }
  }
  return out
}

async function loadCandidates(input: SendMessageInput): Promise<Candidate[]> {
  const keys = await listKeys(StorageKeys.sessionPrefix)
  const sessions = (
    await Promise.all(keys.map((k) => readJson<SessionInfo>(k)))
  ).filter((s): s is SessionInfo => s !== null)

  const matches = sessions.filter((info) => {
    if (info.archived) return false
    if (info.id === input.sessionId) return false
    // Sessões de orquestração (workers) não são conversas do usuário
    if (info.orchestration?.role) return false
    if (info.mode !== input.mode) return false
    // Modo código: só chats da mesma pasta de trabalho
    if (info.mode === 'code') {
      if (!input.directory || info.directory !== input.directory) return false
    }
    return true
  })
  matches.sort((a, b) => b.updatedAt - a.updatedAt)

  const candidates: Candidate[] = []
  for (const info of matches.slice(0, MAX_CANDIDATES)) {
    const msgs = (await readJson<ChatMessage[]>(StorageKeys.messages(info.id))) ?? []
    candidates.push({ info, texts: extractTexts(msgs.slice(-TAIL_MESSAGES)) })
  }
  return candidates
}

/** Score léxico por sobreposição de tokens com a pergunta + excerto de maior relevância. */
function scoreCandidate(c: Candidate, queryTokens: string[]): Scored {
  const corpus = normalizeText(c.texts.join(' '))
  let score = 0
  for (const token of queryTokens) if (corpus.includes(token)) score++
  if (score === 0) return { ...c, score: 0, snippet: null }

  let best = ''
  let bestScore = -1
  for (const text of c.texts) {
    const norm = normalizeText(text)
    let m = 0
    for (const token of queryTokens) if (norm.includes(token)) m++
    if (m > bestScore) {
      bestScore = m
      best = text
    }
  }
  return { ...c, score, snippet: best || null }
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return text.slice(0, max).trimEnd() + '…'
}

function instruction(scope: string): string {
  return `PAST CHATS CONTEXT. The user is asking about previous conversations. The snippets below come from past chats (${scope}), listed by recency/relevance.

- Use them as context and answer the user by summarizing what was discussed/done there.
- Integrate the context naturally into your answer — do not mention this block or treat it as a separate task.
- If the snippets don't contain what the user is looking for, say so honestly instead of guessing.`
}

/**
 * Busca conversas passadas relevantes e monta o bloco de contexto a injetar no
 * system prompt. Retorna null quando não há intenção/nada útil para trazer.
 */
export async function buildPastChatsContext(input: SendMessageInput): Promise<string | null> {
  const candidates = await loadCandidates(input)
  if (candidates.length === 0) return null

  const tokens = tokenize(input.text)
  const scored = candidates.map((c) => scoreCandidate(c, tokens))
  scored.sort((a, b) => b.score - a.score || b.info.updatedAt - a.info.updatedAt)

  const scope =
    input.mode === 'code' && input.directory ? 'within the current working folder' : 'across recent chats'

  const lines: string[] = []
  for (const r of scored.slice(0, MAX_RESULTS)) {
    const excerpt = (r.snippet ?? r.texts[r.texts.length - 1] ?? '').replace(/\s+/g, ' ').trim()
    if (!excerpt) continue
    const date = new Date(r.info.updatedAt).toISOString().slice(0, 10)
    const title = r.info.title || '(sem título)'
    lines.push(`- [${r.info.mode}] ${date} — "${title}": ${truncate(excerpt, EXCERPT_LEN)}`)
  }
  if (lines.length === 0) return null

  const kept: string[] = []
  let used = 0
  for (const line of lines) {
    if (kept.length > 0 && used + line.length > BLOCK_BUDGET) break
    kept.push(line)
    used += line.length
  }

  return `${instruction(scope)}\n\n${kept.join('\n')}`
}
