import type { Skill } from '@shared/skills'
import { isolatedQuery, contextualQuery, needsContextRetry, type ChatTurn } from '@shared/memory-query'
import { embedTexts, workerActive, type TurnEmbedder } from '../memory/embedding'
import { cardFor, getPrefs, logSkillSuggestion, recordSkillUse } from './meta'
import {
  docVectorKey,
  renderSkillHints,
  searchSkills,
  type SkillEntry,
  type SkillHit,
  type SkillSemantic,
} from './retrieval'
import { loadSkillBySlug, mentionedSlugs, skillBody } from './mention'

/**
 * The per-turn side of skills: the `@slug` body, the spontaneous hints and the shadow
 * log. Everything here lands in the turn's block (the user message), never the system
 * prompt — the prompt is frozen per session for the providers' prefix cache.
 */

/**
 * Three modes: `off`, `shadow` (compute and log, inject nothing) and `on`. What the user
 * picks is a boolean (Preferences → skill suggestions, resolved against the conversation's
 * Memory toggle); `ORBIT_SKILL_HINTS` is the developer override and wins over it — `=shadow`
 * is how to keep measuring while the cosine floors are still estimates.
 */
export type SkillHintMode = 'off' | 'shadow' | 'on'

export function resolveHintMode(requested?: boolean): SkillHintMode {
  const env = process.env.ORBIT_SKILL_HINTS
  if (env === 'shadow') return 'shadow'
  if (env === '0' || env === 'off' || env === 'false') return 'off'
  if (env === '1' || env === 'on' || env === 'true') return 'on'
  return requested === false ? 'off' : 'on'
}

/** Vectors of skill docs, kept for the process — a doc re-embeds only when its text changes. */
const docVectors = new Map<string, Float32Array>()
const DOC_VECTORS_MAX = 600

async function embedDocs(texts: string[]): Promise<Float32Array[]> {
  const missing = [...new Set(texts.filter((t) => !docVectors.has(docVectorKey(t))))]
  if (missing.length > 0) {
    const vectors = await embedTexts(missing)
    if (docVectors.size + missing.length > DOC_VECTORS_MAX) docVectors.clear()
    missing.forEach((text, i) => {
      if (vectors[i]) docVectors.set(docVectorKey(text), vectors[i])
    })
  }
  return texts.map((t) => docVectors.get(docVectorKey(t)) ?? new Float32Array(0))
}

/**
 * Semantic side for skills, or null. Only with the worker ALREADY up: "installed" is not
 * the criterion, because waking it for a hint costs ~400 MB of RSS and latency.
 */
async function semanticFor(embed: TurnEmbedder, semanticQuery: string): Promise<SkillSemantic | null> {
  if (!workerActive()) return null
  const queryVec = await embed(semanticQuery, { wake: false })
  return queryVec ? { queryVec, embedDocs } : null
}

/** Semantic side for an explicit search: its own query vector, still never waking the worker. */
export async function searchSemantic(query: string): Promise<SkillSemantic | null> {
  if (!workerActive()) return null
  try {
    const [queryVec] = await embedTexts([query])
    return queryVec ? { queryVec, embedDocs } : null
  } catch {
    return null
  }
}

export function entriesOf(skills: readonly Skill[]): SkillEntry[] {
  return skills.filter((s) => s.source !== 'builtin').map((skill) => ({ skill, card: cardFor(skill) }))
}

export interface HintInput {
  text: string
  recent?: ChatTurn[]
  skills: readonly Skill[]
  /** Slugs already shown at level 1 of the prompt index */
  indexed: readonly string[]
  /** Slugs cited with @ in this message (their body is already in the turn) */
  mentioned: readonly string[]
  /** Slugs opened earlier in this conversation */
  opened: ReadonlySet<string>
  sessionId: string
  /** off / shadow / on — the user's preference with the developer override already applied */
  mode: SkillHintMode
  embed: TurnEmbedder
}

/**
 * Hints for the turn. Excludes what the model already has (index level 1, `@`-cited,
 * opened here) and what the user turned off. Isolated query first; when it finds nothing
 * and the message is short, the previous turn disambiguates it — same mold as memory.
 */
export async function skillHintsForTurn(input: HintInput): Promise<SkillHit[]> {
  if (input.mode === 'off' || !input.text.trim()) return []
  const prefs = getPrefs()
  const skip = new Set([...input.indexed, ...input.mentioned, ...input.opened])
  const entries = entriesOf(input.skills).filter((e) => !skip.has(e.skill.slug) && !prefs[e.skill.slug]?.never)
  if (entries.length === 0) return []

  try {
    const run = async (semantic: string) =>
      searchSkills({
        query: semantic,
        entries,
        mode: 'suggest',
        semantic: await semanticFor(input.embed, semantic),
        max: 3,
      })
    const isolated = isolatedQuery(input.text)
    let hits = await run(isolated.semantic)
    if (hits.length === 0 && input.recent?.length && needsContextRetry(input.text, true, false)) {
      hits = await run(contextualQuery(input.text, input.recent).semantic)
    }
    // Always logged; injected only outside shadow mode. Hits are measured against the
    // ledger later (`opened`), which is what tells precision from noise.
    if (hits.length > 0) {
      void logSkillSuggestion({
        sessionId: input.sessionId,
        message: input.text,
        suggested: hits.map((h) => h.entry.skill.slug),
      })
    }
    return input.mode === 'shadow' ? [] : hits
  } catch (err) {
    console.error('[skills] hints failed:', err)
    return []
  }
}

export { renderSkillHints }

/**
 * Body of the skills cited with `@slug` in the message, for the turn block. Counts as a
 * use — once per conversation. Works even when the skill is also in the index: the index
 * shows the summary, not the body.
 */
export async function skillMentionTurnBlock(
  text: string,
  skills: readonly Skill[],
  use: { sessionId: string; scope: string },
): Promise<{ block: string; slugs: string[] }> {
  const slugs = mentionedSlugs(text, skills.map((s) => s.slug))
  if (slugs.length === 0) return { block: '', slugs: [] }
  const sections: string[] = []
  for (const slug of slugs) {
    const skill = loadSkillBySlug(skills, slug)
    if (!skill) continue
    sections.push(skillBody(skill, { header: `[Skill @${skill.slug} — cited in this message: apply it]` }))
    if (skill.source !== 'builtin') void recordSkillUse({ slug, scope: use.scope, sessionId: use.sessionId })
  }
  return { block: sections.join('\n\n'), slugs }
}
