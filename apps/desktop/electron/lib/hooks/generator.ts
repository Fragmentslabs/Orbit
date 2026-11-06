import type { HookGenerationResult, HookInput } from '@shared/hooks'
import { HOOK_MAX_TIMEOUT_MS } from '@shared/hooks'
import type { RoutineModel } from '@shared/routines'
import { askModelForJson, contextLines } from '../headless-json'
import { validateHook } from './store'

/**
 * Creating a hook the way a routine is created: the user says what they want in
 * plain prose and the model writes the event, the tool matcher and the command.
 *
 * It runs headless (no chat, no tools): one question, one JSON answer. Nothing
 * that comes out of here is saved — the review step shows the exact command, in
 * the form, and the user confirms it. A command that the model wrote is still a
 * command that runs on their machine on its own, so it is never written to disk
 * without being seen.
 */

const SYSTEM = `You write shell hooks for Orbit, an AI coding agent. A hook is a command that runs ON ITS OWN around every matching tool call of the agent, without going through the model.

From the user's description, produce ONE hook.

How hooks work:
- event "pre_tool_call" runs BEFORE the tool call and can block it: exit code 2 blocks it, and what the command prints to stderr goes back to the agent as the reason.
- event "post_tool_call" runs AFTER the call: exit code 2 sends the command's stderr to the agent as feedback (a failing linter, a type error). Any other exit code lets the work continue.
- "match" is a regex over the TOOL NAME, matched against the whole name: "bash", "edit|write", "mcp_.*". "*" means every tool. Orbit's file tools are named edit, write, patch, read; the shell tool is bash.
- The command receives the call as JSON on stdin ({"event","tool","input","output" (post only),"sessionId","directory","file"}) and these env vars: ORBIT_TOOL_NAME, ORBIT_HOOK_EVENT, ORBIT_PROJECT_DIR and ORBIT_FILE (the absolute path of the file the call touches, when there is one). It runs in the project folder, in the user's shell.

Rules:
- Prefer a ONE-LINER that uses those env vars or jq on stdin. Do NOT write a script file into the user's project.
- The command must be safe to run on its own and often: never delete, overwrite or move the user's files, never push, commit or install anything, never send data over the network — unless the description EXPLICITLY asks for that.
- A hook that formats or checks a file must guard on the file ($ORBIT_FILE may be empty, or not the right type) so it does nothing for other tools and files. A hook that guards a command (pre_tool_call on bash) reads the command from the JSON on stdin and exits 2 with a clear message on stderr only when it should block.
- "description" is a short phrase in the SAME LANGUAGE as the user's description, saying what the hook is for.
- Pick the narrowest "match" that does the job. "*" only when the description really is about every tool.
- "timeoutSeconds" only when the command is slow (default 10, max ${HOOK_MAX_TIMEOUT_MS / 1000}); otherwise omit it.
- If the description is not something a hook can do (a schedule, a one-off action, something that needs the model's judgement), still return the closest honest hook, and say in "description" what it covers.

Answer with JSON ONLY — no prose, no markdown fences:
{"event":"post_tool_call","match":"edit|write","command":"...","description":"...","timeoutSeconds":10}`

/** The model's JSON as a HookInput, or null when it cannot be one. */
export function suggestionFrom(raw: Record<string, unknown> | null): HookInput | null {
  if (!raw) return null
  const command = typeof raw.command === 'string' ? raw.command.trim() : ''
  if (!command) return null
  const event = raw.event === 'pre_tool_call' ? 'pre_tool_call' : 'post_tool_call'
  const match = typeof raw.match === 'string' && raw.match.trim() ? raw.match.trim() : '*'
  const description = typeof raw.description === 'string' ? raw.description.trim() : ''
  const seconds = Number(raw.timeoutSeconds)
  const input: HookInput = {
    event,
    match,
    command,
    ...(description ? { description } : {}),
    ...(Number.isFinite(seconds) && seconds > 0 ? { timeoutMs: Math.min(seconds, HOOK_MAX_TIMEOUT_MS / 1000) * 1000 } : {}),
  }
  return validateHook(input) ? null : input
}

export async function generateHook(
  description: string,
  model: RoutineModel,
  folders: string[],
  language?: string,
): Promise<HookGenerationResult> {
  const text = description.trim()
  if (!text) return { ok: false, error: 'Describe the hook before generating.' }

  const context = contextLines(folders, language, [
    `Platform: ${process.platform}${process.platform === 'win32' ? ' (commands run in PowerShell)' : ' (commands run in the user shell)'}`,
  ])
  const answer = await askModelForJson(SYSTEM, `${context}\n\n## Hook described by the user\n${text}`, model)
  if (!answer.ok) return answer
  const suggestion = suggestionFrom(answer.raw)
  if (!suggestion) return { ok: false, error: 'The model answered without a usable hook. Try again or switch models.' }
  return { ok: true, suggestion }
}
