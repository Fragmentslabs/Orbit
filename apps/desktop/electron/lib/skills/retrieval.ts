import fs from 'node:fs/promises'
import type { Skill, SkillCard, SkillPrefs } from '@shared/skills'
import { SKILL_SUMMARY_LIMIT } from '@shared/skills'
import { Bm25Index, dot, hashString, lexTokens, reciprocalRankFusion } from '@shared/memory-retrieval'
import { INDEX_CAP, rankSkills, type RankGroup, type UseEvent } from './ranking'

/**
 * The skills index and search. Free of Electron: the embedding worker is handed in by
 * the caller (see turn.ts), so this file tests without a process behind it.
 *
 * The card (summary + tags) is what the prompt index and the search read — never the body.
 * A skill without a card still works: its full description (and the pieces of its slug)
 * feed the search, and the prompt shows the description cut at SKILL_SUMMARY_LIMIT.
 * The search gets the whole text; only the DISPLAY is truncated.
 */

export interface SkillEntry {
  skill: Skill
  /** The card, only when it still describes the file */
  card: SkillCard | null
}

// ---------------------------------------------------------------------------
// Display lines
// ---------------------------------------------------------------------------

/** One line, collapsed whitespace, cut at a word boundary. */
export function flatten(text: string, limit: number): string {
  const flat = text.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (flat.length <= limit) return flat
  const cut = flat.slice(0, limit)
  const lastSpace = cut.lastIndexOf(' ')
  const head = lastSpace > limit * 0.5 ? cut.slice(0, lastSpace) : cut
  return `${head.replace(/[\s,;:.\-–—]+$/, '')}…`
}

/** Summary for display: the card's, else the description cut to the same budget. */
export function skillSummary(entry: SkillEntry): string {
  if (entry.card) return flatten(entry.card.summary, SKILL_SUMMARY_LIMIT)
  return flatten(entry.skill.description, SKILL_SUMMARY_LIMIT)
}

/** `- @slug — summary`, or just `- @slug` when there is nothing to say. */
export function skillIndexLine(entry: SkillEntry): string {
  const summary = skillSummary(entry)
  return summary ? `- @${entry.skill.slug} — ${summary}` : `- @${entry.skill.slug}`
}

// ---------------------------------------------------------------------------
// The index (two layers)
// ---------------------------------------------------------------------------

export interface SkillIndex {
  described: Array<SkillEntry & { group: RankGroup }>
  namesOnly: string[]
  qualified: number
}

export interface IndexInput {
  /** User skills only (the built-ins never enter the ranking). */
  entries: readonly SkillEntry[]
  events: readonly UseEvent[]
  prefs: Readonly<Record<string, SkillPrefs>>
  now?: number
  cap?: number
}

async function createdAtOf(skill: Skill): Promise<number> {
  try {
    const stat = await fs.stat(skill.filePath)
    return stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.mtimeMs
  } catch {
    return 0
  }
}

