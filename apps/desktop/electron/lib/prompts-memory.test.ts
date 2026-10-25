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
// Subchats leem o storage (app.getPath), que não existe fora do Electron.
vi.mock('./subchats', () => ({ listSubchats: async () => [], formatSubchatsBlock: () => '' }))
vi.mock('./app-settings', async () => {
  const { DEFAULT_APP_SETTINGS } = await import('@shared/app-settings')
  return { agentMayUseBrowser: () => false, agentMayControlComputer: () => false, getAppSettings: () => DEFAULT_APP_SETTINGS }
})

const { buildSystemPrompt, promptMemoryIds } = await import('./prompts')

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
  loadPromptContext.mockResolvedValue({ core: [], seasonal: [], promotable: [], general: [], learning: [], project: [], projectName: 'app', map })
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
    loadPromptContext.mockResolvedValue({ core: [], seasonal: [], promotable: [], general: [], learning: [], project: [], map: undefined })
    const second = await buildSystemPrompt(turn('s2'))
    expect(loadPromptContext).toHaveBeenCalledTimes(1)
    expect(second).toBe(first)
  })

  it('sazonal que se repete entra como pergunta ao usuário, não como regra', async () => {
    loadPromptContext.mockResolvedValue({
      core: [],
      seasonal: [],
      general: [],
      learning: [],
      project: [],
      promotable: [
        { id: 'mem_rep', kind: 'seasonal', text: 'sempre rodar o build antes de terminar', tags: [], hits: 3, weight: 0.5, createdAt: 0, relatedIds: [], hasDoc: false },
      ],
    })
    const prompt = await buildSystemPrompt(turn('s5'))
    expect(prompt).toContain('REPEATING MEMORIES')
    expect(prompt).toContain('sempre rodar o build antes de terminar')
    // A regra só nasce depois do "sim": o prompt manda perguntar, não promover.
    expect(prompt).toContain('Ask the user ONCE')
  })

  it('outra conversa calcula o próprio', async () => {
    await buildSystemPrompt(turn('s3'))
    await buildSystemPrompt(turn('s4'))
    expect(loadPromptContext).toHaveBeenCalledTimes(2)
  })

  it('registra os ids do bloco, para a sugestão do turno não repetir', async () => {
    const core = {
      id: 'mem_core',
      kind: 'core' as const,
      text: 'Prefere respostas curtas',
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
    // Mesma chave que o chat-engine usa ao chamar retrieveForTurn.
    expect(promptMemoryIds('s6', 'code', '/work/app')).toEqual(['mem_core'])
  })

  it('diz que o acervo tem mais do que o bloco', async () => {
    const prompt = await buildSystemPrompt(turn('s7'))
    expect(prompt).toContain('The archive holds more')
  })

  it('mostra há quanto tempo a sazonal existe', async () => {
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
          text: 'Montando a landing do app',
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
