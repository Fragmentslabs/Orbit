import type { SendMessageInput } from '@shared/chat'

/**
 * The orchestra conductor's input (planning and synthesis): the model and
 * reasoning configured in Preferences / "+" → Orchestra, or the chat's own.
 * The workers do not come through here — they follow workerModel and, without
 * it, the chat's model, as the settings promise.
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
