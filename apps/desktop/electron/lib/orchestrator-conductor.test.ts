import { describe, expect, it } from 'vitest'
import type { SendMessageInput } from '@shared/chat'
import { conductorInput } from './orchestrator-conductor'

const input = (extra: Partial<SendMessageInput> = {}): SendMessageInput => ({
  sessionId: 's1',
  text: 'refactor the module',
  providerId: 'chat-provider',
  modelId: 'chat-model',
  mode: 'code',
  options: { orchestrate: {}, reasoning: { enabled: true, variantId: 'high' } },
  workerModel: { providerId: 'w', modelId: 'worker' },
  ...extra,
})

describe('conductorInput', () => {
  it('with no orchestra model configured, the chat itself conducts', () => {
    const base = input()
    expect(conductorInput(base)).toBe(base)
  })

  it('with the model configured, planning and synthesis use it and its reasoning', () => {
    const conductor = conductorInput(
      input({ orchestratorModel: { providerId: 'o', modelId: 'orchestrator', reasoning: { enabled: true, variantId: 'low' } } }),
    )
    expect(conductor).toMatchObject({ providerId: 'o', modelId: 'orchestrator' })
    expect(conductor.options.reasoning).toEqual({ enabled: true, variantId: 'low' })
    // The workers keep their own model.
    expect(conductor.workerModel).toEqual({ providerId: 'w', modelId: 'worker' })
  })

  it('a configured model without reasoning does not inherit the chat level', () => {
    const conductor = conductorInput(input({ orchestratorModel: { providerId: 'o', modelId: 'orchestrator' } }))
    expect(conductor.options.reasoning).toBeUndefined()
    expect(conductor.options.orchestrate).toEqual({})
  })
})
