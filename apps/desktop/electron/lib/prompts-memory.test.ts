import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SendMessageInput } from '@shared/chat'

/**
 * Memories in the system prompt throughout a conversation.
 *
 * The system prompt is reassembled on every turn and does not stay in the history. When the
 * memories' content only entered the first exchange, the second turn onward
 * ran without the project map — the agent "forgot" what /init had written right
 * after the first answer.
 */

const loadPromptContext = vi.fn()

vi.mock('./memory/service', () => ({ loadPromptContext: (...args: unknown[]) => loadPromptContext(...args) }))
vi.mock('./skills', () => ({ loadSkills: async () => [] }))
vi.mock('./mcp', () => ({ listMcpToolDescriptions: () => [] }))
vi.mock('./past-chats', () => ({ buildPastChatsContext: async () => '', detectPastChatsIntent: () => false }))
// Subchats read the storage (app.getPath), which does not exist outside Electron.
vi.mock('./subchats', () => ({ listSubchats: async () => [], formatSubchatsBlock: () => '' }))
vi.mock('./app-settings', async () => {
  const { DEFAULT_APP_SETTINGS } = await import('@shared/app-settings')
  return { agentMayUseBrowser: () => false, agentMayControlComputer: () => false, getAppSettings: () => DEFAULT_APP_SETTINGS }
})

const { buildSystemPrompt, promptMemoryIds } = await import('./prompts')

const map = {
  root: { id: 'mem_root', text: 'App: store with front end and back end.', hasDoc: true, children: 2 },
  children: [{ id: 'mem_front', text: 'Frontend: React + Vite.', hasDoc: true, children: 3 }],
  omitted: 3,
}

function turn(sessionId: string): SendMessageInput {
  return {
    sessionId,
    text: 'adjusts the login',
    providerId: 'p',
    modelId: 'm',
    mode: 'code',
    directory: '/work/app',
    options: { brain: true, brainContext: true },
  } as SendMessageInput
}

beforeEach(() => {
  loadPromptContext.mockReset()
  loadPromptContext.mockResolvedValue({ core: [], seasonal: [], promotable: [], general: [], learning: [], project: [], projectName: 'app', map })
})

describe('memories in the system prompt', () => {
  it('the project map stays in the second turn of the same conversation', async () => {
    const first = await buildSystemPrompt(turn('s1'))
    const second = await buildSystemPrompt(turn('s1'))
    expect(first).toContain('Project memory map of "app"')
    expect(first).toContain('#mem_front Frontend: React + Vite.')
    expect(second).toContain('#mem_front Frontend: React + Vite.')
  })

  it('is computed once per conversation and stays stable between turns', async () => {
    const first = await buildSystemPrompt(turn('s2'))
    loadPromptContext.mockResolvedValue({ core: [], seasonal: [], promotable: [], general: [], learning: [], project: [], map: undefined })
    const second = await buildSystemPrompt(turn('s2'))
    expect(loadPromptContext).toHaveBeenCalledTimes(1)
    expect(second).toBe(first)
  })

  it('a repeating seasonal one enters as a question to the user, not as a rule', async () => {
    loadPromptContext.mockResolvedValue({
      core: [],
      seasonal: [],
      general: [],
      learning: [],
      project: [],
      promotable: [
        { id: 'mem_rep', kind: 'seasonal', text: 'always run the build before finishing', tags: [], hits: 3, weight: 0.5, createdAt: 0, relatedIds: [], hasDoc: false },
      ],
    })
    const prompt = await buildSystemPrompt(turn('s5'))
    expect(prompt).toContain('REPEATING MEMORIES')
    expect(prompt).toContain('always run the build before finishing')
    // The rule is only born after the "yes": the prompt says to ask, not to promote.
    expect(prompt).toContain('Ask the user ONCE')
  })

  it('another conversation computes its own', async () => {
    await buildSystemPrompt(turn('s3'))
    await buildSystemPrompt(turn('s4'))
    expect(loadPromptContext).toHaveBeenCalledTimes(2)
  })

  it('records the ids of the block, so the turn suggestion does not repeat', async () => {
    const core = {
      id: 'mem_core',
      kind: 'core' as const,
      text: 'Prefers short answers',
      tags: [],
      hits: 0,
      weight: 1,
      createdAt: 0,
      relatedIds: [],
      hasDoc: false,
    }
    loadPromptContext.mockResolvedValue({
      core: [core],
      seasonal: [],
      promotable: [],
      general: [],
      learning: [],
      project: [],
    })
    await buildSystemPrompt(turn('s6'))
    // Same key the chat-engine uses when calling retrieveForTurn.
    expect(promptMemoryIds('s6', 'code', '/work/app')).toEqual(['mem_core'])
  })

  it('says the collection has more than the block', async () => {
    const prompt = await buildSystemPrompt(turn('s7'))
    expect(prompt).toContain('The archive holds more')
  })

  it('shows how long the seasonal one has existed', async () => {
    loadPromptContext.mockResolvedValue({
      core: [],
      general: [],
      learning: [],
      project: [],
      promotable: [],
      seasonal: [
        {
          id: 'mem_saz',
          kind: 'seasonal' as const,
          text: 'Building the app landing page',
          tags: [],
          hits: 0,
          weight: 0.5,
          createdAt: Date.now() - 3 * 86_400_000,
          relatedIds: [],
          hasDoc: false,
        },
      ],
    })
    const prompt = await buildSystemPrompt({ ...turn('s8'), mode: 'chat', directory: undefined })
    expect(prompt).toContain('(3d ago)')
  })
})
