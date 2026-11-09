import { AGENT_PROMPT_SECTIONS, type AgentPromptSection } from '@shared/agents'
import type { SendMessageInput } from '@shared/chat'
import { buildPromptSections } from '../prompts'
import type { SectionWeights } from './describe'

/** A chat turn with nothing in it: the sections are measured as the general chat builds them. */
const MEASURE_INPUT = { sessionId: 'describe', mode: 'chat', text: '', providerId: '', modelId: '', options: {} } as unknown as SendMessageInput

/**
 * What each section an agent may take weighs, in tokens, measured on the real general prompt
 * (chat mode, no tool catalog). It feeds the picker in the editor and the per-piece weights of
 * the "what a chat injects" view. A failure costs the numbers, never the page.
 */
export async function generalSectionWeights(): Promise<Record<AgentPromptSection, number>> {
  const out = Object.fromEntries(AGENT_PROMPT_SECTIONS.map((id) => [id, 0])) as Record<AgentPromptSection, number>
  try {
    for (const section of await buildPromptSections(MEASURE_INPUT, true)) {
      if (section.id in out) out[section.id as AgentPromptSection] += Math.ceil(section.text.length / 4)
    }
  } catch {
    // keep zeros
  }
  return out
}

export type { SectionWeights }
