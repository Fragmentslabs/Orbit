import { describe, expect, it, vi } from 'vitest'
import type { SendMessageInput } from '@shared/chat'

/**
 * Call mode: the answer is going to be read aloud, so the prompt asks for
 * short answers without formatting — and only when the option comes turned on.
 */

vi.mock('./memory/service', () => ({ loadPromptContext: async () => null }))
vi.mock('./skills', () => ({ loadSkills: async () => [] }))
vi.mock('./mcp', () => ({ listMcpToolDescriptions: () => [] }))
vi.mock('./past-chats', () => ({ buildPastChatsContext: async () => '', detectPastChatsIntent: () => false }))
// Subchats read the storage (app.getPath), which does not exist outside Electron.
vi.mock('./subchats', () => ({ listSubchats: async () => [], formatSubchatsBlock: () => '', conversationOriginBlock: async () => '' }))
/** Voice as in Preferences; each test turns the halves on/off. */
const voiceFlags = { tts: true, stt: true }
vi.mock('./app-settings', async () => {
  const { DEFAULT_APP_SETTINGS } = await import('@shared/app-settings')
  return {
    agentMayUseBrowser: () => false,
    agentMayControlComputer: () => false,
    getAppSettings: () => ({
      ...DEFAULT_APP_SETTINGS,
      voice: {
        ...DEFAULT_APP_SETTINGS.voice,
        tts: { ...DEFAULT_APP_SETTINGS.voice.tts, enabled: voiceFlags.tts },
        stt: { ...DEFAULT_APP_SETTINGS.voice.stt, enabled: voiceFlags.stt },
      },
    }),
  }
})

const { buildSystemPrompt } = await import('./prompts')

function turn(voiceCall: boolean): SendMessageInput {
  return {
    sessionId: 's1',
    text: 'what time does the market open?',
    providerId: 'p',
    modelId: 'm',
    mode: 'chat',
    options: { voiceCall },
  } as SendMessageInput
}

describe('call mode in the system prompt', () => {
  it('asks for a spoken, short answer without Markdown', async () => {
    const prompt = await buildSystemPrompt(turn(true))
    expect(prompt).toContain('VOICE CALL ACTIVE')
    expect(prompt).toMatch(/no Markdown/i)
    // Before tools, a short sentence so the call does not go mute.
    expect(prompt).toMatch(/before any tool call/i)
  })

  it('outside the call it does not show up', async () => {
    expect(await buildSystemPrompt(turn(false))).not.toContain('VOICE CALL ACTIVE')
  })
})

describe('audio off in Preferences', () => {
  it('with both halves on, nothing to explain', async () => {
    voiceFlags.tts = true
    voiceFlags.stt = true
    const prompt = await buildSystemPrompt(turn(false))
    expect(prompt).not.toContain('Creating audio files')
    expect(prompt).not.toContain('Transcribing audio')
  })

  it('each half off becomes an instruction on how to answer', async () => {
    voiceFlags.tts = false
    voiceFlags.stt = false
    const prompt = await buildSystemPrompt(turn(false))
    expect(prompt).toContain('Creating audio files (text-to-speech) is DISABLED')
    expect(prompt).toContain('Transcribing audio (speech-to-text) is DISABLED')
    expect(prompt).toContain('Settings → Voice')
    voiceFlags.tts = true
    voiceFlags.stt = true
  })
})
