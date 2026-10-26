import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_APP_SETTINGS, normalizeAppSettings } from '@shared/app-settings'
import { OVERLAY_DEFAULTS, normalizeOverlaySettings } from '@shared/overlay'
import type { SendMessageInput } from '@shared/chat'

/**
 * Overlay: as preferências dele (atalho, modo de abertura, transparência) e o
 * que o prompt do turno diz ao agente. O comportamento da janela (atalho
 * global, captura, seleção) depende do Electron e é verificado no app.
 */

vi.mock('../memory/service', () => ({ loadPromptContext: async () => null }))
vi.mock('../skills', () => ({ loadSkills: async () => [] }))
vi.mock('../mcp', () => ({ listMcpToolDescriptions: () => [] }))
vi.mock('../past-chats', () => ({ buildPastChatsContext: async () => '', detectPastChatsIntent: () => false }))
// Subchats leem o storage (app.getPath), que não existe fora do Electron.
vi.mock('../subchats', () => ({ listSubchats: async () => [], formatSubchatsBlock: () => '' }))
vi.mock('../app-settings', async () => {
  const { DEFAULT_APP_SETTINGS: defaults } = await import('@shared/app-settings')
  return {
    agentMayUseBrowser: () => false,
    agentMayControlComputer: () => false,
    getAppSettings: () => defaults,
  }
})

const { buildSystemPrompt } = await import('../prompts')

function turn(options: SendMessageInput['options']): SendMessageInput {
  return {
    sessionId: 's1',
    text: 'traduz isso',
    providerId: 'p',
    modelId: 'm',
    mode: 'chat',
    options,
  } as SendMessageInput
}

describe('preferências do overlay', () => {
  it('sem nada salvo, abre falando, com persona e fundo quase sólido', () => {
    const overlay = normalizeOverlaySettings(undefined)
    expect(overlay).toEqual(OVERLAY_DEFAULTS)
    expect(overlay.openInCall).toBe(true)
    expect(overlay.persona).toBe(true)
  })

  it('transparência fora do domínio volta para o piso, não para zero', () => {
    expect(normalizeOverlaySettings({ opacity: 0.1 }).opacity).toBe(0.5)
    expect(normalizeOverlaySettings({ opacity: 7 }).opacity).toBe(1)
    expect(normalizeOverlaySettings({ opacity: Number.NaN }).opacity).toBe(OVERLAY_DEFAULTS.opacity)
  })

  it('modelo só vale com provedor e modelo; meio par vira null', () => {
    expect(normalizeOverlaySettings({ model: { providerId: 'anthropic', modelId: 'x' } }).model).toEqual({
      providerId: 'anthropic',
      modelId: 'x',
    })
    expect(normalizeOverlaySettings({ model: { providerId: 'anthropic' } }).model).toBeNull()
  })

  it('as configurações gerais carregam o bloco do overlay', () => {
    const settings = normalizeAppSettings({ overlay: { openInCall: true, opacity: 0.7 } })
    expect(settings.overlay.openInCall).toBe(true)
    expect(settings.overlay.opacity).toBe(0.7)
    // O que não veio herda o padrão — inclusive o atalho ligado.
    expect(settings.overlay.enabled).toBe(true)
  })

  it('um bloco antigo (sem overlay) não quebra a normalização', () => {
    const settings = normalizeAppSettings({ closeToTray: false })
    expect(settings.overlay).toEqual(DEFAULT_APP_SETTINGS.overlay)
  })
})

describe('prompt do overlay', () => {
  it('pede resposta curta e manda olhar a tela/seleção em vez de perguntar', async () => {
    const prompt = await buildSystemPrompt(turn({ overlay: true }))
    expect(prompt).toContain('OVERLAY (⇧⌘Space)')
    expect(prompt).toMatch(/Answer SHORT/i)
    expect(prompt).toContain('see_selection')
    expect(prompt).toContain('see_screen')
  })

  it('proíbe descrever a tela sem um resultado da tool neste turno', async () => {
    const prompt = await buildSystemPrompt(turn({ overlay: true }))
    // O caso real: o modelo disse "agora foi — vejo um VS Code aberto" sem
    // nunca ter chamado see_screen. A regra precisa ser explícita.
    expect(prompt).toContain('You CANNOT see the screen on your own')
    expect(prompt).toContain('NEVER describe or confirm a screen you did not receive')
    expect(prompt).toContain('NO sentence before it')
  })

  it('capacidade desligada vira recusa explícita, não invenção', async () => {
    const prompt = await buildSystemPrompt(turn({ overlay: true }))
    expect(prompt).toContain('Capabilities can be OFF in this mode')
    expect(prompt).toContain('say in one line that you cannot do it')
    expect(prompt).toContain('never pretend it worked')
  })

  it('fora do overlay não aparece', async () => {
    expect(await buildSystemPrompt(turn({}))).not.toContain('OVERLAY (⇧⌘Space)')
  })

  it('no modo chamada o agente sabe encerrar sozinho quando a pessoa se despede', async () => {
    const prompt = await buildSystemPrompt(turn({ voiceCall: true }))
    expect(prompt).toContain('VOICE CALL ACTIVE')
    expect(prompt).toContain('end_call')
    // A despedida é decisão do modelo, não uma lista de frases: o prompt só diz
    // para ele se despedir e chamar a tool na mesma resposta.
    expect(prompt).toMatch(/one short goodbye and call it/i)
    // E o modelo não pode encerrar no meio de uma conversa normal.
    expect(prompt).toMatch(/Never call it while the conversation is still going/i)
  })

  it('o prompt do overlay e da chamada não fixa frases em português', async () => {
    const overlay = await buildSystemPrompt(turn({ overlay: true }))
    const call = await buildSystemPrompt(turn({ voiceCall: true }))
    for (const prompt of [overlay, call]) {
      expect(prompt).not.toMatch(/tchau|não era nada|era só isso|pode fechar|agora foi|isso|aqui/i)
    }
  })
})
