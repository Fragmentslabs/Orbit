/**
 * Turn retrieval: candidates, two-level policy and prompt block.
 *
 * The embedding engine is replaced by fixed vectors — what is tested here
 * is the decision and the assembly of the context, not Bekko (that one is measured in the
 * benchmark, electron/lib/memory/bench).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Memory } from '@shared/memory'
import { SELECTION } from './retrieval'

const vectorsById = vi.fn()
const embedTexts = vi.fn()
const noiseFloorFor = vi.fn()

vi.mock('./embedding', () => ({
  MEMORY_MODEL_ID: 'bekko-a8m',
  MEMORY_MODEL_DIM: 256,
  vectorsById: () => vectorsById(),
  embedTexts: (texts: string[]) => embedTexts(texts),
  noiseFloorFor: (probes: string[], memories: Memory[]) => noiseFloorFor(probes, memories),
}))

const { retrieveMemoryContext, renderMemoryBlock, renderMemorySuggestions, suggestMemories } = await import('./retrieval')

const memory = (over: Partial<Memory> & { text: string }): Memory => ({
  id: 'm1',
  kind: 'general',
  tags: [],
  weight: 0.7,
  hits: 0,
  relatedIds: [],
  createdAt: 0,
  ...over,
})

const pool = [
  memory({ id: 'voo', text: 'Só viaja com mala de mão e prefere assento no corredor.', tags: ['viagem'] }),
  memory({ id: 'jazz', text: 'Gosta de jazz e compra discos de vinil.', tags: ['música'] }),
  memory({ id: 'atlas', text: 'O projeto Atlas usa Next.js e roda testes com Vitest.', tags: ['projeto'] }),
]

const vec = (...xs: number[]) => Float32Array.from(xs)

beforeEach(() => {
  vi.clearAllMocks()
  vectorsById.mockResolvedValue(
    new Map([
      ['voo', vec(1, 0, 0)],
      ['jazz', vec(0, 1, 0)],
      ['atlas', vec(0, 0, 1)],
    ]),
  )
  embedTexts.mockResolvedValue([vec(1, 0, 0)])
  noiseFloorFor.mockResolvedValue([0.1, 0.2])
})

describe('two-tier policy', () => {
  it('strong evidence injects the content', async () => {
    const ctx = await retrieveMemoryContext({ message: 'posso levar mala no voo?', pool })
    expect(ctx?.inject.map((m) => m.id)).toEqual(['voo'])
    expect(ctx?.degraded).toBe(false)
  })

  it('weak evidence becomes a pointer, not an injection', async () => {
    // Four dimensions to fit a low cosine with ALL the memories:
    // 0.35 for "voo" (the closest) and less for the others, all below the
    // injection threshold (floor 0.2 + 0.22 = 0.42) and above the pointer one (0.2).
    vectorsById.mockResolvedValue(
      new Map([
        ['voo', vec(1, 0, 0, 0)],
        ['jazz', vec(0, 1, 0, 0)],
        ['atlas', vec(0, 0, 1, 0)],
      ]),
    )
    embedTexts.mockResolvedValue([vec(0.35, 0.28, 0.2, Math.sqrt(1 - 0.35 ** 2 - 0.28 ** 2 - 0.2 ** 2))])
    const ctx = await retrieveMemoryContext({ message: 'quero viajar', pool })
    expect(ctx?.inject).toEqual([])
    expect(ctx?.pointers[0]?.id).toBe('voo')
  })

  it('with no evidence it returns nothing', async () => {
    // Balanced query: no memory goes past a 0.58 cosine.
    embedTexts.mockResolvedValue([vec(Math.sqrt(1 / 3), Math.sqrt(1 / 3), Math.sqrt(1 / 3))])
    // Noisy pool: the floor rises above any cosine of this query.
    noiseFloorFor.mockResolvedValue([0.85])
    const ctx = await retrieveMemoryContext({ message: 'qual a capital da Austrália?', pool })
    expect(ctx?.inject).toEqual([])
    expect(ctx?.pointers).toEqual([])
  })

  it('a memory that is too long becomes a pointer instead of disappearing', async () => {
    const long = memory({ id: 'longa', text: `${'frase '.repeat(150)}fim` })
    expect(long.text.length).toBeGreaterThan(SELECTION.maxInjectChars)
    vectorsById.mockResolvedValue(new Map([['longa', vec(1, 0, 0)]]))
    const ctx = await retrieveMemoryContext({ message: 'me fala da frase', pool: [long] })
    expect(ctx?.inject).toEqual([])
    expect(ctx?.pointers.map((m) => m.id)).toEqual(['longa'])
  })

  it('core does not enter the retrieval (it is already in the fixed block)', async () => {
    // the filter belongs to the service; here we guarantee retrieval invents nothing
    const ctx = await retrieveMemoryContext({ message: 'qualquer coisa', pool: [] })
    expect(ctx).toBeNull()
  })
})

describe('fallback lexical', () => {
  it('with no semantic index, it finds by term and only points', async () => {
    vectorsById.mockResolvedValue(new Map())
    embedTexts.mockReset()
    const ctx = await retrieveMemoryContext({ message: 'mala de mão corredor', pool })
    expect(ctx?.degraded).toBe(true)
    expect(ctx?.inject).toEqual([])
    expect(ctx?.pointers.map((m) => m.id)).toContain('voo')
    expect(embedTexts).not.toHaveBeenCalled()
  })

  it('a message with no term in common returns no pointer', async () => {
    vectorsById.mockResolvedValue(new Map())
    const ctx = await retrieveMemoryContext({ message: 'fotossíntese', pool })
    expect(ctx?.pointers).toEqual([])
  })
})

describe('contexto recente', () => {
  it('a short message with no evidence uses the previous turn', async () => {
    noiseFloorFor.mockResolvedValue([0.6])
    embedTexts
      // isolated: weak for every memory (0.58 < pointer floor 0.6)
      .mockResolvedValueOnce([vec(Math.sqrt(1 / 3), Math.sqrt(1 / 3), Math.sqrt(1 / 3))])
      .mockResolvedValueOnce([vec(1, 0, 0)]) // with context: reaches the right memory
    const ctx = await retrieveMemoryContext({
      message: 'E o preço?',
      pool,
      recent: [{ role: 'user', text: 'Estou pensando em comprar uma passagem para o Rio' }],
    })
    expect(ctx?.inject.map((m) => m.id)).toEqual(['voo'])
    const lastCall = embedTexts.mock.calls.at(-1)![0][0] as string
    expect(lastCall).toContain('passagem para o Rio')
    expect(lastCall).toContain('E o preço?')
  })

  it('a change of subject does not inherit the previous context', async () => {
    embedTexts.mockResolvedValue([vec(0, 0, 1)])
    const ctx = await retrieveMemoryContext({
      message: 'Qual my número da academia?',
      pool,
      recent: [{ role: 'user', text: 'Estou pensando em comprar uma passagem para o Rio' }],
    })
    // it found Atlas (evidence), so there would be no retry; what matters is not
    // having consulted the travel context
    const calls = embedTexts.mock.calls.map((c) => c[0][0] as string)
    expect(calls.every((text) => !text.includes('passagem para o Rio'))).toBe(true)
    expect(ctx).not.toBeNull()
  })
})

describe('bloco do prompt', () => {
  it('separates injection from pointer and shows the pointer id', async () => {
    const block = renderMemoryBlock({
      inject: [pool[0]],
      pointers: [{ ...pool[1], title: 'Gosto musical' }],
      degraded: false,
      thresholds: { inject: 0.8, pointer: 0.5 },
      topCos: 0.9,
    })
    expect(block).toContain('Só viaja com mala de mão')
    expect(block).toContain('#jazz — Gosto musical')
    expect(block.indexOf('Só viaja')).toBeLessThan(block.indexOf('#jazz'))
  })

  it('with no memory it does not spend a single character', () => {
    expect(renderMemoryBlock(null)).toBe('')
    expect(
      renderMemoryBlock({ inject: [], pointers: [], degraded: false, thresholds: { inject: 0, pointer: 0 }, topCos: null }),
    ).toBe('')
  })

  it('marks an attached document for the model to open', () => {
    const block = renderMemoryBlock({
      inject: [{ ...pool[0], hasDoc: true }],
      pointers: [],
      degraded: false,
      thresholds: { inject: 0, pointer: 0 },
      topCos: 1,
    })
    expect(block).toContain('memory_open voo')
  })
})

/**
 * The turn suggestion exists to solve discovery WITHOUT passing the content
 * along. What is tested here is exactly that: what comes out are ids and
 * metadata, and whatever is already in the fixed prompt block stays out.
 */
