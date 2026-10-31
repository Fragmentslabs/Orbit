/**
 * In-memory index of what was SAID in the user's conversations.
 *
 * Derived and disposable: nothing is persisted. It is rebuilt from `session/` and
 * `messages/` after the boot, in the background, and kept current by comparing one
 * `stat` per file (mtime + size) — only a conversation whose file changed is parsed again.
 *
 * What is indexed is conversation text only: the `text` parts of user/assistant
 * messages, cut into passages of ~600 chars with overlap. Tool output and reasoning are
 * 97% of the bytes in a real profile and pure noise for ranking, so they never enter;
 * neither do text parts that carry a `source` (attachment extraction, vision notes,
 * engine nudges), which are not something the person or the model said. Compaction
 * summaries enter with a lower weight: they restate what the original messages
 * already have.
 *
 * Ranking is the same BM25 as the memory (accent folding included), plus prefix
 * expansion of the query terms, since BM25 only knows whole tokens and "launchagent"
 * must also find "LaunchAgents". Two consumers read it: the UI search
 * (`search-sessions.ts`) and the agent's `chat_search` tool.
 */
import type { ChatMessage, SessionInfo, SessionMode } from '@shared/chat'
import { StorageKeys } from '@shared/chat'
import { Bm25Index, foldText, lexTokens } from '@shared/memory-retrieval'
import { listKeys, readJson, statKey } from './storage'

const PASSAGE_CHARS = 600
const PASSAGE_OVERLAP = 100
/** The cut looks for a boundary in the last stretch of the window, never earlier. */
const BOUNDARY_WINDOW = 160
const SUMMARY_WEIGHT = 0.4
/** Prefix expansion: terms shorter than this stay exact; each term brings at most this many neighbours. */
const PREFIX_MIN = 3
const PREFIX_MAX_TERMS = 16
/** Recency is a tie-breaker, not a ranking signal: at most +20% for what happened today. */
const RECENCY_BOOST = 0.2
const RECENCY_HALF_LIFE_DAYS = 60
const DAY_MS = 24 * 60 * 60 * 1000
/** How long a search waits for a build in progress before answering with what exists. */
const DEFAULT_WAIT_MS = 800

export type PassageRole = 'user' | 'assistant' | 'title'

export interface Passage {
  sessionId: string
  /** Message the passage came from ('' for the title) */
  messageId: string
  role: PassageRole
  at: number
  text: string
  /** Compaction summary / continuation brief: ranks lower */
  summary: boolean
}

export interface IndexedChat {
  id: string
  title: string
  mode: SessionMode
  directory?: string
  folderId: string | null
  archived: boolean
  updatedAt: number
}

export interface IndexStatus {
  /** Chats whose text is in the ranking */
  indexed: number
  /** Chats that should be (the user's, not workers or routine runs) */
  total: number
  complete: boolean
}

export interface IndexQuery {
  query: string
  includeArchived?: boolean
  /** Chats that never come back (the current one) */
  excludeSessionIds?: readonly string[]
  /** Scope: which chats may answer */
  chat?: (chat: IndexedChat) => boolean
  after?: number
  before?: number
  /** Restricts to what one side said; title hits are dropped then */
  role?: 'user' | 'assistant'
  /** Match the chat title too (the UI does; the agent already sees titles) */
  titles?: boolean
  /** Longest wait for a build in progress. 0 = never wait. */
  waitMs?: number
}

export interface IndexMatch {
  passage: Passage
  chat: IndexedChat
  score: number
}

export interface IndexResult {
  /** One per message (its best passage), best first. Not limited. */
  matches: IndexMatch[]
  /** Distinct chats among the matches */
  chats: number
  status: IndexStatus
  /** The query terms plus their prefix expansions, folded — what `excerpt` looks for */
  terms: string[]
}

/** The user's chats: orchestration workers and routine runs belong to someone else. */
export function isUserChat(info: Pick<SessionInfo, 'parentId' | 'routineId' | 'orchestration'>): boolean {
  if (info.parentId || info.routineId) return false
  return info.orchestration?.role !== 'worker'
}

