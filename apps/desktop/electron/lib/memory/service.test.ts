/**
 * The write contract for NEW memories: the enrichment the tool sends
 * has to reach what is stored, survive a merge and be able to be
 * added later by memory_update.
 *
 * Repository and index doubled in memory: nothing here touches the real pool or
 * starts the model.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Memory } from '@shared/memory'
import { consolidate } from './routine'

const store = new Map<string, Memory>()
const docs = new Map<string, string>()

/**
 * Embedding double: each test decides whether there is a model, which vectors exist and
 * what the query vector is. `vi.hoisted` because the `vi.mock` factory runs
 * before any `const` in the file.
 */
const emb = vi.hoisted(() => ({
  installed: false,
  vectors: new Map<string, Float32Array>(),
  query: null as Float32Array | null,
}))

vi.mock('./repository', () => ({
  get: async (id: string) => store.get(id) ?? null,
  put: async (memory: Memory) => {
    store.set(memory.id, memory)
  },
  putMany: async (list: Memory[]) => {
    for (const memory of list) store.set(memory.id, memory)
  },
  remove: async (id: string) => {
    store.delete(id)
    return [...store.values()]
  },
  rebuildIndex: async () => [...store.values()],
  getIndex: async () => [...store.values()],
  readDoc: async (id: string) => docs.get(id) ?? null,
  writeDoc: async (id: string, markdown: string) => {
    docs.set(id, markdown)
  },
}))

vi.mock('./embedding', () => ({
  syncIndex: async () => ({ indexed: 0, removed: 0, model: null }),
  vectorsById: async () => emb.vectors,
  noiseFloorFor: async () => 0,
  modelInstalled: () => emb.installed,
  embedTexts: async () => (emb.query ? [emb.query] : []),
}))

const service = await import('./service')

beforeEach(() => {
  store.clear()
  docs.clear()
  emb.installed = false
  emb.vectors = new Map()
  emb.query = null
})

describe('new memory', () => {
  it('saves the enrichment that was sent', async () => {
    const { id } = await service.save({
      text: 'Decisão: os webhooks da Stripe chegam por um relay n8n',
      kind: 'general',
      title: 'Webhooks via relay',
      summary: 'Stripe → n8n → app',
      entities: ['Stripe', 'n8n'],
      keywords: ['pagamento', 'webhook'],
      concepts: ['receber evento de cobrança'],
    })
    const memory = store.get(id)!
    expect(memory.title).toBe('Webhooks via relay')
    expect(memory.summary).toBe('Stripe → n8n → app')
    expect(memory.entities).toEqual(['Stripe', 'n8n'])
    expect(memory.concepts).toEqual(['receber evento de cobrança'])
  })

  it('grava o documento e marca hasDoc', async () => {
    const { id } = await service.save({
      text: 'Arquitetura do relay descrita no documento',
      kind: 'general',
      document: '# Relay\n\nDetalhes extensos.',
    })
    expect(store.get(id)!.hasDoc).toBe(true)
    expect(docs.get(id)).toContain('Detalhes extensos')
  })

  it('merging does not erase the enrichment that already existed', async () => {
    const first = await service.save({
      text: 'Prefere respostas curtas',
      kind: 'general',
      title: 'Respostas curtas',
      keywords: ['concisão'],
    })
    const again = await service.save({ text: 'Prefere respostas curtas', kind: 'general' })
    expect(again.merged).toBe(true)
    expect(again.id).toBe(first.id)
    const memory = store.get(first.id)!
    expect(memory.title).toBe('Respostas curtas')
    expect(memory.keywords).toEqual(['concisão'])
  })
})

