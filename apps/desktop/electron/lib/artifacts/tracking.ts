import type { ToolSet } from 'ai'
import type { SendMessageInput } from '@shared/chat'
import { ARTIFACT_KIND_DESCRIPTORS } from './kinds'
import { associateChat } from './chat-registry'

/**
 * A chat that ran a tool which creates or changes an artifact has worked on it, so the
 * artifact's chat list gets it. Done at the tool boundary, for every kind, from the table
 * in kinds.ts — the tools themselves know nothing about chat history.
 *
 * Failures are never the tool's problem: the registry is bookkeeping.
 */
export function withArtifactTracking(tools: ToolSet, input: Pick<SendMessageInput, 'sessionId'>): ToolSet {
  const wrapped: ToolSet = { ...tools }
  for (const descriptor of ARTIFACT_KIND_DESCRIPTORS) {
    for (const name of descriptor.tools) {
      const original = tools[name]
      if (!original || typeof original.execute !== 'function') continue
      const run = original.execute.bind(original) as (args: unknown, options: unknown) => Promise<unknown>
      wrapped[name] = {
        ...original,
        execute: async (args: unknown, options: unknown) => {
          const result = await run(args, options)
          try {
            const id = await descriptor.resolveId({ sessionId: input.sessionId, args, result })
            if (id) await associateChat({ kind: descriptor.kind, id }, input.sessionId)
          } catch (err) {
            console.warn('[artifacts] could not record the chat:', err)
          }
          return result
        },
      } as ToolSet[string]
    }
  }
  return wrapped
}
