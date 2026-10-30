/**
 * Search of past conversations — used ONLY when the user asks
 * explicitly about previous conversations (intent detected in the text of the
 * message). The result is injected as context into the system prompt of a single
 * turn; it is never triggered automatically by the agent, so as not to waste
 * tokens. In code mode the search is filtered by the current working folder.
 */
import type { ChatMessage, SendMessageInput, SessionInfo } from '@shared/chat'
import { StorageKeys } from '@shared/chat'
import { normalizeText, tokenize } from '@shared/memory'
import { listKeys, readJson } from './storage'

const MAX_CANDIDATES = 30
const MAX_RESULTS = 4
/** Most recent messages read from each candidate session */
const TAIL_MESSAGES = 30
/** Ceiling per message to limit the scoring cost */
const MESSAGE_TEXT_CAP = 600
const EXCERPT_LEN = 280
/** Total ceiling of the injected context block (~1500 tokens) */
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
 * Intent patterns evaluated over the normalized text (lowercase, without
 * accents). They are deliberately conservative: they only fire on clear
 * references to past conversations/activities — never on generic instructions.
 */
const INTENT_PATTERNS: RegExp[] = [
  // Explicit marker (manual overriding)
  /@(historico|history|passado)/,

  // pt: direct reference to a past conversation/chat/session
  /(conversa|chat|sessao|discussao|dialogo)\s+(anterior|passada|passado|antiga|antigo|velha|velho|de ontem)/,
  /(outra conversa|outro chat|outra sessao|outro dialogo)/,
  /qual\s+(chat|conversa|sessao|discussao)/,
  /em qual\s+(chat|conversa|sessao)/,
  /naquele\s+(chat|conversa|sessao)/,
  /nesse\s+(chat|conversa|sessao)/,

  // pt: question about past activity (e.g.: "What had we done in this project?")
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

/** True when the message explicitly references previous conversations. */
export function detectPastChatsIntent(text: string): boolean {
  const norm = normalizeText(text)
  return INTENT_PATTERNS.some((re) => re.test(norm))
}

/** Text of the messages (without content extracted from attachments, which can be huge). */
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
    // Orchestration sessions (workers) are not the user's conversations
    if (info.orchestration?.role) return false
    if (info.mode !== input.mode) return false
    // Code mode: only chats of the same working folder
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

/** Lexical score by token overlap with the question + the most relevant excerpt. */
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
 * Searches relevant past conversations and assembles the context block to inject into the
 * system prompt. Returns null when there is no intent/nothing useful to bring.
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
    const title = r.info.title || '(untitled)'
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
