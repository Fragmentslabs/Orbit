import { dot, hashString } from '@shared/memory-retrieval'
import { quantile, type NoiseFloor } from '@shared/memory-select'
import type { ToolFamily } from './catalog'

/**
 * Which tool families a message points at — the pure half (no model, no disk).
 *
 * Same rule as memory retrieval: the cosine threshold is not a constant but the noise floor
 * of THIS collection (the highest cosine any off-topic probe reaches against the family
 * documents) plus a margin. A fixed number calibrated on one collection did not carry
 * over to another (see docs/contextual-memory.md §6), and the family documents are a tiny,
 * curated collection with its own floor.
 *
 * The caller embeds; this file only ranks. That keeps the fixed-vector tests exact.
 */

export interface FamilyRankParams {
  /** Quantile of the noise probes taken as the floor (1 = the highest probe). */
  noiseQuantile: number
  /** How far above the floor a family has to be to count. */
  delta: number
  /** Beyond the first, only families within this much cosine of the first enter. */
  gap: number
  /** Ceiling on families activated by one message. */
  max: number
}

/**
 * Deliberately strict: a wrongly loaded family costs its schemas in every step of the turn,
 * while a missed one is still one `tools_load` away. `delta` 0.04 was the loosest value with
 * zero false positives and zero wrong families on a 32-query pt/en fixture written by the
 * author (docs/contextual-memory.md §15) — it is NOT validated on real usage.
 */
export const FAMILY_RANK: FamilyRankParams = {
  noiseQuantile: 1,
  delta: 0.04,
  gap: 0.06,
  max: 2,
}

export interface FamilyVector {
  id: string
  vec: ArrayLike<number>
}

export interface FamilyHit {
  id: string
  cos: number
}

export interface FamilyRanking {
  hits: FamilyHit[]
  /** Cosine a family had to reach (null = no noise floor, nothing is selected). */
  threshold: number | null
}

/**
 * Ranks the families for one query vector. Without a noise floor nothing is selected:
 * that is the fallback, and it is exactly today's behaviour (the model loads on demand).
 */
export function rankFamilies(
  queryVec: ArrayLike<number>,
  docs: readonly FamilyVector[],
  noise: NoiseFloor | undefined,
  params: FamilyRankParams = FAMILY_RANK,
): FamilyRanking {
  if (!noise || noise.tops.length === 0 || docs.length === 0) return { hits: [], threshold: null }
  const threshold = quantile(noise.tops, params.noiseQuantile) + params.delta
  const scored = docs
    .map((doc) => ({ id: doc.id, cos: dot(queryVec, doc.vec) }))
    .sort((a, b) => b.cos - a.cos || a.id.localeCompare(b.id))
  const top = scored[0]
  const hits = scored
    .filter((hit) => hit.cos >= threshold && top.cos - hit.cos <= params.gap)
    .slice(0, params.max)
  return { hits, threshold }
}

/**
 * The text that stands for a family in the vector space: what it solves and the words a
 * user would use for it. Tool names stay out — they are identifiers, not language, and
 * the lexical `familiesMentionedInText` already handles them.
 */
export function familyDocText(family: Pick<ToolFamily, 'label' | 'description' | 'tags'>): string {
  const tags = family.tags?.length ? ` ${family.tags.join(', ')}.` : ''
  return `${family.label}. ${family.description}${tags}`
}

/** Families that can be selected: available, not MCP (those have their own route), not already on. */
export function rankableFamilies(
  families: readonly ToolFamily[],
  alreadyActive: ReadonlySet<string>,
): ToolFamily[] {
  return families.filter((f) => !f.unavailable && !f.mcp && f.tools.length > 0 && !alreadyActive.has(f.id))
}

/** Signature of a set of family documents — the noise floor is valid only for the same set. */
export function familySetSignature(texts: readonly string[]): string {
  return hashString([...texts].sort().join('\n'))
}
