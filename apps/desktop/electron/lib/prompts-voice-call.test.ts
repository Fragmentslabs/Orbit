import { describe, expect, it, vi } from 'vitest'
import type { SendMessageInput } from '@shared/chat'

/**
 * Modo chamada: a resposta vai ser lida em voz alta, então o prompt pede
 * respostas curtas e sem formatação — e só quando a opção vem ligada.
 */

vi.mock('./memory/service', () => ({ loadPromptContext: async () => null }))
vi.mock('./skills', () => ({ loadSkills: async () => [] }))
vi.mock('./mcp', () => ({ listMcpToolDescriptions: () => [] }))
vi.mock('./past-chats', () => ({ buildPastChatsContext: async () => '', detectPastChatsIntent: () => false }))
/** Voz como nas Preferências; cada teste liga/desliga as metades. */
const voz = { tts: true, stt: true }
vi.mock('./app-settings', async () => {
  const { DEFAULT_APP_SETTINGS } = await import('@shared/app-settings')
  return {
    agentMayUseBrowser: () => false,
    agentMayControlComputer: () => false,
    getAppSettings: () => ({
      ...DEFAULT_APP_SETTINGS,
      voice: {
        ...DEFAULT_APP_SETTINGS.voice,
        tts: { ...DEFAULT_APP_SETTINGS.voice.tts, enabled: voz.tts },
        stt: { ...DEFAULT_APP_SETTINGS.voice.stt, enabled: voz.stt },
      },
    }),
  }
})

const { buildSystemPrompt } = await import('./prompts')

function turn(voiceCall: boolean): SendMessageInput {
  return {
    sessionId: 's1',
    text: 'que horas abre o mercado?',
    providerId: 'p',
    modelId: 'm',
    mode: 'chat',
    options: { voiceCall },
  } as SendMessageInput
}

describe('modo chamada no system prompt', () => {
  it('pede resposta falada, curta e sem Markdown', async () => {
    const prompt = await buildSystemPrompt(turn(true))
    expect(prompt).toContain('VOICE CALL ACTIVE')
    expect(prompt).toMatch(/no Markdown/i)
    // Antes de ferramentas, uma frase curta para a chamada não ficar muda.
    expect(prompt).toMatch(/before any tool call/i)
  })

  it('fora da chamada não aparece', async () => {
    expect(await buildSystemPrompt(turn(false))).not.toContain('VOICE CALL ACTIVE')
  })
})

describe('áudio desligado nas Preferências', () => {
  it('com as duas metades ligadas, nada a explicar', async () => {
    voz.tts = true
    voz.stt = true
    const prompt = await buildSystemPrompt(turn(false))
    expect(prompt).not.toContain('Creating audio files')
    expect(prompt).not.toContain('Transcribing audio')
  })

  it('cada metade desligada vira uma instrução de como responder', async () => {
    voz.tts = false
    voz.stt = false
    const prompt = await buildSystemPrompt(turn(false))
    expect(prompt).toContain('Creating audio files (text-to-speech) is DISABLED')
    expect(prompt).toContain('Transcribing audio (speech-to-text) is DISABLED')
    expect(prompt).toContain('Settings → Voice')
    voz.tts = true
    voz.stt = true
  })
})
