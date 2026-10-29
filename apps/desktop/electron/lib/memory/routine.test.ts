import { describe, expect, it } from 'vitest'
import { dueActions, extractJson, tokenSimilarity } from './routine'

const H = 60 * 60 * 1000

describe('rotina de memória', () => {
  it('desligada não faz nada, mesmo depois de dias', () => {
    expect(dueActions('off', {}, 1000 * H)).toEqual({ capture: false, consolidate: false })
  })

  it('diária captura a cada 20h e nunca consolida', () => {
    const now = 100 * H
    expect(dueActions('daily', {}, now)).toEqual({ capture: true, consolidate: false })
    expect(dueActions('daily', { lastCaptureAt: now - 19 * H }, now).capture).toBe(false)
    expect(dueActions('daily', { lastCaptureAt: now - 21 * H }, now).capture).toBe(true)
    expect(dueActions('daily', { lastConsolidateAt: now - 90 * H }, now).consolidate).toBe(false)
  })

  it('semanal só consolida', () => {
    const now = 200 * H
    expect(dueActions('weekly', {}, now)).toEqual({ capture: false, consolidate: true })
    expect(dueActions('weekly', { lastConsolidateAt: now - 5 * 24 * H }, now).consolidate).toBe(false)
    expect(dueActions('weekly', { lastConsolidateAt: now - 7 * 24 * H }, now).consolidate).toBe(true)
  })

  it('diária + semanal roda as duas quando cada uma vence', () => {
    const now = 500 * H
    const state = { lastCaptureAt: now - 25 * H, lastConsolidateAt: now - 2 * 24 * H }
    expect(dueActions('daily+weekly', state, now)).toEqual({ capture: true, consolidate: false })
    expect(dueActions('daily+weekly', { ...state, lastConsolidateAt: now - 7 * 24 * H }, now)).toEqual({
      capture: true,
      consolidate: true,
    })
  })
})

describe('tokenSimilarity', () => {
  it('reconhece a mesma preferência escrita de outro jeito', () => {
    expect(
      tokenSimilarity(
        'Prefere ver um artefato antes de implementar a tela',
        'Sempre oferecer artefato antes de implementar qualquer tela',
      ),
    ).toBeGreaterThan(0.4)
  })

  it('separa assuntos diferentes — bem abaixo do limiar de 0.5', () => {
    expect(
      tokenSimilarity('Prefere ver um artefato antes de implementar', 'Roda os testes antes de commitar'),
    ).toBeLessThan(0.2)
  })
})

describe('extractJson', () => {
  it('lê o JSON mesmo cercado de prosa e cerca', () => {
    const raw = 'Claro:\n```json\n{"memorias":[{"texto":"Prefere artefato antes de implementar","categoria":"preference"}]}\n```'
    expect(extractJson(raw)).toEqual({
      memorias: [{ texto: 'Prefere artefato antes de implementar', categoria: 'preference' }],
    })
  })

  it('devolve null quando não há JSON', () => {
    expect(extractJson('sem nada aqui')).toBeNull()
  })
})
