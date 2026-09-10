import { describe, expect, it, vi } from 'vitest'

import { loadMainLocale, MESSAGES, resolveMainLocale, setMainLocale, t } from './i18n'

/**
 * As notificações nativas nascem no main, longe do i18next do renderer: sem
 * estes testes, uma frase nova sem tradução só apareceria como bug na tela de
 * quem usa o app no outro idioma — exatamente o caso que originou este módulo.
 */
let mockStoredLanguage: string | undefined
let mockReadFails = false

vi.mock('./app-language', () => ({
  readAppLanguage: async () => {
    if (mockReadFails) throw new Error('storage corrompido')
    return mockStoredLanguage
  },
}))

describe('resolveMainLocale', () => {
  it('reconhece o nome publicado pelo renderer e o código do locale', () => {
    expect(resolveMainLocale('Portuguese')).toBe('pt-BR')
    expect(resolveMainLocale('pt-BR')).toBe('pt-BR')
    expect(resolveMainLocale('English')).toBe('en')
  })

  it('cai em inglês sem valor — mesmo default do renderer', () => {
    expect(resolveMainLocale(undefined)).toBe('en')
    expect(resolveMainLocale('')).toBe('en')
  })
})

describe('t', () => {
  it('traduz pelo idioma publicado e interpola as variáveis', async () => {
    setMainLocale('Portuguese')
    expect(await t('notif.permission.title')).toBe('Permissão necessária')
    expect(await t('notif.batch.more', { count: 2 })).toBe('(+2 mais)')

    setMainLocale('English')
    expect(await t('notif.permission.title')).toBe('Permission required')
    expect(await t('notif.batch.more', { count: 2 })).toBe('(+2 more)')
  })

  it('lê o idioma persistido quando nada foi publicado ainda', async () => {
    mockStoredLanguage = 'English'
    await loadMainLocale()
    expect(await t('notif.chatError.title')).toBe('Chat error')
  })

  it('não lança com storage corrompido — vale o idioma já em memória', async () => {
    setMainLocale('pt-BR')
    mockReadFails = true
    await expect(loadMainLocale()).resolves.toBeUndefined()
    expect(await t('notif.chatError.title')).toBe('Erro no chat')
    mockReadFails = false
  })

  it('cobre toda chave nos dois idiomas', () => {
    for (const [key, byLocale] of Object.entries(MESSAGES)) {
      expect(byLocale['pt-BR'].length, `${key} sem pt-BR`).toBeGreaterThan(0)
      expect(byLocale.en.length, `${key} sem en`).toBeGreaterThan(0)
      expect(byLocale['pt-BR'], `${key} igual nos dois idiomas`).not.toBe(byLocale.en)
    }
  })
})
