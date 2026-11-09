import { describe, expect, it, vi } from 'vitest'
import type { SendMessageInput } from '@shared/chat'

vi.mock('./profiles', () => ({ profileSystemPrompt: () => 'AGENT OWN PROMPT', profileSections: () => [] }))
vi.mock('./memory/service', () => ({ loadPromptContext: async () => null }))
vi.mock('./skills', () => ({ loadSkills: async () => [] }))
vi.mock('./mcp', () => ({ listMcpToolDescriptions: () => [] }))
vi.mock('./past-chats', () => ({ buildPastChatsContext: async () => '', detectPastChatsIntent: () => false }))
vi.mock('./subchats', () => ({ listSubchats: async () => [], formatSubchatsBlock: () => '', conversationOriginBlock: async () => '' }))
vi.mock('./app-settings', async () => {
  const { DEFAULT_APP_SETTINGS } = await import('@shared/app-settings')
  return { agentMayUseBrowser: () => false, agentMayControlComputer: () => false, getAppSettings: () => DEFAULT_APP_SETTINGS }
})

const { buildSystemPrompt, WORKER_AGENT_CONTRACT } = await import('./prompts')

const turn = (over: Partial<SendMessageInput>) =>
  ({ sessionId: 's', text: 'x', providerId: 'p', modelId: 'm', mode: 'code', options: { profile: 'agent:a' }, ...over }) as SendMessageInput

describe('an agent running as an orchestra worker', () => {
  it('keeps its own prompt and adds only the worker contract', async () => {
    const prompt = await buildSystemPrompt(turn({ orchestrationRole: 'worker' }))
    expect(prompt).toBe(`AGENT OWN PROMPT\n\n${WORKER_AGENT_CONTRACT}`)
    expect(prompt).toContain('Do not ask for clarification')
  })

  it('in its own chat it gets the prompt and nothing else', async () => {
    expect(await buildSystemPrompt(turn({}))).toBe('AGENT OWN PROMPT')
  })
})
