import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { MessagePart } from '@shared/chat'

/**
 * `companion-http` importa o electron (app, BrowserWindow) e sobe servidor —
 * nada disso existe aqui. O único ponto que o model-rotation usa dele é o
 * cache de modelos por sessão, então é ele que o mock expõe.
 */
const sessionModelsCache = vi.hoisted(() => ({ current: {} as Record<string, { providerId: string; modelId: string }> }))

vi.mock('./companion-http', () => ({
  getSessionModelsCache: () => sessionModelsCache.current,
}))

const { MAX_ROTATION_ATTEMPTS, hasStreamedContent, resolveRotation, selectNext, setRotationConfigCache } =
  await import('./model-rotation')

const model = (id: string) => ({ providerId: 'openai', modelId: id })
const fallback = model('fallback')

beforeEach(() => {
  sessionModelsCache.current = {}
  setRotationConfigCache({ rotations: [], sessionOverrides: {} })
})

describe('resolveRotation', () => {
  it('sem rotação e sem modelo pinado, usa o modelo que o renderer resolveu', () => {
    expect(resolveRotation('s1', fallback)).toEqual([fallback])
  })

  it('modelo pinado no chat vence o fallback global', () => {
    sessionModelsCache.current = { s1: model('pinado') }
    expect(resolveRotation('s1', fallback)).toEqual([model('pinado')])
  })

  it('rotação escolhida no chat vence o modelo pinado', () => {
    // A precedência importa: o engine resolve a rotação ANTES do pino, então
    // escolher um modelo precisa limpar a rotação do chat (é o que o seletor
    // faz nos dois apps). Se isto inverter, o modelo escolhido não vale.
    sessionModelsCache.current = { s1: model('pinado') }
    setRotationConfigCache({
      rotations: [{ id: 'r1', name: 'A', models: [model('a'), model('b')] }],
      sessionOverrides: { s1: 'r1' },
    })
    expect(resolveRotation('s1', fallback)).toEqual([model('a'), model('b')])
  })

  it('a rotação vale só no chat que a escolheu', () => {
    setRotationConfigCache({
      rotations: [{ id: 'r1', name: 'A', models: [model('a')] }],
      sessionOverrides: { s1: 'r1' },
    })
    expect(resolveRotation('s2', fallback)).toEqual([fallback])
  })

  it('chat novo (sem sessionId) usa a chave draft', () => {
    setRotationConfigCache({
      rotations: [{ id: 'r1', name: 'A', models: [model('a')] }],
      sessionOverrides: { draft: 'r1' },
    })
    expect(resolveRotation(undefined, fallback)).toEqual([model('a')])
  })

  it('corta a sequência no teto de tentativas', () => {
    const models = ['a', 'b', 'c', 'd'].map(model)
    setRotationConfigCache({
      rotations: [{ id: 'r1', name: 'A', models }],
      sessionOverrides: { s1: 'r1' },
    })
    const seq = resolveRotation('s1', fallback)
    expect(seq).toHaveLength(MAX_ROTATION_ATTEMPTS)
    expect(seq).toEqual(models.slice(0, MAX_ROTATION_ATTEMPTS))
  })

  it('rotação vazia cai no comportamento normal em vez de sequência vazia', () => {
    // Uma rotação recém-criada, ainda sem slot, não pode zerar a sequência do
    // turno — seria um chat que simplesmente não responde.
    setRotationConfigCache({
      rotations: [{ id: 'r1', name: 'A', models: [] }],
      sessionOverrides: { s1: 'r1' },
    })
    expect(resolveRotation('s1', fallback)).toEqual([fallback])
  })

  it('escolha apontando para rotação removida cai no comportamento normal', () => {
    setRotationConfigCache({ rotations: [], sessionOverrides: { s1: 'sumiu' } })
    expect(resolveRotation('s1', fallback)).toEqual([fallback])
  })

  it('cache limpo (null) não derruba a resolução', () => {
    setRotationConfigCache(null)
    expect(resolveRotation('s1', fallback)).toEqual([fallback])
  })
})

describe('selectNext', () => {
  it('anda pela sequência e devolve undefined ao esgotar', () => {
    const seq = [model('a'), model('b')]
    expect(selectNext(seq, 0)).toEqual(model('a'))
    expect(selectNext(seq, 1)).toEqual(model('b'))
    expect(selectNext(seq, 2)).toBeUndefined()
  })
})

describe('hasStreamedContent', () => {
  const text = (value: string): MessagePart => ({ type: 'text', id: 't1', state: 'done', text: value })
  const reasoning = (value: string): MessagePart =>
    ({ type: 'reasoning', id: 'r1', state: 'done', text: value }) as MessagePart
  const tool = (): MessagePart => ({ type: 'tool', tool: 'read', state: 'done' }) as MessagePart

  // A v1 só rotaciona ANTES do primeiro token de saída: reenviar um turno que
  // já entregou conteúdo cobraria os tokens de novo.
  it('turno ainda sem saída pode rotacionar', () => {
    expect(hasStreamedContent([])).toBe(false)
    expect(hasStreamedContent([text('')])).toBe(false)
  })

  it('texto, raciocínio ou tool já emitidos travam a rotação', () => {
    expect(hasStreamedContent([text('oi')])).toBe(true)
    expect(hasStreamedContent([reasoning('pensando')])).toBe(true)
    expect(hasStreamedContent([tool()])).toBe(true)
  })
})
