/**
 * Recuperação do turno: candidatos, política de dois níveis e bloco de prompt.
 *
 * O motor de embeddings é substituído por vetores fixos — o que se testa aqui
 * é a decisão e a montagem do contexto, não o Bekko (esse é medido no
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

describe('política de dois níveis', () => {
  it('evidência forte injeta o conteúdo', async () => {
    const ctx = await retrieveMemoryContext({ message: 'posso levar mala no voo?', pool })
    expect(ctx?.inject.map((m) => m.id)).toEqual(['voo'])
    expect(ctx?.degraded).toBe(false)
  })

  it('evidência fraca vira ponteiro, não injeção', async () => {
    // Quatro dimensões para caber um cosseno baixo com TODAS as memórias:
    // 0,35 para "voo" (a mais parecida) e menos para as outras, tudo abaixo do
    // limiar de injeção (piso 0,2 + 0,22 = 0,42) e acima do de ponteiro (0,2).
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

  it('sem evidência não devolve nada', async () => {
    // Consulta equilibrada: nenhuma memória passa de 0,58 de cosseno.
    embedTexts.mockResolvedValue([vec(Math.sqrt(1 / 3), Math.sqrt(1 / 3), Math.sqrt(1 / 3))])
    // Acervo ruidoso: o piso sobe acima de qualquer cosseno desta consulta.
    noiseFloorFor.mockResolvedValue([0.85])
    const ctx = await retrieveMemoryContext({ message: 'qual a capital da Austrália?', pool })
    expect(ctx?.inject).toEqual([])
    expect(ctx?.pointers).toEqual([])
  })

  it('memória longa demais vira ponteiro em vez de desaparecer', async () => {
    const long = memory({ id: 'longa', text: `${'frase '.repeat(150)}fim` })
    expect(long.text.length).toBeGreaterThan(SELECTION.maxInjectChars)
    vectorsById.mockResolvedValue(new Map([['longa', vec(1, 0, 0)]]))
    const ctx = await retrieveMemoryContext({ message: 'me fala da frase', pool: [long] })
    expect(ctx?.inject).toEqual([])
    expect(ctx?.pointers.map((m) => m.id)).toEqual(['longa'])
  })

  it('core não entra na recuperação (já está no bloco fixo)', async () => {
    // o filtro é do serviço; aqui garantimos que a recuperação não inventa nada
    const ctx = await retrieveMemoryContext({ message: 'qualquer coisa', pool: [] })
    expect(ctx).toBeNull()
  })
})

describe('fallback lexical', () => {
  it('sem índice semântico, acha por termo e só aponta', async () => {
    vectorsById.mockResolvedValue(new Map())
    embedTexts.mockReset()
    const ctx = await retrieveMemoryContext({ message: 'mala de mão corredor', pool })
    expect(ctx?.degraded).toBe(true)
    expect(ctx?.inject).toEqual([])
    expect(ctx?.pointers.map((m) => m.id)).toContain('voo')
    expect(embedTexts).not.toHaveBeenCalled()
  })

  it('mensagem sem termo em comum não devolve ponteiro', async () => {
    vectorsById.mockResolvedValue(new Map())
    const ctx = await retrieveMemoryContext({ message: 'fotossíntese', pool })
    expect(ctx?.pointers).toEqual([])
  })
})

describe('contexto recente', () => {
  it('mensagem curta sem evidência usa o turno anterior', async () => {
    noiseFloorFor.mockResolvedValue([0.6])
    embedTexts
      // isolada: fraca para todas as memórias (0,58 < piso de ponteiro 0,6)
      .mockResolvedValueOnce([vec(Math.sqrt(1 / 3), Math.sqrt(1 / 3), Math.sqrt(1 / 3))])
      .mockResolvedValueOnce([vec(1, 0, 0)]) // com contexto: chega na memória certa
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

  it('troca de assunto não herda o contexto anterior', async () => {
    embedTexts.mockResolvedValue([vec(0, 0, 1)])
    const ctx = await retrieveMemoryContext({
      message: 'Qual my número da academia?',
      pool,
      recent: [{ role: 'user', text: 'Estou pensando em comprar uma passagem para o Rio' }],
    })
    // achou o Atlas (evidência), então não haveria retry; o que importa é não
    // ter consultado o contexto de viagem
    const calls = embedTexts.mock.calls.map((c) => c[0][0] as string)
    expect(calls.every((text) => !text.includes('passagem para o Rio'))).toBe(true)
    expect(ctx).not.toBeNull()
  })
})

describe('bloco do prompt', () => {
  it('separa injeção de ponteiro e mostra o id do ponteiro', async () => {
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

  it('sem memória não gasta um caractere', () => {
    expect(renderMemoryBlock(null)).toBe('')
    expect(
      renderMemoryBlock({ inject: [], pointers: [], degraded: false, thresholds: { inject: 0, pointer: 0 }, topCos: null }),
    ).toBe('')
  })

  it('marca documento anexado para o modelo abrir', () => {
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
 * A sugestão do turno existe para resolver a descoberta SEM passar o conteúdo
 * adiante. O que se testa aqui é justamente isso: o que sai são ids e
 * metadados, e quem já está no bloco fixo do prompt fica de fora.
 */
describe('sugestões do turno', () => {
  const tiny = [
    memory({ id: 'voo', text: 'Prefere assento no corredor em voos longos.' }),
    memory({ id: 'jazz', text: 'Gosta de jazz e compra discos de vinil.' }),
  ]

  // Sem vetores, o caminho é o lexical — é o piso quando o modelo falta.
  beforeEach(() => {
    vectorsById.mockResolvedValue(new Map())
  })

  it('devolve id e metadados, nunca o texto', async () => {
    const found = await suggestMemories({ message: 'corredor no voo', pool: tiny })
    expect(found.map((s) => s.id)).toEqual(['voo'])
    expect(found[0]).not.toHaveProperty('text')
    expect(found[0]).toMatchObject({ id: 'voo', kind: 'general' })
  })

  it('não repete o que já está no bloco do prompt', async () => {
    const found = await suggestMemories({ message: 'voos', pool: tiny })
    const first = found[0].id
    const rest = await suggestMemories({ message: 'voos', pool: tiny, exclude: [first] })
    expect(rest.map((s) => s.id)).not.toContain(first)
  })

  it('não sugere nada quando nada casa', async () => {
    expect(await suggestMemories({ message: 'xilofone quantico', pool: tiny })).toEqual([])
  })

  it('o bloco é rotulado como não verificado e não carrega conteúdo', () => {
    const block = renderMemorySuggestions([
      { id: 'voo', kind: 'general', area: 'preferences', category: 'preference' },
    ])
    expect(block).toContain('unverified')
    expect(block).toContain('memory_open')
    expect(block).toContain('voo · general/preferences/preference')
    // O fato não viaja: só o enquadramento.
    expect(block).not.toContain('corredor')
    expect(renderMemorySuggestions([])).toBe('')
  })
})
