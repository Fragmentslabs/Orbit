import { describe, expect, it } from 'vitest'
import { pickWelcomeTitle, WELCOME_TITLE_KEYS } from '@shared/welcome-title'
import ptBR from '../../src/i18n/locales/pt-BR.json'
import en from '../../src/i18n/locales/en.json'

/** Resolve "chat.empty.startTitle" no JSON de tradução. */
function resolve(locale: unknown, key: string): unknown {
  return key.split('.').reduce<unknown>((node, part) => {
    if (!node || typeof node !== 'object') return undefined
    return (node as Record<string, unknown>)[part]
  }, locale)
}

describe('pickWelcomeTitle', () => {
  it('no chat sem nome usa as frases de conversa', () => {
    expect(pickWelcomeTitle({ mode: 'chat', userName: null, seed: 0 })).toBe('chat.empty.startTitle')
    expect(pickWelcomeTitle({ mode: 'chat', userName: null, seed: 0.3 })).toBe('chat.empty.titleHelloCasual')
  })

  it('no código sem nome usa construção e ponto de partida', () => {
    const keys = [0, 0.2, 0.4, 0.6, 0.8, 0.99].map((seed) =>
      pickWelcomeTitle({ mode: 'code', userName: null, seed }),
    )
    expect(keys).toContain('chat.empty.titleWhatToBuild')
    expect(keys).toContain('chat.empty.titleWhereStart')
    // Nada de saudação no código: lá o título é sobre o trabalho.
    expect(keys).not.toContain('chat.empty.titleHelloCasual')
  })

  it('só cumprimenta pelo nome quando o nome existe', () => {
    const comNome = Array.from({ length: 20 }, (_, i) =>
      pickWelcomeTitle({ mode: 'chat', userName: 'Ana', hour: 9, seed: i / 20 }),
    )
    expect(comNome).toContain('chat.empty.hello')
    expect(comNome).toContain('chat.empty.titleMorning')

    const semNome = Array.from({ length: 20 }, (_, i) =>
      pickWelcomeTitle({ mode: 'chat', userName: '   ', hour: 9, seed: i / 20 }),
    )
    for (const key of semNome) expect(key).not.toContain('Name')
    expect(semNome).not.toContain('chat.empty.hello')
  })

  it('escolhe a saudação pela hora do dia', () => {
    const pool = (hour: number) =>
      Array.from({ length: 40 }, (_, i) => pickWelcomeTitle({ mode: 'chat', userName: 'Ana', hour, seed: i / 40 }))
    expect(pool(8)).toContain('chat.empty.titleMorning')
    expect(pool(15)).toContain('chat.empty.titleAfternoon')
    expect(pool(22)).toContain('chat.empty.titleEvening')
  })

  it('é estável para a mesma semente e não estoura com seed fora de faixa', () => {
    const a = pickWelcomeTitle({ mode: 'code', userName: null, seed: 0.42 })
    const b = pickWelcomeTitle({ mode: 'code', userName: null, seed: 0.42 })
    expect(a).toBe(b)
    expect(pickWelcomeTitle({ mode: 'code', userName: null, seed: 1 })).toBeTruthy()
    expect(pickWelcomeTitle({ mode: 'code', userName: null, seed: Number.NaN })).toBe('chat.empty.startTitle')
  })
})

describe('títulos da tela inicial', () => {
  it('toda chave existe em pt-BR e en', () => {
    for (const key of WELCOME_TITLE_KEYS) {
      expect(resolve(ptBR, key), `pt-BR: ${key}`).toEqual(expect.any(String))
      expect(resolve(en, key), `en: ${key}`).toEqual(expect.any(String))
    }
  })

  it('cabe no título sem quebrar linha (whitespace-nowrap)', () => {
    // O nome real varia; 7 caracteres é um meio-termo confortável.
    for (const key of WELCOME_TITLE_KEYS) {
      const text = String(resolve(ptBR, key)).replace('{{name}}', 'Desknik')
      expect(text.length, key).toBeLessThanOrEqual(40)
    }
  })
})
