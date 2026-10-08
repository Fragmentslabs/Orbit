import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_APP_SETTINGS, normalizeAppSettings } from '@shared/app-settings'
import type { SendMessageInput } from '@shared/chat'

vi.mock('./storage', () => ({ readJson: vi.fn(async () => null), writeJson: vi.fn(async () => {}) }))

const { agentMayUseBrowser, setAppSettings } = await import('./app-settings')

const input = (fromBrowser?: boolean): SendMessageInput => ({
  sessionId: 's1',
  text: 'teste a tela',
  providerId: 'p',
  modelId: 'm',
  mode: 'code',
  options: { fromBrowser },
})

describe('normalizeAppSettings', () => {
  it('sem nada salvo, vale o comportamento de antes das opções existirem', () => {
    expect(normalizeAppSettings(undefined)).toEqual(DEFAULT_APP_SETTINGS)
  })

  it('descarta valores fora do domínio e completa o que falta', () => {
    const settings = normalizeAppSettings({
      chatView: 'gigante',
      autoArchiveDays: 5,
      deleteArchivedDays: 2,
      autoCompact: 'off',
      transientRetries: 99,
      autoContinues: 2,
      browser: { cookies: 'until-quit' },
    })
    expect(settings.chatView).toBe('summary')
    expect(settings.autoArchiveDays).toBeNull()
    expect(settings.deleteArchivedDays).toBeNull()
    // "Desligada" deixou de existir: a escolha salva por uma versão antiga volta ao padrão.
    expect(settings.autoCompact).toBe('auto')
    expect(settings.transientRetries).toBe(3)
    expect(settings.autoContinues).toBe(2)
    expect(settings.browser).toEqual({ links: 'integrated', agentTools: true, cookies: 'until-quit' })
  })

  it('aceita os prazos curtos de arquivamento', () => {
    expect(normalizeAppSettings({ autoArchiveDays: 2 }).autoArchiveDays).toBe(2)
    expect(normalizeAppSettings({ autoArchiveDays: 3 }).autoArchiveDays).toBe(3)
    expect(normalizeAppSettings({ deleteArchivedDays: 30 }).deleteArchivedDays).toBe(30)
  })

  it('a largura da sidebar fica dentro do arrastável, com o tamanho de sempre por padrão', () => {
    expect(normalizeAppSettings(undefined).sidebarWidth).toBe(256)
    expect(normalizeAppSettings({ sidebarWidth: 300 }).sidebarWidth).toBe(300)
    // Salvo fora do domínio (janela de outro tamanho, valor corrompido): a
    // largura é trazida para a borda em vez de descartada.
    expect(normalizeAppSettings({ sidebarWidth: 9999 }).sidebarWidth).toBe(420)
    expect(normalizeAppSettings({ sidebarWidth: 10 }).sidebarWidth).toBe(200)
    expect(normalizeAppSettings({ sidebarWidth: Number.NaN }).sidebarWidth).toBe(256)
  })
})

describe('agentMayUseBrowser', () => {
  it('com a opção ligada, o agente usa o navegador por conta própria', async () => {
    await setAppSettings({ browser: { agentTools: true } })
    expect(agentMayUseBrowser(input())).toBe(true)
  })

  it('desligada, só quando o pedido veio do chat do navegador em tela cheia', async () => {
    await setAppSettings({ browser: { agentTools: false } })
    expect(agentMayUseBrowser(input())).toBe(false)
    expect(agentMayUseBrowser(input(true))).toBe(true)
  })
})
