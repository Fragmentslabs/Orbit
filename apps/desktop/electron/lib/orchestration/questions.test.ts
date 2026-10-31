import { describe, expect, it, vi } from 'vitest'
import type { OrchestrationPlan } from '@shared/chat'

const generated = vi.hoisted(() => ({ text: '' as string | Error }))
vi.mock('ai', () => ({
  generateText: async () => {
    if (generated.text instanceof Error) throw generated.text
    return { text: generated.text }
  },
}))
vi.mock('../providers', () => ({ resolveModel: async () => ({}) }))

const { askOrchestrator, hasOrchestrator, parseRulings, registerOrchestrator } = await import('./questions')

const plan = { id: 'p', tasks: [{ id: 't', title: 'API', prompt: 'Build the API' }] } as unknown as OrchestrationPlan
const questions = [{ text: 'REST or GraphQL?' }, { text: 'Drop the legacy table?' }]

describe('parseRulings', () => {
  it('reads answers and escalations, and escalates what is missing or unreadable', () => {
    expect(parseRulings('ok: [{"i":1,"answer":"REST"},{"i":2,"escalate":"destructive"}]', 2)).toEqual([
      { index: 0, answer: 'REST' },
      { index: 1, escalate: 'destructive' },
    ])
    expect(parseRulings('not json', 1)).toEqual([{ index: 0, escalate: 'the orchestrator could not decide' }])
  })
})

describe('askOrchestrator', () => {
  it('only answers while a plan of that orchestrator is registered', async () => {
    expect(hasOrchestrator('orc')).toBe(false)
    const off = registerOrchestrator('orc', () => ({ providerId: 'p', modelId: 'm', request: 'build it', plan }))
    expect(hasOrchestrator('orc')).toBe(true)
    off()
    expect(hasOrchestrator('orc')).toBe(false)
    const rulings = await askOrchestrator({ orchestratorSessionId: 'orc', workerTitle: 'API', questions, mode: 'ask' })
    expect(rulings.every((r) => r.escalate)).toBe(true)
  })

  it('keeps escalations outside full mode', async () => {
    const off = registerOrchestrator('orc', () => ({ providerId: 'p', modelId: 'm', request: 'build it', plan }))
    generated.text = '[{"i":1,"answer":"REST"},{"i":2,"escalate":"destructive"}]'
    const rulings = await askOrchestrator({ orchestratorSessionId: 'orc', workerTitle: 'API', questions, mode: 'approve' })
    expect(rulings).toEqual([
      { index: 0, answer: 'REST' },
      { index: 1, escalate: 'destructive' },
    ])
    off()
  })

  it('never reaches the user in full mode, even when the model escalates or fails', async () => {
    const off = registerOrchestrator('orc', () => ({ providerId: 'p', modelId: 'm', request: 'build it', plan }))
    generated.text = '[{"i":1,"answer":"REST"},{"i":2,"escalate":"destructive"}]'
    expect((await askOrchestrator({ orchestratorSessionId: 'orc', workerTitle: 'API', questions, mode: 'full' })).every((r) => r.answer)).toBe(true)
    generated.text = new Error('offline')
    expect((await askOrchestrator({ orchestratorSessionId: 'orc', workerTitle: 'API', questions, mode: 'full' })).every((r) => r.answer)).toBe(true)
    off()
  })
})
