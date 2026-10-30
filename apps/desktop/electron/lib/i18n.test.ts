import { describe, expect, it, vi } from 'vitest'

import { loadMainLocale, MESSAGES, resolveMainLocale, setMainLocale, t, tNow } from './i18n'

/**
 * Native notifications are born in the main, far from the renderer's i18next: without
 * these tests, a new sentence without translation would only show up as a bug on the screen of
 * whoever uses the app in the other language — exactly the case that originated this module.
 */
let mockStoredLanguage: string | undefined
let mockReadFails = false

vi.mock('./app-language', () => ({
  readAppLanguage: async () => {
    if (mockReadFails) throw new Error('corrupted storage')
    return mockStoredLanguage
  },
}))

describe('resolveMainLocale', () => {
  it('recognizes the name published by the renderer and the locale code', () => {
    expect(resolveMainLocale('Portuguese')).toBe('pt-BR')
    expect(resolveMainLocale('pt-BR')).toBe('pt-BR')
    expect(resolveMainLocale('English')).toBe('en')
  })

  it('falls back to English with no value — same default as the renderer', () => {
    expect(resolveMainLocale(undefined)).toBe('en')
    expect(resolveMainLocale('')).toBe('en')
  })
})

describe('t', () => {
  it('translates by the published language and interpolates the variables', async () => {
    setMainLocale('Portuguese')
    expect(await t('notif.permission.title')).toBe('Permissão necessária')
    expect(await t('notif.batch.more', { count: 2 })).toBe('(+2 mais)')

    setMainLocale('English')
    expect(await t('notif.permission.title')).toBe('Permission required')
    expect(await t('notif.batch.more', { count: 2 })).toBe('(+2 more)')
  })

  it('reads the persisted language when nothing was published yet', async () => {
    mockStoredLanguage = 'English'
    await loadMainLocale()
    expect(await t('notif.chatError.title')).toBe('Chat error')
  })

  it('does not throw on corrupted storage — the language already in memory wins', async () => {
    setMainLocale('pt-BR')
    mockReadFails = true
    await expect(loadMainLocale()).resolves.toBeUndefined()
    expect(await t('notif.chatError.title')).toBe('Erro no chat')
    mockReadFails = false
  })

  it('covers every key in both languages', () => {
    for (const [key, byLocale] of Object.entries(MESSAGES)) {
      expect(byLocale['pt-BR'].length, `${key} without pt-BR`).toBeGreaterThan(0)
      expect(byLocale.en.length, `${key} without en`).toBeGreaterThan(0)
      expect(byLocale['pt-BR'], `${key} identical in both languages`).not.toBe(byLocale.en)
    }
  })
})

describe('tNow', () => {
  it('translates on the fly with the language in memory, for the activity feed', () => {
    setMainLocale('Portuguese')
    expect(tNow('panel.activity.navigate', { url: 'https://x.dev' })).toBe('Navegando para https://x.dev')
    setMainLocale('English')
    expect(tNow('panel.activity.navigate', { url: 'https://x.dev' })).toBe('Navigating to https://x.dev')
  })
})