describe('turn suggestions', () => {
  const tiny = [
    memory({ id: 'voo', text: 'Prefere assento no corredor em voos longos.' }),
    memory({ id: 'jazz', text: 'Gosta de jazz e compra discos de vinil.' }),
  ]

  // With no vectors, the path is the lexical one — it is the floor when the model is missing.
  beforeEach(() => {
    vectorsById.mockResolvedValue(new Map())
  })

  it('returns id and metadata, never the text', async () => {
    const found = await suggestMemories({ message: 'corredor no voo', pool: tiny })
    expect(found.map((s) => s.id)).toEqual(['voo'])
    expect(found[0]).not.toHaveProperty('text')
    expect(found[0]).toMatchObject({ id: 'voo', kind: 'general' })
  })

  it('does not repeat what is already in the prompt block', async () => {
    const found = await suggestMemories({ message: 'voos', pool: tiny })
    const first = found[0].id
    const rest = await suggestMemories({ message: 'voos', pool: tiny, exclude: [first] })
    expect(rest.map((s) => s.id)).not.toContain(first)
  })

  it('suggests nothing when nothing matches', async () => {
    expect(await suggestMemories({ message: 'xilofone quantico', pool: tiny })).toEqual([])
  })

  it('the block is labeled as unverified and carries no content', () => {
    const block = renderMemorySuggestions([
      { id: 'voo', kind: 'general', area: 'preferences', category: 'preference' },
    ])
    expect(block).toContain('unverified')
    expect(block).toContain('memory_open')
    expect(block).toContain('voo · general/preferences/preference')
    // The fact does not travel: only the framing.
    expect(block).not.toContain('corredor')
    expect(renderMemorySuggestions([])).toBe('')
  })
})
