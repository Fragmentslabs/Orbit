import { describe, expect, it, vi } from 'vitest'
import type { ModelMessage } from 'ai'
import type { CatalogProvider } from '@shared/chat'

vi.mock('electron', () => ({ app: { getVersion: () => '0.0.0-test' } }))

import { agentPrepareStep, createStepPreparer } from './agent-step'

/**
 * Todo tool loop do app passa por aqui (agente principal, subagentes,
 * orquestrador, /init, computer_task, esteira): o que é decidido neste módulo
 * vale para todos — antes cada um tinha só a normalização de reasoning, e a
 * esteira nem isso.
 */

const opencodeGo = {
  id: 'opencode-go',
  name: 'OpenCode Go',
  npm: '@ai-sdk/openai-compatible',
  api: 'https://opencode.ai/inference/go/openai/v1',
  env: [],
  models: {
    'claude-haiku-5-5': {
      id: 'claude-haiku-5-5',
      name: 'Claude Haiku 5.5',
      limit: { context: 200_000, output: 8_000 },
      provider: { npm: '@ai-sdk/anthropic', api: 'https://opencode.ai/inference/go/anthropic/v1' },
    },
    'deepseek-v4-pro': { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', limit: { context: 1_000_000, output: 64_000 } },
  },
} as unknown as CatalogProvider

const conversa: ModelMessage[] = [
  { role: 'user', content: 'oi' },
  { role: 'assistant', content: 'olá' },
  { role: 'user', content: 'tudo bem?' },
]

const cached = (messages: ModelMessage[]) => messages.map((m) => Boolean(m.providerOptions?.anthropic?.cacheControl))

describe('createStepPreparer', () => {
  it('marca o cache quando o modelo fala o protocolo Anthropic', () => {
    const prepared = createStepPreparer(opencodeGo, 'claude-haiku-5-5').prepare(conversa)
    expect(cached(prepared)).toEqual([true, true, true])
  })

  it('não marca nada nos outros — lá o cache de prefixo é automático', () => {
    const prepared = createStepPreparer(opencodeGo, 'deepseek-v4-pro').prepare(conversa)
    expect(cached(prepared)).toEqual([false, false, false])
  })

  it('o orçamento é o do modelo, com o teto de trabalho abaixo do de segurança', () => {
    const haiku = createStepPreparer(opencodeGo, 'claude-haiku-5-5')
    expect(haiku.budget).toBe(162_000)
    expect(haiku.workingBudget).toBe(100_000)
  })

  it('corta o acúmulo do loop e lembra o corte entre os passos', () => {
    const pair = (id: string, chars: number): ModelMessage[] => [
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: id, toolName: 'bash', input: { command: `npm run t${id}` } }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: id, toolName: 'bash', output: { type: 'text', value: 'x'.repeat(chars) } }] },
    ]
    const step = (n: number) => Array.from({ length: n }, (_, i) => pair(String(i), 16_000)).flat()
    const preparer = createStepPreparer(opencodeGo, 'deepseek-v4-pro')

    preparer.prepare(step(30))
    const first = preparer.dropped
    expect(first).toBeGreaterThan(0)
    preparer.prepare(step(31))
    expect(preparer.dropped).toBe(first)
  })
})

describe('agentPrepareStep', () => {
  it('responde {} quando nada muda, para o SDK pular a reescrita', () => {
    const step = agentPrepareStep(opencodeGo, 'deepseek-v4-pro')
    expect(step({ messages: [{ role: 'user', content: 'oi' }] })).toEqual({})
  })
})