export async function buildSkillIndex(input: IndexInput): Promise<SkillIndex> {
  const created = await Promise.all(input.entries.map((e) => createdAtOf(e.skill)))
  const bySlug = new Map(input.entries.map((e) => [e.skill.slug, e]))
  const ranked = rankSkills({
    skills: input.entries.map((e, i) => ({ slug: e.skill.slug, createdAt: created[i] })),
    events: input.events,
    prefs: input.prefs,
    now: input.now ?? Date.now(),
    cap: input.cap ?? INDEX_CAP,
  })
  return {
    described: ranked.described.map((d) => ({ ...bySlug.get(d.slug)!, group: d.group })),
    namesOnly: ranked.namesOnly,
    qualified: ranked.qualified,
  }
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

const STOP = new Set(
  (
    'a o os as um uma uns umas de do da dos das no na nos nas em por para pra com sem sob sobre e ou mas que se ' +
    'eu me mim meu minha te ele ela nos voce vc isso isto esse essa este esta aqui ali como quando onde qual quais ' +
    'foi ser ter tem ja nao sim muito mais menos so faz fazer faca crie criar quero preciso pode ' +
    'the an and or but of to in on at for with without about from by is are was be it its this that these those ' +
    'my me you your i we they do does make create need want can please'
  ).split(' '),
)

/** Light plural stripping, applied to both sides, so "vídeos" finds "vídeo". */
function stem(token: string): string {
  return token.length > 4 ? token.replace(/(?:e?s)$/, '') : token
}

function meaningful(text: string): string[] {
  return [...new Set(lexTokens(text).filter((t) => t.length >= 3 && !STOP.has(t)).map(stem))]
}

function slugPieces(slug: string): string {
  return slug.replace(/_/g, ' ')
}

interface SearchDoc {
  entry: SkillEntry
  textTokens: Set<string>
  tagTokens: Set<string>
  nameTokens: Set<string>
  /** the text that feeds the embedding */
  semanticText: string
}

function docOf(entry: SkillEntry): SearchDoc {
  const { skill, card } = entry
  const pieces = slugPieces(skill.slug)
  if (card) {
    return {
      entry,
      textTokens: new Set(meaningful(`${pieces} ${card.summary}`)),
      tagTokens: new Set(card.tags.flatMap(meaningful)),
      nameTokens: new Set(meaningful(`${pieces} ${skill.name}`)),
      semanticText: `${pieces}. ${card.summary}. ${card.tags.join(', ')}`,
    }
  }
  // No card: the WHOLE description (not the truncated display line) and the slug pieces.
  return {
    entry,
    textTokens: new Set(meaningful(`${pieces} ${skill.name} ${skill.description}`)),
    tagTokens: new Set(),
    nameTokens: new Set(meaningful(`${pieces} ${skill.name}`)),
    semanticText: `${pieces}. ${skill.name}. ${skill.description}`,
  }
}

/** The tags weigh more than the text in the lexical ranking. */
const TAG_WEIGHT = 3

export interface SkillHit {
  entry: SkillEntry
  matches: number
  tagMatches: number
  nameMatches: number
  lexRank: number | null
  cos: number | null
}

/** Semantic side, handed in by the caller. Absent = lexical only. */
export interface SkillSemantic {
  queryVec: Float32Array
  /** Vectors for doc texts (cached by the caller), in the same order. */
  embedDocs: (texts: string[]) => Promise<Float32Array[]>
}

export type SearchMode = 'suggest' | 'loose'

/**
 * Cosine floors, on the same `dot` scale the memory system uses — where the pointer band
 * starts at 0.5 and 0.6 is where memory injects into context. A hint has to earn attention,
 * so it sits INSIDE the pointer band, never above the memory's own inject threshold: at 0.62
 * the semantic half never fired and everything rested on the lexical gate. Still estimates —
 * the shadow log is what calibrates them.
 */
export const SUGGEST_COS = 0.52
export const SUGGEST_COS_NO_CARD = 0.58
export const LOOSE_COS = 0.45

export interface SearchInput {
  query: string
  entries: readonly SkillEntry[]
  /** `suggest` is the spontaneous hint (strict); `loose` answers an explicit skill_search. */
  mode: SearchMode
  semantic?: SkillSemantic | null
  max?: number
}

/**
 * Lexical rules, per mode. The spontaneous hint errs toward silence, never toward noise:
 * - with a card: a tag hit alone is enough ("crie um vídeo" ↔ tag `vídeo`); otherwise two
 *   distinct meaningful words;
 * - without a card: stricter — two words AND one of them in the name/slug;
 * - loose (explicit search): any meaningful word.
 */
function passesLexical(hit: SkillHit, mode: SearchMode): boolean {
  if (mode === 'loose') return hit.matches >= 1
  if (hit.entry.card) return hit.tagMatches >= 1 || hit.matches >= 2
  return hit.matches >= 2 && hit.nameMatches >= 1
}

function cosFloor(entry: SkillEntry, mode: SearchMode): number {
  if (mode === 'loose') return LOOSE_COS
  return entry.card ? SUGGEST_COS : SUGGEST_COS_NO_CARD
}

export async function searchSkills(input: SearchInput): Promise<SkillHit[]> {
  const { entries, mode } = input
  if (entries.length === 0 || !input.query.trim()) return []
  const docs = entries.map(docOf)
  const queryTokens = meaningful(input.query)

  const index = new Bm25Index(
    docs.map((d) => ({
      id: d.entry.skill.slug,
      text: [...d.textTokens].join(' '),
      boosted: [...d.tagTokens].join(' '),
    })),
    { weights: { boosted: TAG_WEIGHT } },
  )
  const lexical = index.search(queryTokens.join(' '), entries.length)
  const lexRank = new Map(lexical.map((hit, i) => [hit.id, i]))

  const hits: SkillHit[] = docs.map((d) => {
    let matches = 0
    let tagMatches = 0
    let nameMatches = 0
    for (const token of queryTokens) {
      const inTags = d.tagTokens.has(token)
      if (inTags) tagMatches++
      if (d.nameTokens.has(token)) nameMatches++
      if (inTags || d.textTokens.has(token)) matches++
    }
    return {
      entry: d.entry,
      matches,
      tagMatches,
      nameMatches,
      lexRank: lexRank.get(d.entry.skill.slug) ?? null,
      cos: null,
    }
  })

  const semantic = input.semantic
  if (semantic) {
    try {
      const vectors = await semantic.embedDocs(docs.map((d) => d.semanticText))
      hits.forEach((hit, i) => {
        const vec = vectors[i]
        if (vec) hit.cos = dot(semantic.queryVec, vec)
      })
    } catch {
      // the worker went away mid-turn: lexical only
    }
  }

  const keep = hits.filter(
    (hit) =>
      (hit.lexRank !== null && passesLexical(hit, mode)) ||
      (hit.cos !== null && hit.cos >= cosFloor(hit.entry, mode)),
  )
  if (keep.length === 0) return []

  const bySlug = new Map(keep.map((h) => [h.entry.skill.slug, h]))
  const lexList = keep
    .filter((h) => h.lexRank !== null)
    .sort((a, b) => a.lexRank! - b.lexRank!)
    .map((h) => h.entry.skill.slug)
  const vecList = keep
    .filter((h) => h.cos !== null)
    .sort((a, b) => b.cos! - a.cos!)
    .map((h) => h.entry.skill.slug)
  return reciprocalRankFusion([{ ids: lexList }, { ids: vecList }])
    .map((f) => bySlug.get(f.id))
    .filter((h): h is SkillHit => Boolean(h))
    .slice(0, input.max ?? 3)
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

/** Cache key for a doc vector — the text decides it. */
export function docVectorKey(text: string): string {
  return hashString(text)
}

/**
 * Hints block for the turn, labelled as a system guess: without the label the model
 * would read the slugs as if the user had asked for them. The warning that the content is
 * NOT loaded is what separates "something exists" from "apply this".
 */
export function renderSkillHints(hits: readonly SkillHit[]): string {
  if (hits.length === 0) return ''
  return [
    '[skill hints — automatic and unverified]',
    'These skills may fit this message. Their content is NOT loaded. Call skill_read with the @slug',
    'only if one actually helps; otherwise ignore this block entirely.',
    ...hits.map((h) => skillIndexLine(h.entry)),
  ].join('\n')
}

/** Result lines of the skill_search tool: `@slug — summary [tags]`. */
export function skillSearchLine(entry: SkillEntry): string {
  const base = skillIndexLine(entry).replace(/^- /, '')
  return entry.card?.tags.length ? `${base} [${entry.card.tags.join(', ')}]` : base
}
