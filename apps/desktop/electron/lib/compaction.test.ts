import { describe, expect, it } from 'vitest'

import type { CatalogModel, ChatMessage, TokenUsage } from '@shared/chat'
import { findLastSummaryIndex, shouldCompact, splitForCompaction } from './compaction'

/**
 * Decisões que só falham em conversa longa, onde o defeito é caro e difícil de
 * reproduzir: compactar cedo demais joga contexto fora sem necessidade;
 * compactar tarde demais estoura o limite do modelo e o turno morre.
 *
 * `compactHistory` não entra aqui — ela chama o modelo. O que está coberto é
 * a aritmética que decide QUANDO e O QUE compactar.
 */

const msg = (role: 'user' | 'assistant', over: Partial<ChatMessage> = {}): ChatMessage =>
  ({ id: Math.random().toString(36), role, parts: [], createdAt: 0, ...over }) as ChatMessage

/** Alterna user/assistant: [u, a, u, a, ...] */
const conversation = (pairs: number): ChatMessage[] =>
  Array.from({ length: pairs * 2 }, (_, i) => msg(i % 2 === 0 ? 'user' : 'assistant'))

const model = (context: number, output = 8_000): CatalogModel =>
  ({ id: 'm', name: 'M', limit: { context, output } }) as CatalogModel

const usage = (input: number, output = 0, lastStep?: { input: number; output: number }): TokenUsage =>
  ({ input, output, ...(lastStep ? { lastStep } : {}) }) as TokenUsage

describe('shouldCompact', () => {
  it('não compacta sem usage ou sem limite conhecido do modelo', () => {
    expect(shouldCompact(undefined, model(100_000))).toBe(false)
    expect(shouldCompact(usage(90_000), undefined)).toBe(false)
    expect(shouldCompact(usage(90_000), { id: 'm', name: 'M' } as CatalogModel)).toBe(false)
  })

  it('não compacta com contexto folgado', () => {
    expect(shouldCompact(usage(10_000), model(200_000))).toBe(false)
  })

  it('compacta ao encostar no limite menos a reserva de saída', () => {
    // 100k de contexto, 8k de saída + 4k de padding = dispara em 88k.
    expect(shouldCompact(usage(87_000), model(100_000))).toBe(false)
    expect(shouldCompact(usage(88_000), model(100_000))).toBe(true)
  })

  it('prefere lastStep ao total do turno', () => {
    // input/output somam TODOS os steps do turno (inflados por idas e vindas
    // de tool); lastStep é o contexto real da última chamada. Usar o total
    // faria a conversa compactar muito antes do necessário.
    const inflado = usage(500_000, 20_000, { input: 10_000, output: 500 })
    expect(shouldCompact(inflado, model(200_000))).toBe(false)
  })

  it('cai no total quando a mensagem é antiga e não tem lastStep', () => {
    expect(shouldCompact(usage(190_000), model(200_000))).toBe(true)
  })

  it('respeita o teto absoluto em modelos de contexto gigante', () => {
    // Sem o teto de 300k, um modelo de 1M só compactaria perto de 1M — a
    // conversa operaria rotineiramente com centenas de milhares de tokens.
    expect(shouldCompact(usage(290_000), model(1_000_000, 8_000))).toBe(true)
  })

  it('limita a reserva de saída pelo teto, não pelo que o modelo anuncia', () => {
    // Saída anunciada de 64k é maior que o cap de 16k: a reserva usada é 16k
    // + 4k, então dispara em 80k e não em 32k.
    expect(shouldCompact(usage(70_000), model(100_000, 64_000))).toBe(false)
    expect(shouldCompact(usage(80_000), model(100_000, 64_000))).toBe(true)
  })
})

describe('findLastSummaryIndex', () => {
  it('devolve -1 sem nenhum summary', () => {
    expect(findLastSummaryIndex(conversation(3))).toBe(-1)
  })

  it('acha o ÚLTIMO summary, não o primeiro', () => {
    const history = [msg('user'), msg('assistant', { summary: true }), msg('user'), msg('assistant', { summary: true })]
    expect(findLastSummaryIndex(history)).toBe(3)
  })
})

describe('splitForCompaction', () => {
  it('não compacta conversa curta — não sobra par antes da cauda', () => {
    expect(splitForCompaction(conversation(2))).toBeNull()
  })

  it('preserva os dois últimos turnos de usuário intactos', () => {
    const history = conversation(5) // 10 mensagens, users em 0,2,4,6,8
    const split = splitForCompaction(history)
    expect(split).not.toBeNull()
    // Corta no penúltimo user (índice 6): 6 e 8 ficam de fora do resumo.
    expect(split!.cutIndex).toBe(6)
    expect(split!.old).toHaveLength(6)
  })

  it('refunde o resumo anterior no novo em vez de empilhar resumos', () => {
    const history = [
      msg('user'),
      msg('assistant'),
      msg('assistant', { summary: true }),
      ...conversation(4),
    ]
    const split = splitForCompaction(history)
    // Começa NO summary (índice 2), não depois dele: o resumo antigo entra no
    // novo. Começar depois faria a conversa acumular um resumo por compactação.
    expect(split!.old[0].summary).toBe(true)
  })

  it('não recompacta o que já está resumido quando sobra pouco depois', () => {
    const history = [msg('user'), msg('assistant', { summary: true }), msg('user'), msg('assistant')]
    expect(splitForCompaction(history)).toBeNull()
  })

  it('histórico vazio não compacta', () => {
    expect(splitForCompaction([])).toBeNull()
  })
})
