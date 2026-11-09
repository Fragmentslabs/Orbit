import { describe, expect, it, vi } from 'vitest'
import { NOISE_PROBES } from '@shared/memory-select'
import type { ToolFamily } from './catalog'
import { semanticFamilies, type FamilyEmbedder, type FamilyPayload, type FamilyStore } from './family-semantic'

const family = (id: string, description: string): ToolFamily => ({ id, label: id, description, tools: [`${id}_one`] })
const families = [family('pdf', 'read pdf files'), family('video', 'make videos'), family('mail', 'send mail')]

/** Text → axis vector; off-topic probes land on a 4th axis, away from every family. */
const AXES: Record<string, number[]> = { pdf: [1, 0, 0, 0], video: [0, 1, 0, 0], mail: [0, 0, 1, 0] }
const vectorOf = (text: string): Float32Array => {
  const hit = Object.keys(AXES).find((k) => text.startsWith(`${k}.`))
  return new Float32Array(hit ? AXES[hit] : [0, 0, 0, 1])
}

function fakeEmbedder(active = true) {
  const embed = vi.fn(async (texts: string[]) => texts.map(vectorOf))
  const embedder: FamilyEmbedder = { active: () => active, embed }
  return { embedder, embed }
}

function memoryStore(initial: FamilyPayload | null = null) {
  let payload = initial
  const save = vi.fn(async (next: FamilyPayload) => {
    payload = structuredClone(next)
  })
  const store: FamilyStore = { load: async () => payload, save }
  return { store, save, get: () => payload }
}

const base = (over: Partial<Parameters<typeof semanticFamilies>[0]> = {}) => ({
  query: new Float32Array([1, 0, 0, 0]),
  families,
  alreadyActive: new Set<string>(),
  model: 'm:4',
  ...over,
})

describe('semanticFamilies', () => {
  it('shortlists the family the query points at', async () => {
    const { embedder } = fakeEmbedder()
    const { store } = memoryStore()
    const hits = await semanticFamilies({ ...base(), embedder, store })
    expect(hits.map((h) => h.id)).toEqual(['pdf'])
  })

  it('caches vectors and the noise floor on disk: the second call embeds nothing', async () => {
    const { embedder, embed } = fakeEmbedder()
    const disk = memoryStore()
    await semanticFamilies({ ...base(), embedder, store: disk.store })
    expect(embed).toHaveBeenCalledTimes(2) // documents, then probes
    expect(embed.mock.calls[1][0]).toEqual(NOISE_PROBES)
    embed.mockClear()
    const again = await semanticFamilies({ ...base(), embedder, store: disk.store })
    expect(embed).not.toHaveBeenCalled()
    expect(again.map((h) => h.id)).toEqual(['pdf'])
  })

  it('re-embeds only the document whose text changed, and recomputes the floor', async () => {
    const { embedder, embed } = fakeEmbedder()
    const disk = memoryStore()
    await semanticFamilies({ ...base(), embedder, store: disk.store })
    embed.mockClear()
    const edited = [family('pdf', 'read pdf files'), family('video', 'edit and render videos'), family('mail', 'send mail')]
    await semanticFamilies({ ...base({ families: edited }), embedder, store: disk.store })
    expect(embed.mock.calls[0][0]).toHaveLength(1) // just the edited family
    expect(embed.mock.calls[1][0]).toEqual(NOISE_PROBES) // new set → new floor
  })

  it('discards vectors stored for another model', async () => {
    const { embedder, embed } = fakeEmbedder()
    const stale: FamilyPayload = { v: 1, model: 'old:4', items: { x: 'AAAA' } }
    const disk = memoryStore(stale)
    await semanticFamilies({ ...base(), embedder, store: disk.store })
    expect(embed.mock.calls[0][0]).toHaveLength(3)
    expect(disk.get()?.model).toBe('m:4')
    expect(Object.keys(disk.get()?.items ?? {})).not.toContain('x')
  })

  it('falls back to nothing when the worker is not up, without touching the model', async () => {
    const { embedder, embed } = fakeEmbedder(false)
    expect(await semanticFamilies({ ...base(), embedder, store: memoryStore().store })).toEqual([])
    expect(embed).not.toHaveBeenCalled()
  })

  it('falls back to nothing without a query vector', async () => {
    const { embedder } = fakeEmbedder()
    expect(await semanticFamilies({ ...base({ query: null }), embedder, store: memoryStore().store })).toEqual([])
  })

  it('an off-topic query selects nothing', async () => {
    const { embedder } = fakeEmbedder()
    const hits = await semanticFamilies({ ...base({ query: new Float32Array([0, 0, 0, 1]) }), embedder, store: memoryStore().store })
    expect(hits).toEqual([])
  })

  it('never throws: a failing model or disk means no shortlist', async () => {
    const embedder: FamilyEmbedder = { active: () => true, embed: async () => { throw new Error('worker died') } }
    const broken: FamilyStore = { load: async () => { throw new Error('disk') }, save: async () => { throw new Error('disk') } }
    expect(await semanticFamilies({ ...base(), embedder, store: broken })).toEqual([])
  })

  it('gives up past the timeout instead of holding the turn', async () => {
    const embedder: FamilyEmbedder = { active: () => true, embed: () => new Promise(() => {}) }
    const hits = await semanticFamilies({ ...base({ timeoutMs: 20 }), embedder, store: memoryStore().store })
    expect(hits).toEqual([])
  })

  it('skips families that are already active', async () => {
    const { embedder } = fakeEmbedder()
    const hits = await semanticFamilies({ ...base({ alreadyActive: new Set(['pdf']) }), embedder, store: memoryStore().store })
    expect(hits).toEqual([])
  })
})
