import { BUILTIN_PROFILES, AGENT_ICONS, AGENT_LIMITS, type AgentGenerationResult, type AgentInput } from '@shared/agents'
import type { RoutineModel } from '@shared/routines'
import { askModelForJson, contextLines } from '../headless-json'
import { loadSkills } from '../skills'
import { sanitizeAgentInput } from './validate'

/**
 * Writing an agent from a description, the way a skill or a hook is written: the person says
 * what the agent is for and the model drafts the whole definition. Headless (no chat, no
 * tools); nothing is saved here — the editor opens filled in and the person reviews and saves.
 *
 * The draft goes through `sanitizeAgentInput`, the same validator the editor and the file use,
 * so a model cannot slip anything past it (an unknown craft, a switch that is not a literal
 * `true`, a pinned skill that does not exist).
 */

const SYSTEM = (skills: string, crafts: string) => `You write agents for Orbit, an AI workspace. An agent is the base identity of a conversation: a system prompt plus a few switches. It is written TO THE AGENT, as a clear working brief.

From the user's description, produce ONE agent.

Rules:
- "name": 1 to 4 words, in the user's language.
- "icon": one of: ${AGENT_ICONS.join(', ')}.
- "whenToUse": ONE sentence (at most ${AGENT_LIMITS.whenToUse} characters) saying what kind of task this agent is the right one for. Other chats read it to decide when to suggest this agent, so describe the task, not the agent. Same language as the user.
- "prompt": the system prompt, in the user's language. Say who the agent is, how it works, what it must always or never do, and how it answers. Short, concrete, imperative. 100 to 400 words. Only what the user asked for: do not invent tools, files or abilities.
- "craft": ONLY when the agent exists to make one of these artifacts, else omit it: ${crafts}. A craft brings that artifact's own tools.
- "pinnedSkills": slugs of existing skills the agent should always follow. Use ONLY slugs from the list below and only when clearly relevant; otherwise an empty array.
- "features": booleans for vision, subagents, orchestra, loop, memories. All false unless the description clearly needs it.
- Never include secrets, keys or personal data.

Existing skills:
${skills}

Answer with JSON ONLY — no prose, no markdown fences:
{"name":"...","icon":"...","whenToUse":"...","prompt":"...","craft":"motion","pinnedSkills":[],"features":{"vision":false,"subagents":false,"orchestra":false,"loop":false,"memories":false}}`

/** The model's JSON as a valid agent draft, or null when it cannot be one. `known` = real skill slugs. */
export function agentSuggestionFrom(raw: Record<string, unknown>, known: readonly string[]): AgentInput | null {
  const input = sanitizeAgentInput(raw)
  if (!input.name || !input.prompt.trim()) return null
  const slugs = new Set(known)
  return { ...input, pinnedSkills: input.pinnedSkills.filter((slug) => slugs.has(slug)) }
}

export async function generateAgent(
  description: string,
  model: RoutineModel,
  folders: string[],
  language?: string,
): Promise<AgentGenerationResult> {
  const text = description.trim()
  if (!text) return { ok: false, error: 'Describe the agent before generating.' }

  const skills = await loadSkills().catch(() => [])
  const skillList = skills.length ? skills.map((s) => `- ${s.slug}: ${s.description}`).join('\n') : '(none)'
  const answer = await askModelForJson(
    SYSTEM(skillList, BUILTIN_PROFILES.join(', ')),
    `${contextLines(folders, language)}\n\n## Agent described by the user\n${text}`,
    model,
  )
  if (!answer.ok) return answer
  const suggestion = agentSuggestionFrom(
    answer.raw,
    skills.map((s) => s.slug),
  )
  if (!suggestion) return { ok: false, error: 'The model answered without a usable agent. Try again or switch models.' }
  return { ok: true, suggestion }
}
