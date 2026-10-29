/**
 * O contrato de gravação das memórias NOVAS: o enriquecimento que a ferramenta
 * manda precisa chegar ao que é gravado, sobreviver a uma fusão e poder ser
 * acrescentado depois por memory_update.
 *
 * Repositório e índice dublados em memória: nada aqui toca o acervo real nem
 * sobe o modelo.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Memory } from '@shared/memory'

const store = new Map<string, Memory>()
const docs = new Map<string, string>()

/**
 * Dublê do embedding: cada teste decide se há modelo, quais vetores existem e
 * qual é o vetor da consulta. `vi.hoisted` porque a fábrica do `vi.mock` roda
 * antes de qualquer `const` do arquivo.
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

describe('memória nova', () => {
  it('grava o enriquecimento enviado', async () => {
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

  it('a fusão não apaga o enriquecimento que já existia', async () => {
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
  it('acrescenta enriquecimento a uma memória que não tinha', async () => {
    const { id } = await service.save({ text: 'Usa pnpm no monorepo', kind: 'general' })
    expect(store.get(id)!.title).toBeUndefined()

    await service.revise(id, { title: 'Gerenciador de pacotes', keywords: ['pnpm'] })
    expect(store.get(id)!.title).toBe('Gerenciador de pacotes')
    expect(store.get(id)!.keywords).toEqual(['pnpm'])
  })

  it('reescrever o texto sem repetir os campos preserva o enriquecimento', async () => {
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

  it('sem modelo, encontra pelo termo exato', async () => {
    await service.save({ text: 'O relay n8n recebe os webhooks da Stripe', kind: 'general' })
    await service.save({ text: 'A paleta usa o amarelo oklch como primario', kind: 'general' })

    const found = await service.search({ query: 'relay webhooks', kinds: ['general'] })
    expect(found[0]?.text).toContain('relay n8n')
  })

  it('com modelo, o vetor traz o que o termo nao alcanca', async () => {
    const a = await service.save({ text: 'O relay n8n recebe os webhooks da Stripe', kind: 'general' })
    const b = await service.save({ text: 'A paleta usa o amarelo oklch como primario', kind: 'general' })
    emb.installed = true
    emb.vectors = new Map([
      [a.id, vec(1, 0)],
      [b.id, vec(0, 1)],
    ])
    emb.query = vec(0, 1)

    // Nenhum termo em comum com as duas: quem decide e o cosseno.
    const found = await service.search({ query: 'cor de destaque', kinds: ['general'] })
    expect(found[0]?.id).toBe(b.id)
  })

  it('nunca dispara download: sem modelo o piso e o lexical', async () => {
    await service.save({ text: 'O relay n8n recebe os webhooks', kind: 'general' })

    const found = await service.search({ query: 'zquiz', kinds: ['general'] })
    expect(found).toEqual([])
  })
})

/**
 * O escopo é o que impede a preferência de conversa de virar instrução de
 * código (e o aprendizado técnico de virar contexto de chat). O padrão é a
 * memória seguir o modo em que nasceu; `both` é decisão explícita.
 */
describe('escopo entre modos', () => {
  const ids = (list: Memory[]) => list.map((m) => m.id)

  it('general sem escopo gravado continua valendo nos dois modos', async () => {
    const { id } = await service.save({ text: 'Prefere respostas curtas', kind: 'general' })
    expect(store.get(id)!.scope).toBe('both')
    expect(ids((await service.loadPromptContext('chat')).general)).toContain(id)
    expect(ids((await service.loadPromptContext('code')).general)).toContain(id)
  })

  it('preferência gravada no chat não entra no prompt do código', async () => {
    const { id } = await service.save({ text: 'Não usar emojis nas respostas', kind: 'general', scope: 'chat' })
    expect(ids((await service.loadPromptContext('chat')).general)).toContain(id)
    expect(ids((await service.loadPromptContext('code')).general)).not.toContain(id)
  })

  it('a promoção de seasonal herda o escopo de origem em vez de virar both', async () => {
    const { id } = await service.save({ text: 'Costuma revisar o diff antes de commitar', kind: 'seasonal' })
    await service.promote(id)
    expect(store.get(id)!.kind).toBe('general')
    expect(store.get(id)!.scope).toBe('chat')
    expect(ids((await service.loadPromptContext('code')).general)).not.toContain(id)
  })

  it('re-salvar não move o escopo; só "both" amplia', async () => {
    const { id } = await service.save({ text: 'Prefere respostas curtas', kind: 'general', scope: 'chat' })
    await service.save({ text: 'Prefere respostas curtas', kind: 'general', scope: 'chat' })
    expect(store.get(id)!.scope).toBe('chat')
    await service.save({ text: 'Prefere respostas curtas', kind: 'general', scope: 'both' })
    expect(store.get(id)!.scope).toBe('both')
  })

  it('a busca filtra pelo modo de quem procura', async () => {
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
 * O bloco do system prompt é enviado em TODA mensagem, para sempre. O limite
 * tem que ser de tamanho: contar memórias não protege contra uma memória longa.
 */
describe('bloco do system prompt', () => {
  it('corta uma memória longa em vez de despejar o texto inteiro', async () => {
    await service.save({ text: 'a'.repeat(3000), kind: 'general' })

    const ctx = await service.loadPromptContext('chat')
    expect(ctx.general).toHaveLength(1)
    expect(ctx.general[0].text.length).toBeLessThanOrEqual(220)
  })

  it('respeita o orçamento do bloco inteiro', async () => {
    for (let i = 0; i < 15; i++) await service.save({ text: `${i} ${'b'.repeat(200)}`, kind: 'core' })
    for (let i = 0; i < 10; i++) await service.save({ text: `${i} ${'c'.repeat(200)}`, kind: 'general' })

    const ctx = await service.loadPromptContext('chat')
    const lines = [...ctx.core, ...ctx.project, ...ctx.general, ...ctx.learning, ...ctx.seasonal, ...ctx.promotable]
    const total = lines.reduce((sum, memory) => sum + memory.text.length + 8, 0)

    expect(total).toBeLessThanOrEqual(3600)
    // O orçamento morde antes do teto de itens: é ele que está no comando.
    expect(ctx.general.length).toBeLessThan(10)
  })
})