describe('memory_update', () => {
  it('adds enrichment to a memory that had none', async () => {
    const { id } = await service.save({ text: 'Usa pnpm no monorepo', kind: 'general' })
    expect(store.get(id)!.title).toBeUndefined()

    await service.revise(id, { title: 'Gerenciador de pacotes', keywords: ['pnpm'] })
    expect(store.get(id)!.title).toBe('Gerenciador de pacotes')
    expect(store.get(id)!.keywords).toEqual(['pnpm'])
  })

  it('rewriting the text without repeating the fields preserves the enrichment', async () => {
    const { id } = await service.save({
      text: 'Usa pnpm no monorepo',
      kind: 'general',
      title: 'Gerenciador de pacotes',
    })
    await service.revise(id, { text: 'Usa pnpm em todos os pacotes do monorepo' })
    expect(store.get(id)!.title).toBe('Gerenciador de pacotes')
  })
})

describe('memory_search', () => {
  const vec = (...xs: number[]) => Float32Array.from(xs)

  it('without a model, it finds by the exact term', async () => {
    await service.save({ text: 'O relay n8n recebe os webhooks da Stripe', kind: 'general' })
    await service.save({ text: 'A paleta usa o amarelo oklch como primario', kind: 'general' })

    const found = await service.search({ query: 'relay webhooks', kinds: ['general'] })
    expect(found[0]?.text).toContain('relay n8n')
  })

  it('with a model, the vector brings what the term does not reach', async () => {
    const a = await service.save({ text: 'O relay n8n recebe os webhooks da Stripe', kind: 'general' })
    const b = await service.save({ text: 'A paleta usa o amarelo oklch como primario', kind: 'general' })
    emb.installed = true
    emb.vectors = new Map([
      [a.id, vec(1, 0)],
      [b.id, vec(0, 1)],
    ])
    emb.query = vec(0, 1)

    // No term in common with either: the cosine is what decides.
    const found = await service.search({ query: 'cor de destaque', kinds: ['general'] })
    expect(found[0]?.id).toBe(b.id)
  })

  it('never triggers a download: without a model the floor is the lexical one', async () => {
    await service.save({ text: 'O relay n8n recebe os webhooks', kind: 'general' })

    const found = await service.search({ query: 'zquiz', kinds: ['general'] })
    expect(found).toEqual([])
  })
})

/**
 * Scope is what keeps a conversation preference from becoming a code
 * instruction (and a technical lesson from becoming chat context). The default is for the
 * memory to follow the mode it was born in; `both` is an explicit decision.
 */
