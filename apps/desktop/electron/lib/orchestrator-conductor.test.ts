import { describe, expect, it } from 'vitest'
import type { SendMessageInput } from '@shared/chat'
import { conductorInput } from './orchestrator-conductor'

const input = (extra: Partial<SendMessageInput> = {}): SendMessageInput => ({
  sessionId: 's1',
  text: 'refatore o módulo',
  providerId: 'chat-provider',
  modelId: 'chat-model',
  mode: 'code',
  options: { orchestrate: {}, reasoning: { enabled: true, variantId: 'high' } },
  workerModel: { providerId: 'w', modelId: 'worker' },
  ...extra,
})

describe('conductorInput', () => {
  it('sem modelo de orquestra configurado, quem conduz é o próprio chat', () => {
    const base = input()
    expect(conductorInput(base)).toBe(base)
  })

  it('com o modelo configurado, planejamento e síntese usam ele e o raciocínio dele', () => {
    const conductor = conductorInput(
      input({ orchestratorModel: { providerId: 'o', modelId: 'orchestrator', reasoning: { enabled: true, variantId: 'low' } } }),
    )
    expect(conductor).toMatchObject({ providerId: 'o', modelId: 'orchestrator' })
    expect(conductor.options.reasoning).toEqual({ enabled: true, variantId: 'low' })
    // Os workers continuam com o modelo deles.
    expect(conductor.workerModel).toEqual({ providerId: 'w', modelId: 'worker' })
  })

  it('modelo configurado sem raciocínio não herda o nível do chat', () => {
    const conductor = conductorInput(input({ orchestratorModel: { providerId: 'o', modelId: 'orchestrator' } }))
    expect(conductor.options.reasoning).toBeUndefined()
    expect(conductor.options.orchestrate).toEqual({})
  })
})
