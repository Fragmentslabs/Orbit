import type { ProfileDescription } from '@shared/agents'
import { BUILTIN_PROFILES } from '@shared/agents'
import type { SendMessageInput } from '@shared/chat'
import { resolveProfile } from './index'

/**
 * What a built-in profile injects, read from the same definition the engine runs — the
 * Specialists page shows exactly this, so it cannot drift from what the model receives.
 */

/** A session id that owns nothing: building a toolset only declares tools, it touches no disk. */
const DESCRIBE_INPUT = { sessionId: 'describe', mode: 'chat', text: '', providerId: '', modelId: '', options: {} } as unknown as SendMessageInput

export function describeBuiltins(): ProfileDescription[] {
  const out: ProfileDescription[] = []
  for (const id of BUILTIN_PROFILES) {
    const def = resolveProfile(id)
    if (!def) continue
    const tools = def.tools ? Object.keys(def.tools(DESCRIBE_INPUT)).sort() : []
    out.push({
      id,
      builtin: true,
      // `language` is filled in per turn; the page shows the prompt with the default reply line.
      systemPrompt: def.systemPrompt({ language: undefined }),
      tools,
      generalTools: !def.tools,
      blocks: def.blocks,
      turnContext: def.turnContext,
    })
  }
  return out
}