describe('scope across modes', () => {
  const ids = (list: Memory[]) => list.map((m) => m.id)

  it('the category holds for general and for the seasonal proposal; never for core', async () => {
    const general = await service.save({ text: 'Prefere commits pequenos', kind: 'general', category: 'preference' })
    const core = await service.save({ text: 'Tem um gato chamado Tofu', kind: 'core', category: 'preference' })
    const seasonal = await service.save({ text: 'Mexeu no layout do painel', kind: 'seasonal', category: 'preference' })
    expect(store.get(general.id)!.category).toBe('preference')
    expect(store.get(core.id)!.category).toBeUndefined()
    // The routine's proposal is born with the category; it survives promotion.
    expect(store.get(seasonal.id)!.category).toBe('preference')
  })

  it('a routine proposal does not enter the prompt nor the search', async () => {
    const { id } = await service.save({
      text: 'Prefere rever o diff antes de commitar',
      kind: 'seasonal',
      scope: 'chat',
      proposed: true,
    })
    expect(ids((await service.loadPromptContext('chat')).seasonal)).not.toContain(id)
    expect(ids(await service.retrievalPool('chat'))).not.toContain(id)
    const hits = await service.search({ query: 'rever diff commitar', kinds: ['seasonal'], mode: 'chat' })
    expect(ids(hits)).not.toContain(id)
  })

  it('general without a stored scope still holds in both modes', async () => {
    const { id } = await service.save({ text: 'Prefere respostas curtas', kind: 'general' })
    expect(store.get(id)!.scope).toBe('both')
    expect(ids((await service.loadPromptContext('chat')).general)).toContain(id)
    expect(ids((await service.loadPromptContext('code')).general)).toContain(id)
  })

  it('a preference saved in the chat does not enter the code prompt', async () => {
    const { id } = await service.save({ text: 'Não usar emojis nas respostas', kind: 'general', scope: 'chat' })
    expect(ids((await service.loadPromptContext('chat')).general)).toContain(id)
    expect(ids((await service.loadPromptContext('code')).general)).not.toContain(id)
  })

  it('promoting a seasonal inherits the origin scope instead of becoming both', async () => {
    const { id } = await service.save({ text: 'Costuma revisar o diff antes de commitar', kind: 'seasonal' })
    await service.promote(id)
    expect(store.get(id)!.kind).toBe('general')
    expect(store.get(id)!.scope).toBe('chat')
    expect(ids((await service.loadPromptContext('code')).general)).not.toContain(id)
  })

  it('saving again does not move the scope; only "both" widens it', async () => {
    const { id } = await service.save({ text: 'Prefere respostas curtas', kind: 'general', scope: 'chat' })
    await service.save({ text: 'Prefere respostas curtas', kind: 'general', scope: 'chat' })
    expect(store.get(id)!.scope).toBe('chat')
    await service.save({ text: 'Prefere respostas curtas', kind: 'general', scope: 'both' })
    expect(store.get(id)!.scope).toBe('both')
  })

  it('the weekly consolidation promotes what came back on different days', async () => {
    const a = await service.save({
      text: 'Prefere ver um artefato antes de implementar a tela',
      kind: 'seasonal',
      scope: 'chat',
    })
    const b = await service.save({
      text: 'Prefere ver um artefato antes de implementar o fluxo',
      kind: 'seasonal',
      scope: 'chat',
    })
    // Two requests on the same day are not a pattern: only repetition on
    // different days counts.
    const day = 24 * 60 * 60 * 1000
    store.get(a.id)!.createdAt = Date.now() - 3 * day
    store.get(b.id)!.createdAt = Date.now() - 1 * day
    const promoted = await consolidate(Date.now())
    expect(promoted).toBeGreaterThanOrEqual(1)
    expect(store.get(a.id)!.kind).toBe('general')
    // Promotion inherits the origin scope: a conversation preference stays in the chat.
    expect(store.get(a.id)!.scope).toBe('chat')
  })

  it('search filters by the mode of whoever is searching', async () => {
    const talk = await service.save({ text: 'Prefere tom direto, sem rodeios', kind: 'general', scope: 'chat' })
    const work = await service.save({ text: 'Prefere artefato antes de implementar tela', kind: 'general', scope: 'both' })

    const chat = await service.search({ query: 'prefere', kinds: ['general'], mode: 'chat' })
    const code = await service.search({ query: 'prefere', kinds: ['general'], mode: 'code' })
    expect(ids(chat)).toContain(talk.id)
    expect(ids(code)).not.toContain(talk.id)
    expect(ids(code)).toContain(work.id)
  })
})

/**
 * The system prompt block is sent on EVERY message, forever. The limit
 * has to be on size: counting memories does not protect against one long memory.
 */
describe('system prompt block', () => {
  it('cuts a long memory instead of dumping the whole text', async () => {
    await service.save({ text: 'a'.repeat(3000), kind: 'general' })

    const ctx = await service.loadPromptContext('chat')
    expect(ctx.general).toHaveLength(1)
    expect(ctx.general[0].text.length).toBeLessThanOrEqual(220)
  })

  it('respects the budget of the whole block', async () => {
    for (let i = 0; i < 15; i++) await service.save({ text: `${i} ${'b'.repeat(200)}`, kind: 'core' })
    for (let i = 0; i < 10; i++) await service.save({ text: `${i} ${'c'.repeat(200)}`, kind: 'general' })

    const ctx = await service.loadPromptContext('chat')
    const lines = [...ctx.core, ...ctx.project, ...ctx.general, ...ctx.learning, ...ctx.seasonal, ...ctx.promotable]
    const total = lines.reduce((sum, memory) => sum + memory.text.length + 8, 0)

    expect(total).toBeLessThanOrEqual(3600)
    // The budget bites before the item ceiling: it is the one in charge.
    expect(ctx.general.length).toBeLessThan(10)
  })
})
