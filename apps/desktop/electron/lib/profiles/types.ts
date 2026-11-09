import type { ToolSet } from 'ai'
import type { ProfileBlocks, AgentInput } from '@shared/agents'
import type { ProfileId, SendMessageInput } from '@shared/chat'

/**
 * A profile is a definition. A built-in craft (motion, design, fragment) and an agent the
 * person wrote are both expressed as one, so the engine has a single path and nothing in it
 * asks "which kind of agent is this".
 *
 * A definition can only RESTRICT or TOGGLE: `blocks` switch things off, `allowedTools` narrows
 * the toolset. There is no field that adds a permission, an approval bypass or a model.
 */
export interface ProfileDefinition {
  id: ProfileId
  builtin: boolean
  /** The whole system prompt of the conversation. Empty = the model gets no system prompt. */
  systemPrompt(input: Pick<SendMessageInput, 'language'>): string
  /**
   * The tools of the craft, and ONLY those. Absent = the conversation's usual toolset, as
   * narrowed by `blocks` (a block that is off removes its tools) and `allowedTools`.
   */
  tools?(input: SendMessageInput, modelVision?: boolean): ToolSet
  /** Narrows the toolset to these names. Absent = no narrowing. */
  allowedTools?: string[]
  blocks: ProfileBlocks
  /** When this agent is the right one (drives suggestions and, later, the orchestrator). */
  whenToUse?: string
  /** Skills whose full text is part of the system prompt. */
  pinnedSkills?: string[]
  /** The state of the artifact being worked on, injected at every turn (user message). */
  turnBlock?(sessionId: string): Promise<string>
  /** One line saying what `turnBlock` carries, for the Specialists page. */
  turnContext?: string
  defaultModel?: AgentInput['defaultModel']
  thinking?: boolean
}

/**
 * The blocks of a craft chat: none of the general machinery. Vision is not a block of the
 * craft, so it is left as the model has it (motion looks at its own frames).
 */
export const CRAFT_BLOCKS: ProfileBlocks = {
  memories: false,
  subagents: false,
  orchestra: false,
  loop: false,
  vision: true,
  web: false,
  computer: false,
  plan: false,
  skills: false,
}
