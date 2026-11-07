import {
  AGENT_FEATURES,
  AGENT_ICONS,
  AGENT_LIMITS,
  emptyAgentInput,
  type AgentIcon,
  type AgentInput,
} from '@shared/agents'

/**
 * The one place that decides what a valid agent looks like. Both the editor (through the IPC)
 * and the stored file go through it, and so will an imported agent later: anything that does
 * not fit is dropped or clamped, never trusted.
 */

const clean = (value: unknown, max: number): string => (typeof value === 'string' ? value.slice(0, max) : '')

/** Control characters other than tab and newline have no place in a name or a prompt. */
const stripControl = (text: string): string =>
  Array.from(text)
    .filter((ch) => {
      const code = ch.codePointAt(0)!
      return code === 9 || code === 10 || (code >= 32 && code !== 127)
    })
    .join('')

export function sanitizeAgentInput(raw: unknown): AgentInput {
  const source = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const base = emptyAgentInput()

  const name = stripControl(clean(source.name, AGENT_LIMITS.name * 2)).replace(/\s+/g, ' ').trim().slice(0, AGENT_LIMITS.name)
  const icon = AGENT_ICONS.includes(source.icon as AgentIcon) ? (source.icon as AgentIcon) : base.icon
  const prompt = stripControl(clean(source.prompt, AGENT_LIMITS.prompt))

  const featuresRaw = (source.features && typeof source.features === 'object' ? source.features : {}) as Record<string, unknown>
  // Strictly `true` switches a feature on: anything else leaves the default (off).
  const features = Object.fromEntries(AGENT_FEATURES.map((f) => [f, featuresRaw[f] === true])) as AgentInput['features']

  const out: AgentInput = { name, icon, prompt, features }

  if (Array.isArray(source.allowedTools)) {
    const names = source.allowedTools
      .filter((n): n is string => typeof n === 'string' && /^[A-Za-z0-9_.:-]+$/.test(n) && n.length <= AGENT_LIMITS.toolName)
      .slice(0, AGENT_LIMITS.allowedTools)
    out.allowedTools = [...new Set(names)]
  }
  const model = source.defaultModel as { providerId?: unknown; modelId?: unknown } | undefined
  if (model && typeof model.providerId === 'string' && typeof model.modelId === 'string' && model.providerId && model.modelId) {
    out.defaultModel = { providerId: model.providerId.slice(0, 120), modelId: model.modelId.slice(0, 200) }
  }
  if (typeof source.thinking === 'boolean') out.thinking = source.thinking
  return out
}

/** A name is required; everything else has a safe default. Returns the reason it is not valid. */
export function agentInputProblem(input: AgentInput): 'name' | null {
  return input.name ? null : 'name'
}
