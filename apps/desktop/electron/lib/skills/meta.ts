import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { Skill, SkillCard, SkillCardState, SkillMetaView, SkillPrefs } from '@shared/skills'
import { hashString } from '@shared/memory-retrieval'
import { dataDir } from '../storage'
import { folderInMainRepository } from '../worktrees/main'
import type { UseEvent } from './ranking'

/**
 * Everything the app knows ABOUT skills, outside the skill files: cards (summary + tags),
 * preferences (pin / never suggest), the usage ledger and the shadow log of suggestions.
 * One file, orbit-data/skill-meta.json — never inside the skill, which belongs to the user.
 *
 * Cards are keyed by file path (a moved file loses its card); preferences and usage are
 * keyed by slug. Two names that sanitize to the same slug (`Deploy API`, `deploy-api`)
 * share both — a known limitation, not a surprise.
 */

export interface LedgerEvent {
  slug: string
  /** Main repository folder, or `chat` */
  scope: string
  /** Main conversation — a worker's use is attributed to its parent */
  sessionId: string
  at: number
}

export interface ShadowEntry {
  at: number
  sessionId: string
  /** Start of the message, for reading the log — not the whole text */
  message: string
  suggested: string[]
  /** Suggested skills opened later in the same conversation */
  opened: string[]
}

interface Store {
  cards: Record<string, SkillCard>
  prefs: Record<string, SkillPrefs>
  ledger: LedgerEvent[]
  shadow: ShadowEntry[]
}

const LEDGER_MAX_EVENTS = 2_000
const LEDGER_MAX_AGE_MS = 90 * 86_400_000
const SHADOW_MAX = 300
const SHADOW_MESSAGE_CHARS = 120

let cache: Store | null = null
let writing: Promise<void> = Promise.resolve()

function storeFile(): string {
  return path.join(dataDir(), 'skill-meta.json')
}

function emptyStore(): Store {
  return { cards: {}, prefs: {}, ledger: [], shadow: [] }
}

function load(): Store {
  if (cache) return cache
  try {
    const parsed = JSON.parse(fs.readFileSync(storeFile(), 'utf8')) as Partial<Store>
    cache = { ...emptyStore(), ...parsed }
  } catch {
    cache = emptyStore()
  }
  return cache
}

/** Writes are chained: two near-simultaneous events never interleave on disk. */
function save(): Promise<void> {
  const snapshot = JSON.stringify(load())
  writing = writing
    .catch(() => {})
    .then(async () => {
      const file = storeFile()
      await fsp.mkdir(path.dirname(file), { recursive: true })
      const tmp = `${file}.${process.pid}.tmp`
      await fsp.writeFile(tmp, snapshot, 'utf8')
      await fsp.rename(tmp, file)
    })
    .catch((err) => console.error('[skills] failed to save skill-meta:', err))
  return writing
}

/** Test hook: forget the in-memory copy so the next read goes to disk. */
export function resetSkillMetaCache(): void {
  cache = null
  writing = Promise.resolve()
}

/** Resolves once the pending writes reached the disk. */
export function flushSkillMeta(): Promise<void> {
  return writing
}

// ---------------------------------------------------------------------------
// Slug and hash
// ---------------------------------------------------------------------------