function toIndexedChat(info: SessionInfo): IndexedChat {
  return {
    id: info.id,
    title: info.title,
    mode: info.mode,
    directory: info.directory,
    folderId: info.folderId ?? null,
    archived: Boolean(info.archived),
    updatedAt: info.updatedAt,
  }
}

// ---------------------------------------------------------------------------
// Passages
// ---------------------------------------------------------------------------

/** Cuts a text into windows of ~PASSAGE_CHARS that overlap, preferring paragraph/sentence/word ends. */
export function splitPassages(text: string): string[] {
  const clean = text.trim()
  if (!clean) return []
  if (clean.length <= PASSAGE_CHARS) return [clean]
  const out: string[] = []
  let start = 0
  while (start < clean.length) {
    let end = Math.min(start + PASSAGE_CHARS, clean.length)
    if (end < clean.length) {
      const floor = end - BOUNDARY_WINDOW
      const window = clean.slice(floor, end)
      const para = window.lastIndexOf('\n')
      const sentence = Math.max(window.lastIndexOf('. '), window.lastIndexOf('? '), window.lastIndexOf('! '))
      const space = window.lastIndexOf(' ')
      const cut = para >= 0 ? para + 1 : sentence >= 0 ? sentence + 2 : space >= 0 ? space + 1 : -1
      if (cut > 0) end = floor + cut
    }
    const piece = clean.slice(start, end).trim()
    if (piece) out.push(piece)
    if (end >= clean.length) break
    start = Math.max(end - PASSAGE_OVERLAP, start + 1)
  }
  return out
}

