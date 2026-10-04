import type { SendMessageInput } from '@shared/chat'

/**
 * O input do condutor da orquestra (planejamento e síntese): o modelo e o
 * raciocínio configurados em Preferências / "+" → Orquestra, ou o próprio chat.
 * Os workers não passam por aqui — seguem workerModel e, sem ele, o modelo do
 * chat, como a configuração promete.
 */
export function conductorInput(input: SendMessageInput): SendMessageInput {
  const conductor = input.orchestratorModel
  if (!conductor) return input
  return {
    ...input,
    providerId: conductor.providerId,
    modelId: conductor.modelId,
    options: { ...input.options, reasoning: conductor.reasoning },
  }
}
