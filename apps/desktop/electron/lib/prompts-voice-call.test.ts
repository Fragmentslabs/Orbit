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
vi.mock('./app-settings', () => ({ agentMayUseBrowser: () => false }))

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
