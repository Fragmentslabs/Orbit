import { hashString } from '@shared/memory-retrieval'
import { NOISE_PROBES, noiseFloorOf, type NoiseFloor } from '@shared/memory-select'
import type { ToolFamily } from './catalog'
import {
  FAMILY_RANK,
  familyDocText,
  familySetSignature,
  rankFamilies,
  rankableFamilies,
  type FamilyHit,
  type FamilyRankParams,
} from './family-rank'

/**
 * The effectful half of the family shortlist: family document vectors (cached on disk,
 * invalidated by the text) and the per-set noise floor, around the pure `rankFamilies`.
 *
 * Everything outside is an interface so the tests inject fakes: the model call
 * (`FamilyEmbedder`) and the disk (`FamilyStore`). It never throws — any failure means
 * "no shortlist", which is today's behaviour (the model loads families on demand).
 */

export interface FamilyEmbedder {
  /** The worker is up right now. The shortlist never wakes it: a hint is not worth ~400 MB. */
  active(): boolean
  embed(texts: string[]): Promise<Float32Array[]>
}

export interface FamilyPayload {
  v: 1
  /** `${model}:${dim}` — vectors from another model are discarded whole. */
  model: string
  /** Vector per document text hash, float32 in base64. */
  items: Record<string, string>
  noise?: number[]
  noiseSig?: string
}

export interface FamilyStore {
  load(): Promise<FamilyPayload | null>
  save(payload: FamilyPayload): Promise<void>
}

export interface SemanticFamilyInput {
  /** Vector of the user's message (null = none → no shortlist). */
  query: Float32Array | null
  families: readonly ToolFamily[]
  alreadyActive: ReadonlySet<string>
  embedder: FamilyEmbedder
  store: FamilyStore
  model: string
  params?: FamilyRankParams
  /** Ceiling on the whole call; the turn goes on without the shortlist past it. */
  timeoutMs?: number
}

export const FAMILY_TIMEOUT_MS = 600

const encode = (vec: Float32Array): string =>
  Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength).toString('base64')

const decode = (b64: string): Float32Array => {
  const buf = Buffer.from(b64, 'base64')
  return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms)
    work.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      () => {
        clearTimeout(timer)
        resolve(null)
      },
    )
  })
}

async function shortlist(input: SemanticFamilyInput): Promise<FamilyHit[]> {
  const { query, embedder } = input
  if (!query || !embedder.active()) return []
  const candidates = rankableFamilies(input.families, input.alreadyActive)
  if (candidates.length === 0) return []

  const stored = await input.store.load().catch(() => null)
  const payload: FamilyPayload =
    stored && stored.v === 1 && stored.model === input.model ? stored : { v: 1, model: input.model, items: {} }

  const texts = candidates.map(familyDocText)
  const keys = texts.map(hashString)
  const missing = [...new Set(keys.filter((k) => !payload.items[k]))]
  let dirty = false
  if (missing.length > 0) {
    const byKey = new Map(keys.map((k, i) => [k, texts[i]]))
    const vectors = await input.embedder.embed(missing.map((k) => byKey.get(k) ?? ''))
    missing.forEach((k, i) => {
      if (vectors[i]) payload.items[k] = encode(vectors[i])
    })
    dirty = true
  }

  const vectors = new Map<string, Float32Array>()
  candidates.forEach((family, i) => {
    const b64 = payload.items[keys[i]]
    if (b64) vectors.set(family.id, decode(b64))
  })

  // The noise floor belongs to this exact set of documents: another MCP server, another mode
  // or an edited description makes a different collection and a different floor.
  const sig = familySetSignature(texts)
  let noise: NoiseFloor | undefined
  if (payload.noise && payload.noiseSig === sig) {
    noise = { tops: payload.noise }
  } else {
    const probes = await input.embedder.embed(NOISE_PROBES)
    noise = noiseFloorOf(probes, vectors)
    payload.noise = noise.tops
    payload.noiseSig = sig
    dirty = true
  }
  if (dirty) await input.store.save(payload).catch(() => {})

  const docs = [...vectors].map(([id, vec]) => ({ id, vec }))
  return rankFamilies(query, docs, noise, input.params ?? FAMILY_RANK).hits
}

/** Families the message points at, or [] — never throws, never waits past the timeout. */
export async function semanticFamilies(input: SemanticFamilyInput): Promise<FamilyHit[]> {
  const hits = await withTimeout(shortlist(input), input.timeoutMs ?? FAMILY_TIMEOUT_MS)
  return hits ?? []
}
