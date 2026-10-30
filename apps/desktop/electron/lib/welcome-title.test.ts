import { describe, expect, it } from 'vitest'
import { pickWelcomeTitle, WELCOME_TITLE_KEYS } from '@shared/welcome-title'
import ptBR from '../../src/i18n/locales/pt-BR.json'
import en from '../../src/i18n/locales/en.json'

/** Resolves "chat.empty.startTitle" in the translation JSON. */
function resolve(locale: unknown, key: string): unknown {
  return key.split('.').reduce<unknown>((node, part) => {
    if (!node || typeof node !== 'object') return undefined
    return (node as Record<string, unknown>)[part]
  }, locale)
}

describe('pickWelcomeTitle', () => {
  it('in a chat without a name it uses the conversation phrases', () => {
    expect(pickWelcomeTitle({ mode: 'chat', userName: null, seed: 0 })).toBe('chat.empty.startTitle')
    expect(pickWelcomeTitle({ mode: 'chat', userName: null, seed: 0.3 })).toBe('chat.empty.titleHelloCasual')
  })

  it('in code without a name it uses building and starting point', () => {
    const keys = [0, 0.2, 0.4, 0.6, 0.8, 0.99].map((seed) =>
      pickWelcomeTitle({ mode: 'code', userName: null, seed }),
    )
    expect(keys).toContain('chat.empty.titleWhatToBuild')
    expect(keys).toContain('chat.empty.titleWhereStart')
    // No greeting in the code: there the title is about the work.
    expect(keys).not.toContain('chat.empty.titleHelloCasual')
  })

  it('only greets by name when the name exists', () => {
    const withName = Array.from({ length: 20 }, (_, i) =>
      pickWelcomeTitle({ mode: 'chat', userName: 'Ana', hour: 9, seed: i / 20 }),
    )
    expect(withName).toContain('chat.empty.hello')
    expect(withName).toContain('chat.empty.titleMorning')

    const withoutName = Array.from({ length: 20 }, (_, i) =>
      pickWelcomeTitle({ mode: 'chat', userName: '   ', hour: 9, seed: i / 20 }),
    )
    for (const key of withoutName) expect(key).not.toContain('Name')
    expect(withoutName).not.toContain('chat.empty.hello')
  })

  it('chooses the greeting by the time of day', () => {
    const pool = (hour: number) =>
      Array.from({ length: 40 }, (_, i) => pickWelcomeTitle({ mode: 'chat', userName: 'Ana', hour, seed: i / 40 }))
    expect(pool(8)).toContain('chat.empty.titleMorning')
    expect(pool(15)).toContain('chat.empty.titleAfternoon')
    expect(pool(22)).toContain('chat.empty.titleEvening')
  })

  it('is stable for the same seed and does not blow up with an out-of-range seed', () => {
    const a = pickWelcomeTitle({ mode: 'code', userName: null, seed: 0.42 })
    const b = pickWelcomeTitle({ mode: 'code', userName: null, seed: 0.42 })
    expect(a).toBe(b)
    expect(pickWelcomeTitle({ mode: 'code', userName: null, seed: 1 })).toBeTruthy()
    expect(pickWelcomeTitle({ mode: 'code', userName: null, seed: Number.NaN })).toBe('chat.empty.startTitle')
  })
})

describe('home screen titles', () => {
  it('every key exists in pt-BR and en', () => {
    for (const key of WELCOME_TITLE_KEYS) {
      expect(resolve(ptBR, key), `pt-BR: ${key}`).toEqual(expect.any(String))
      expect(resolve(en, key), `en: ${key}`).toEqual(expect.any(String))
    }
  })

  it('fits the title without breaking the line (whitespace-nowrap)', () => {
    // The real name varies; 7 characters is a comfortable middle ground.
    for (const key of WELCOME_TITLE_KEYS) {
      const text = String(resolve(ptBR, key)).replace('{{name}}', 'Desknik')
      expect(text.length, key).toBeLessThanOrEqual(40)
    }
  })
})