/** What a card was written from. Includes the purpose description: editing only it invalidates the card. */
export function skillHash(skill: Pick<Skill, 'slug' | 'name' | 'description' | 'content' | 'scripts'>): string {
  const scripts = [...(skill.scripts ?? [])].sort().join(',')
  return hashString(`${skill.slug}|${skill.name}|${skill.description}|${skill.content}|${scripts}`)
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

/** The card as stored, valid or not. */
export function peekCard(skill: Pick<Skill, 'filePath'>): SkillCard | null {
  return load().cards[skill.filePath] ?? null
}

export function cardState(skill: Skill): SkillCardState {
  const card = peekCard(skill)
  if (!card) return 'none'
  return card.hash === skillHash(skill) ? 'valid' : 'stale'
}

/** The card, only when it still describes the file. */
export function cardFor(skill: Skill): SkillCard | null {
  const card = peekCard(skill)
  return card && card.hash === skillHash(skill) ? card : null
}

export async function setCard(
  skill: Skill,
  card: { summary: string; tags: string[]; modelId: string; lang: string },
): Promise<SkillCard> {
  const full: SkillCard = { ...card, hash: skillHash(skill), at: new Date().toISOString() }
  load().cards[skill.filePath] = full
  await save()
  return full
}

/**
 * Drops the cards whose file no longer exists. It asks the DISK, never "is the skill in
 * the set loaded now": pruning by the open set would erase the cards of another project's skills.
 */
export async function pruneOrphanCards(): Promise<number> {
  const store = load()
  let removed = 0
  for (const filePath of Object.keys(store.cards)) {
    if (filePath.includes('://')) continue
    try {
      await fsp.access(filePath)
    } catch {
      delete store.cards[filePath]
      removed++
    }
  }
  if (removed > 0) await save()
  return removed
}

// ---------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------

export function getPrefs(): Readonly<Record<string, SkillPrefs>> {
  return load().prefs
}

export async function setPref(slug: string, patch: { pin?: boolean; never?: boolean }): Promise<void> {
  const prefs = load().prefs
  const next: SkillPrefs = { ...prefs[slug] }
  if (patch.pin !== undefined) {
    if (patch.pin) next.pin = next.pin ?? Date.now()
    else delete next.pin
  }
  if (patch.never !== undefined) {
    if (patch.never) next.never = true
    else delete next.never
  }
  if (next.pin || next.never) prefs[slug] = next
  else delete prefs[slug]
  await save()
}

// ---------------------------------------------------------------------------
// Usage ledger
// ---------------------------------------------------------------------------

/** Where a conversation's use is counted: the MAIN repository (not the worktree path), or `chat`. */
export async function usageScope(mode: 'chat' | 'code', directory?: string): Promise<string> {
  if (mode !== 'code' || !directory) return 'chat'
  return folderInMainRepository(directory).catch(() => directory)
}

/**
 * Registers a use. Counts ONCE per conversation: the number the panel shows is the
 * one that decides the seat. Returns false when it was already counted.
 */
export async function recordSkillUse(event: { slug: string; scope: string; sessionId: string; at?: number }): Promise<boolean> {
  const store = load()
  if (store.ledger.some((e) => e.slug === event.slug && e.sessionId === event.sessionId)) return false
  const at = event.at ?? Date.now()
  store.ledger.push({ slug: event.slug, scope: event.scope, sessionId: event.sessionId, at })
  const floor = at - LEDGER_MAX_AGE_MS
  store.ledger = store.ledger.filter((e) => e.at >= floor).slice(-LEDGER_MAX_EVENTS)
  // The shadow log learns whether a suggestion was followed by an open.
  for (const entry of store.shadow) {
    if (entry.sessionId === event.sessionId && entry.suggested.includes(event.slug) && !entry.opened.includes(event.slug)) {
      entry.opened.push(event.slug)
    }
  }
  await save()
  return true
}

/** Slugs this conversation already opened or cited. */
export function slugsUsedInSession(sessionId: string): Set<string> {
  return new Set(load().ledger.filter((e) => e.sessionId === sessionId).map((e) => e.slug))
}

/**
 * Events of a scope. A project with no history at all falls back to the global usage,
 * otherwise every new project would start with an empty list.
 */
export function eventsForScope(scope: string): UseEvent[] {
  const all = load().ledger
  const own = all.filter((e) => e.scope === scope)
  return (own.length > 0 ? own : all).map(({ slug, sessionId, at }) => ({ slug, sessionId, at }))
}

// ---------------------------------------------------------------------------
// Shadow log
// ---------------------------------------------------------------------------

export async function logSkillSuggestion(entry: {
  sessionId: string
  message: string
  suggested: string[]
  at?: number
}): Promise<void> {
  const store = load()
  store.shadow.push({
    at: entry.at ?? Date.now(),
    sessionId: entry.sessionId,
    message: entry.message.replace(/\s+/g, ' ').slice(0, SHADOW_MESSAGE_CHARS),
    suggested: entry.suggested,
    opened: [],
  })
  store.shadow = store.shadow.slice(-SHADOW_MAX)
  await save()
}

export function shadowLog(): readonly ShadowEntry[] {
  return load().shadow
}

// ---------------------------------------------------------------------------
// What the panel shows
// ---------------------------------------------------------------------------

export function metaViews(skills: readonly Skill[], scope: string): SkillMetaView[] {
  const events = eventsForScope(scope)
  // With no history in this scope the numbers come from every project (see eventsForScope).
  // The panel says so, instead of passing global usage off as this project's.
  const scopeGlobal = !load().ledger.some((e) => e.scope === scope)
  return skills.map((skill) => {
    const mine = events.filter((e) => e.slug === skill.slug)
    return {
      slug: skill.slug,
      state: cardState(skill),
      card: peekCard(skill) ?? undefined,
      prefs: load().prefs[skill.slug] ?? {},
      conversations: new Set(mine.map((e) => e.sessionId)).size,
      lastUsedAt: mine.reduce<number | null>((best, e) => (best == null || e.at > best ? e.at : best), null),
      scopeGlobal,
    }
  })
}
