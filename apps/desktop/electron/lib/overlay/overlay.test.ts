import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_APP_SETTINGS, normalizeAppSettings } from '@shared/app-settings'
import { OVERLAY_DEFAULTS, normalizeOverlaySettings } from '@shared/overlay'
import type { SendMessageInput } from '@shared/chat'

/**
 * Overlay: its preferences (shortcut, opening mode, transparency) and what the
 * turn's prompt tells the agent. The window behavior (global shortcut, capture,
 * selection) depends on Electron and is verified in the app.
 */

vi.mock('../memory/service', () => ({ loadPromptContext: async () => null }))
vi.mock('../skills', () => ({ loadSkills: async () => [] }))
vi.mock('../mcp', () => ({ listMcpToolDescriptions: () => [] }))
vi.mock('../past-chats', () => ({ buildPastChatsContext: async () => '', detectPastChatsIntent: () => false }))
// Subchats read the storage (app.getPath), which does not exist outside Electron.
vi.mock('../subchats', () => ({ listSubchats: async () => [], formatSubchatsBlock: () => '', conversationOriginBlock: async () => '' }))
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

describe('overlay preferences', () => {
  it('with nothing saved, it opens talking, with persona and an almost solid background', () => {
    const overlay = normalizeOverlaySettings(undefined)
    expect(overlay).toEqual(OVERLAY_DEFAULTS)
    expect(overlay.openInCall).toBe(true)
    expect(overlay.persona).toBe(true)
  })

  it('transparency outside the domain goes back to the floor, not to zero', () => {
    expect(normalizeOverlaySettings({ opacity: 0.1 }).opacity).toBe(0.5)
    expect(normalizeOverlaySettings({ opacity: 7 }).opacity).toBe(1)
    expect(normalizeOverlaySettings({ opacity: Number.NaN }).opacity).toBe(OVERLAY_DEFAULTS.opacity)
  })

  it('a model only counts with provider and model; half a pair becomes null', () => {
    expect(normalizeOverlaySettings({ model: { providerId: 'anthropic', modelId: 'x' } }).model).toEqual({
      providerId: 'anthropic',
      modelId: 'x',
    })
    expect(normalizeOverlaySettings({ model: { providerId: 'anthropic' } }).model).toBeNull()
  })

  it('the general settings carry the overlay block', () => {
    const settings = normalizeAppSettings({ overlay: { openInCall: true, opacity: 0.7 } })
    expect(settings.overlay.openInCall).toBe(true)
    expect(settings.overlay.opacity).toBe(0.7)
    // What did not come inherits the default — including the shortcut turned on.
    expect(settings.overlay.enabled).toBe(true)
  })

  it('an old block (no overlay) does not break the normalization', () => {
    const settings = normalizeAppSettings({ closeToTray: false })
    expect(settings.overlay).toEqual(DEFAULT_APP_SETTINGS.overlay)
  })
})

describe('prompt do overlay', () => {
  it('asks for a short answer and tells it to look at the screen/selection instead of asking', async () => {
    const prompt = await buildSystemPrompt(turn({ overlay: true }))
    expect(prompt).toContain('OVERLAY (⇧⌘Space)')
    expect(prompt).toMatch(/Answer SHORT/i)
    expect(prompt).toContain('see_selection')
    expect(prompt).toContain('see_screen')
  })

  it('forbids describing the screen without a tool result in this turn', async () => {
    const prompt = await buildSystemPrompt(turn({ overlay: true }))
    // The real case: the model said "it works now — I see a VS Code open" without
    // ever having called see_screen. The rule has to be explicit.
    expect(prompt).toContain('You CANNOT see the screen on your own')
    expect(prompt).toContain('NEVER describe or confirm a screen you did not receive')
    expect(prompt).toContain('NO sentence before it')
  })

  it('a disabled capability becomes an explicit refusal, not an invention', async () => {
    const prompt = await buildSystemPrompt(turn({ overlay: true }))
    expect(prompt).toContain('Capabilities can be OFF in this mode')
    expect(prompt).toContain('say in one line that you cannot do it')
    expect(prompt).toContain('never pretend it worked')
  })

  it('outside the overlay it does not appear', async () => {
    expect(await buildSystemPrompt(turn({}))).not.toContain('OVERLAY (⇧⌘Space)')
  })

  it('in call mode the agent knows how to end by itself when the person says goodbye', async () => {
    const prompt = await buildSystemPrompt(turn({ voiceCall: true }))
    expect(prompt).toContain('VOICE CALL ACTIVE')
    expect(prompt).toContain('end_call')
    // The goodbye is the model's decision, not a list of sentences: the prompt only tells
    // it to say goodbye and call the tool in the same response.
    expect(prompt).toMatch(/one short goodbye and call it/i)
    // And the model cannot end in the middle of a normal conversation.
    expect(prompt).toMatch(/Never call it while the conversation is still going/i)
  })

  it('the overlay and call prompt does not hard-code Portuguese sentences', async () => {
    const overlay = await buildSystemPrompt(turn({ overlay: true }))
    const call = await buildSystemPrompt(turn({ voiceCall: true }))
    for (const prompt of [overlay, call]) {
      expect(prompt).not.toMatch(/tchau|não era nada|era só isso|pode fechar|agora foi|isso|aqui/i)
    }
  })
})
