import { tool, type ToolSet } from 'ai'
import { ASK_WHEN_VAGUE } from './proposal-guidance'
import { z } from 'zod'
import type { HookWithRun } from '@shared/hooks'
import { HOOK_MAX_TIMEOUT_MS } from '@shared/hooks'
import { addHook, listHooks, removeHook, validateHook } from '../hooks/store'

/**
 * hook_create / hook_list / hook_remove: the agent turns "every time you X, do Y"
 * into a hook. Creating and removing always go through the permission card (see
 * permission/rules.ts), which shows the exact command — by the time execute runs
 * here, the user has already said yes to it.
 */

const CREATE_DESCRIPTION =
  'Creates a shell hook: a command that runs ON ITS OWN around every matching tool call, without you. ' +
  'Use it when the user asks for something automatic about your own actions — "every time you edit a file, run prettier", ' +
  '"never let a git push --force through", "log every command you run". Not for a schedule (that is a routine) and not for something to do once. ' +
  'event "pre_tool_call" runs BEFORE the call and can block it: exit 2 blocks, and what the command prints to stderr comes back to you as the reason. ' +
  'event "post_tool_call" runs AFTER the call: exit 2 sends its stderr to you as feedback appended to the result (a failing linter, a type error). ' +
  'Any other exit code lets the call through. ' +
  'The command receives the call as JSON on stdin ({event, tool, input, output (post only), sessionId, directory, file}) and the env vars ' +
  'ORBIT_TOOL_NAME, ORBIT_HOOK_EVENT, ORBIT_PROJECT_DIR and ORBIT_FILE (absolute path of the file the call touches, when there is one); ' +
  'it runs in the project folder. Prefer a one-liner on those env vars or jq over writing a script file into the project. ' +
  'The user approves the exact command in a card before the hook exists. ' + ASK_WHEN_VAGUE

function describe(h: HookWithRun): string {
  const scope = h.directory ? `project ${h.directory}` : 'global'
  const last = h.lastRun
    ? ` · last run on ${h.lastRun.tool}: ${h.lastRun.timedOut ? 'timed out' : `exit ${h.lastRun.exitCode}`}${h.lastRun.blocked ? ' (blocked)' : ''}`
    : ''
  return `${h.id} · ${h.enabled ? 'on' : 'OFF'} · ${h.event} · match ${h.match} · ${scope}${h.description ? ` · ${h.description}` : ''}\n  $ ${h.command}${last}`
}

export function createHookTools(directory: string | null): ToolSet {
  return {
    hook_create: tool({
      description: CREATE_DESCRIPTION,
      inputSchema: z.object({
        event: z.enum(['pre_tool_call', 'post_tool_call']),
        match: z
          .string()
          .describe('Regex over the tool name, matched against the whole name: "bash", "edit|write", "mcp_.*". "*" = every tool.'),
        command: z.string().describe('The shell command. Exit 2 blocks (pre) or returns feedback (post).'),
        description: z.string().describe('What it is for, in a few words of the user\'s language — the hooks list shows it.'),
        scope: z
          .enum(['project', 'global'])
          .optional()
          .describe('"project" (default when there is a working folder): only in this folder. "global": every conversation.'),
        timeoutSeconds: z.number().optional().describe(`Default 10, max ${HOOK_MAX_TIMEOUT_MS / 1000}.`),
      }),
      execute: async ({ event, match, command, description, scope, timeoutSeconds }) => {
        const input = {
          event,
          match,
          command,
          description,
          ...(scope !== 'global' && directory ? { directory } : {}),
          ...(timeoutSeconds ? { timeoutMs: timeoutSeconds * 1000 } : {}),
        }
        const error = validateHook(input)
        if (error) return `Hook not created: ${error}.`
        const hook = await addHook(input, 'agent')
        return `Hook ${hook.id} created and active.\n${describe(hook)}\nThe user can turn it off or remove it in Tools → Hooks.`
      },
    }),
    hook_list: tool({
      description: 'Lists the user\'s shell hooks (id, on/off, event, matcher, scope, command, last run). Read it before creating one that may already exist, and to find the id for hook_remove.',
      inputSchema: z.object({}),
      execute: async () => {
        const all = listHooks()
        return all.length ? all.map(describe).join('\n') : 'No hooks.'
      },
    }),
    hook_remove: tool({
      description: 'Removes a shell hook by id (from hook_list). The user confirms in a card.',
      inputSchema: z.object({ id: z.string() }),
      execute: async ({ id }) => {
        const removed = await removeHook(id)
        return removed ? `Hook ${id} removed.` : `There is no hook ${id} — call hook_list for the ids.`
      },
    }),
  }
}
