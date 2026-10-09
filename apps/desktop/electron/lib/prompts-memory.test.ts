import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SendMessageInput } from '@shared/chat'

/**
 * As memórias no system prompt ao longo de uma conversa.
 *
 * O system prompt é remontado a cada turno e não fica no histórico. Quando o
 * conteúdo das memórias só entrava na primeira troca, o segundo turno em diante
 * rodava sem o mapa do projeto — o agente "esquecia" o que o /init gravou logo
 * depois da primeira resposta.
 */

const loadPromptContext = vi.fn()

vi.mock('./memory/service', () => ({ loadPromptContext: (...args: unknown[]) => loadPromptContext(...args) }))
vi.mock('./skills', () => ({ loadSkills: async () => [] }))
vi.mock('./mcp', () => ({ listMcpToolDescriptions: () => [] }))
vi.mock('./past-chats', () => ({ buildPastChatsContext: async () => '', detectPastChatsIntent: () => false }))
vi.mock('./app-settings', () => ({ agentMayUseBrowser: () => false }))

const { buildSystemPrompt } = await import('./prompts')

const map = {
  root: { id: 'mem_root', text: 'App: loja com front e back.', hasDoc: true, children: 2 },
  children: [{ id: 'mem_front', text: 'Frontend: React + Vite.', hasDoc: true, children: 3 }],
  omitted: 3,
}

function turn(sessionId: string): SendMessageInput {
  return {
    sessionId,
    text: 'ajusta o login',
    providerId: 'p',
    modelId: 'm',
    mode: 'code',
    directory: '/work/app',
    options: { brain: true, brainContext: true },
  } as SendMessageInput
}

beforeEach(() => {
  loadPromptContext.mockReset()
  loadPromptContext.mockResolvedValue({ core: [], seasonal: [], general: [], learning: [], project: [], projectName: 'app', map })
})

describe('memórias no system prompt', () => {
  it('o mapa do projeto continua no segundo turno da mesma conversa', async () => {
    const first = await buildSystemPrompt(turn('s1'))
    const second = await buildSystemPrompt(turn('s1'))
    expect(first).toContain('Project memory map of "app"')
    expect(first).toContain('#mem_front Frontend: React + Vite.')
    expect(second).toContain('#mem_front Frontend: React + Vite.')
  })

  it('é calculado uma vez por conversa e fica estável entre os turnos', async () => {
    const first = await buildSystemPrompt(turn('s2'))
    loadPromptContext.mockResolvedValue({ core: [], seasonal: [], general: [], learning: [], project: [], map: undefined })
    const second = await buildSystemPrompt(turn('s2'))
    expect(loadPromptContext).toHaveBeenCalledTimes(1)
    expect(second).toBe(first)
  })

  it('outra conversa calcula o próprio', async () => {
    await buildSystemPrompt(turn('s3'))
    await buildSystemPrompt(turn('s4'))
    expect(loadPromptContext).toHaveBeenCalledTimes(2)
  })
})