function passagesOf(sessionId: string, messages: ChatMessage[]): Passage[] {
  const out: Passage[] = []
  for (const msg of messages) {
    if (msg.role !== 'user' && msg.role !== 'assistant') continue
    const summary = Boolean(msg.summary || msg.continuation)
    for (const part of msg.parts ?? []) {
      if (part.type !== 'text' || part.source || !part.text) continue
      for (const text of splitPassages(part.text)) {
        out.push({ sessionId, messageId: msg.id, role: msg.role, at: msg.createdAt, text, summary })
      }
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Excerpt
// ---------------------------------------------------------------------------

/** Folded copy of the text with the position each folded char came from. */
function foldWithMap(text: string): { folded: string; map: number[] } {
  let folded = ''
  const map: number[] = []
  let i = 0
  for (const ch of text) {
    const f = foldText(ch)
    for (let k = 0; k < f.length; k++) map.push(i)
    folded += f
    i += ch.length
  }
  return { folded, map }
}

/**
 * ~`width` chars of the text around the first query term, accents ignored, with "…"
 * where it was cut. Without a term in the text, the start of it.
 */
export function excerpt(text: string, terms: readonly string[], width: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= width) return flat
  const { folded, map } = foldWithMap(flat)
  let at = -1
  for (const term of terms) {
    if (!term) continue
    const idx = folded.indexOf(term)
    if (idx >= 0 && (at < 0 || idx < at)) at = idx
  }
  const hit = at >= 0 ? (map[at] ?? 0) : 0
  let start = Math.max(0, hit - Math.floor(width * 0.3))
  let end = Math.min(flat.length, start + width)
  start = Math.max(0, end - width)
  // Snap to word edges so the excerpt does not open or close in the middle of a word.
  if (start > 0) {
    const space = flat.indexOf(' ', start)
    if (space >= 0 && space < hit) start = space + 1
  }
  if (end < flat.length) {
    const space = flat.lastIndexOf(' ', end)
    if (space > hit) end = space
  }
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`
}

// ---------------------------------------------------------------------------
// The index
// ---------------------------------------------------------------------------

interface KnownChat {
  mtimeMs: number
  size: number
  info: SessionInfo
}

interface Entry {
  mtimeMs: number
  size: number
  passages: Passage[]
}

interface Ranker {
  bm25: Bm25Index
  passages: Passage[]
  /** Sorted, for prefix lookup */
  vocabulary: string[]
  sessions: Set<string>
}

export interface RefreshOptions {
  /** Chats whose file change is ignored when they already have an entry (the one being written) */
  skip?: ReadonlySet<string>
  /** Yields to the event loop between chats: the first build must not freeze the app */
  background?: boolean
}

function lowerBound(sorted: string[], value: string): number {
  let lo = 0
  let hi = sorted.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (sorted[mid] < value) lo = mid + 1
    else hi = mid
  }
  return lo
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve))

export class SessionIndex {
  private readonly known = new Map<string, KnownChat>()
  private readonly entries = new Map<string, Entry>()
  private ranker: Ranker | null = null
  private dirty = true
  private built = false
  private queue: Promise<void> = Promise.resolve()
  private started: Promise<void> | null = null

  constructor(private readonly now: () => number = Date.now) {}

  /** Kicks off the first build in the background. Idempotent. */
  start(): Promise<void> {
    this.started ??= this.refresh({ background: true })
    return this.started
  }

  /** Brings the index up to date with the disk. Calls are serialized. */
  refresh(options: RefreshOptions = {}): Promise<void> {
    const run = this.queue.then(() => this.sync(options))
    this.queue = run.catch(() => {})
    return run
  }

  status(): IndexStatus {
    let total = 0
    for (const { info } of this.known.values()) if (isUserChat(info)) total++
    const indexed = this.ranker?.sessions.size ?? 0
    return { indexed, total, complete: this.built && !this.dirty && indexed >= total }
  }

  async search(q: IndexQuery): Promise<IndexResult> {
    // The first build is never the search's job: wait a little for it, then answer with
    // what is there and say so. Afterwards a search only pays for what changed on disk.
    const sync = this.built ? this.refresh({ skip: new Set(q.excludeSessionIds) }) : this.start()
    const wait = q.waitMs ?? DEFAULT_WAIT_MS
    if (wait > 0) {
      let timer: NodeJS.Timeout | undefined
      await Promise.race([
        sync.catch(() => {}),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, wait)
        }),
      ])
      clearTimeout(timer)
    }

    const ranker = this.ensureRanker()
    const tokens = [...new Set(lexTokens(q.query))]
    const empty = (): IndexResult => ({ matches: [], chats: 0, status: this.status(), terms: tokens })
    if (tokens.length === 0 || ranker.passages.length === 0) return empty()

    const expanded = new Set(tokens)
    for (const token of tokens) {
      if (token.length < PREFIX_MIN || /^\p{N}+$/u.test(token)) continue
      let added = 0
      for (let i = lowerBound(ranker.vocabulary, token); i < ranker.vocabulary.length; i++) {
        const word = ranker.vocabulary[i]
        if (!word.startsWith(token)) break
        if (expanded.has(word)) continue
        expanded.add(word)
        if (++added >= PREFIX_MAX_TERMS) break
      }
    }

    const exclude = new Set(q.excludeSessionIds)
    const now = this.now()
    const best = new Map<string, IndexMatch>()
    for (const hit of ranker.bm25.search([...expanded].join(' '), ranker.passages.length)) {
      const passage = ranker.passages[Number(hit.id)]
      if (!passage || exclude.has(passage.sessionId)) continue
      if (passage.role === 'title' ? q.titles === false || q.role !== undefined : q.role && passage.role !== q.role) continue
      const chat = this.known.get(passage.sessionId)
      if (!chat) continue
      const info = toIndexedChat(chat.info)
      if (info.archived && !q.includeArchived) continue
      if (q.chat && !q.chat(info)) continue
      if (passage.role !== 'title') {
        if (q.after !== undefined && passage.at < q.after) continue
        if (q.before !== undefined && passage.at >= q.before) continue
      }
      const age = Math.max(0, now - info.updatedAt) / DAY_MS
      const score =
        hit.score * (passage.summary ? SUMMARY_WEIGHT : 1) * (1 + RECENCY_BOOST * 0.5 ** (age / RECENCY_HALF_LIFE_DAYS))
      const key = `${passage.sessionId}\u0000${passage.messageId}`
      const prior = best.get(key)
      if (!prior || prior.score < score) best.set(key, { passage, chat: info, score })
    }

    const matches = [...best.values()].sort(
      (a, b) => b.score - a.score || b.passage.at - a.passage.at || (a.passage.sessionId < b.passage.sessionId ? -1 : 1),
    )
    return {
      matches,
      chats: new Set(matches.map((m) => m.chat.id)).size,
      status: this.status(),
      terms: [...expanded],
    }
  }

  // -- sync -----------------------------------------------------------------

  private async sync({ skip, background }: RefreshOptions): Promise<void> {
    const prefix = StorageKeys.sessionPrefix
    const ids = (await listKeys(prefix)).map((key) => key.slice(prefix.length))
    const present = new Set(ids)
    let changed = false

    for (const id of [...this.known.keys()]) {
      if (present.has(id)) continue
      this.known.delete(id)
      this.entries.delete(id)
      changed = true
    }

    // Session metadata: title, archive state, folder and mode change without any new message.
    const stats = await Promise.all(ids.map((id) => statKey(StorageKeys.session(id))))
    for (let i = 0; i < ids.length; i++) {
      const stat = stats[i]
      if (!stat) continue
      const prior = this.known.get(ids[i])
      if (prior && prior.mtimeMs === stat.mtimeMs && prior.size === stat.size) continue
      const info = await readJson<SessionInfo>(StorageKeys.session(ids[i]))
      if (!info) continue
      this.known.set(ids[i], { mtimeMs: stat.mtimeMs, size: stat.size, info })
      if (!isUserChat(info)) this.entries.delete(ids[i])
      changed = true
    }

    for (const [id, { info }] of this.known) {
      if (!isUserChat(info)) continue
      const entry = this.entries.get(id)
      if (entry && skip?.has(id)) continue
      const stat = await statKey(StorageKeys.messages(id))
      if (entry && stat && entry.mtimeMs === stat.mtimeMs && entry.size === stat.size) continue
      if (entry && !stat && entry.size === 0) continue
      const messages = stat ? ((await readJson<ChatMessage[]>(StorageKeys.messages(id))) ?? []) : []
      const passages = passagesOf(id, Array.isArray(messages) ? messages : [])
      this.entries.set(id, { mtimeMs: stat?.mtimeMs ?? 0, size: stat?.size ?? 0, passages })
      changed = true
      if (background) await tick()
    }

    if (changed) this.dirty = true
    if (changed || !this.built) {
      this.ensureRanker()
    }
    this.built = true
  }

  /** (Re)builds the ranking over what the entries hold now. Cheap when nothing changed. */
  private ensureRanker(): Ranker {
    if (this.ranker && !this.dirty) return this.ranker
    const passages: Passage[] = []
    const sessions = new Set<string>()
    for (const [id, { info }] of this.known) {
      if (!isUserChat(info)) continue
      const entry = this.entries.get(id)
      if (!entry) continue
      sessions.add(id)
      if (info.title.trim()) {
        passages.push({ sessionId: id, messageId: '', role: 'title', at: info.updatedAt, text: info.title, summary: false })
      }
      for (const p of entry.passages) passages.push(p)
    }
    const bm25 = new Bm25Index(passages.map((p, i) => ({ id: String(i), text: p.text })))
    this.ranker = { bm25, passages, vocabulary: [...bm25.terms()].sort(), sessions }
    this.dirty = false
    return this.ranker
  }
}

let shared: SessionIndex | null = null

/** The app's index — one per process. */
export function sessionIndex(): SessionIndex {
  shared ??= new SessionIndex()
  return shared
}

/** Starts the first build; call it once the app is up. Errors never reach the boot. */
export function startSessionIndex(): void {
  sessionIndex()
    .start()
    .catch((err) => console.error('[session-index] first build failed', err))
}
