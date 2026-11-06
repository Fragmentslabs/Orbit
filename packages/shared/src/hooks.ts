/**
 * Shell hooks: a command of the user's that runs on its own around a tool call,
 * without going through the model. `pre_tool_call` can block the call (exit 2);
 * `post_tool_call` runs after it and can hand feedback back to the model (exit 2).
 */

export type HookEvent = 'pre_tool_call' | 'post_tool_call'

export const HOOK_EVENTS: HookEvent[] = ['pre_tool_call', 'post_tool_call']

export interface Hook {
  id: string
  event: HookEvent
  /** Regex over the tool name, matched against the WHOLE name. `*` or empty = every tool. */
  match: string
  /** Shell command; receives the call as JSON on stdin. */
  command: string
  /** What it is for, in the user's words — the list shows it above the command. */
  description?: string
  /** Project folder the hook is scoped to; absent = every conversation. */
  directory?: string
  enabled: boolean
  timeoutMs?: number
  createdAt: number
  /** Who wrote it: an agent's hook only exists after the user approved its card. */
  createdBy: 'user' | 'agent'
}

export interface HookRun {
  at: number
  tool: string
  exitCode: number | null
  /** Exit 2: the call was blocked (pre) or feedback went to the model (post). */
  blocked: boolean
  timedOut?: boolean
  ms: number
  /** Start of what the command printed, for the list. */
  output?: string
}

export interface HookWithRun extends Hook {
  lastRun?: HookRun
}

export type HookInput = Pick<Hook, 'event' | 'match' | 'command' | 'description' | 'directory' | 'timeoutMs'>

export const HOOK_DEFAULT_TIMEOUT_MS = 10_000
export const HOOK_MAX_TIMEOUT_MS = 60_000

/** The matcher as a regex, or null when it does not compile (it then matches nothing). */
export function hookMatcher(match: string): RegExp | null {
  const source = match.trim()
  if (!source || source === '*') return /^.*$/
  try {
    return new RegExp(`^(?:${source})$`)
  } catch {
    return null
  }
}

/** Result of asking the model to write a hook from a description (like routines:generate). */
export type HookGenerationResult =
  | { ok: true; suggestion: HookInput }
  | { ok: false; error: string }
