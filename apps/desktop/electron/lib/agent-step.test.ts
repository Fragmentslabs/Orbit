import { describe, expect, it, vi } from 'vitest'
import type { ModelMessage } from 'ai'
import type { CatalogProvider } from '@shared/chat'

vi.mock('electron', () => ({ app: { getVersion: () => '0.0.0-test' } }))

import { agentPrepareStep, createStepPreparer } from './agent-step'

/**
 * Every tool loop in the app goes through here (main agent, subagents,
 * orchestrator, /init, computer_task, pipeline): what is decided in this module
 * holds for all of them — before, each one had only the reasoning
 * normalization, and the pipeline not even that.
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

const conversation: ModelMessage[] = [
  { role: 'user', content: 'hi' },
  { role: 'assistant', content: 'hello' },
  { role: 'user', content: 'how are you?' },
]

const cached = (messages: ModelMessage[]) => messages.map((m) => Boolean(m.providerOptions?.anthropic?.cacheControl))

describe('createStepPreparer', () => {
  it('marks the cache when the model speaks the Anthropic protocol', () => {
    const prepared = createStepPreparer(opencodeGo, 'claude-haiku-5-5').prepare(conversation)
    expect(cached(prepared)).toEqual([true, true, true])
  })

  it('marks nothing in the others — there the prefix cache is automatic', () => {
    const prepared = createStepPreparer(opencodeGo, 'deepseek-v4-pro').prepare(conversation)
    expect(cached(prepared)).toEqual([false, false, false])
  })

  it('the budget is the model one, with the work ceiling below the safety one', () => {
    const haiku = createStepPreparer(opencodeGo, 'claude-haiku-5-5')
    expect(haiku.budget).toBe(162_000)
    expect(haiku.workingBudget).toBe(100_000)
  })

  it('cuts the loop accumulation and remembers the cut between the steps', () => {
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
  it('answers {} when nothing changes, so the SDK skips the rewrite', () => {
    const step = agentPrepareStep(opencodeGo, 'deepseek-v4-pro')
    expect(step({ messages: [{ role: 'user', content: 'hi' }] })).toEqual({})
  })
})
