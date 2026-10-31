import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import type { SendMessageInput } from '@shared/chat'
import { createToolApproval } from '../../permission'
import { globalMode } from '../../permission/global-mode'
import type { ToolContext } from '../context'
import { createToolBridge } from './bridge'
import { formatRun } from './result'
import { runScript } from './sandbox'
import { DEFAULT_TIMEOUT_MS, MAX_CODE_CHARS, MAX_TIMEOUT_MS } from './limits'

/**
 * `run_tools` — Programmatic Tool Calling.
 *
 * The problem it solves is not a missing tool, it is the SHAPE of the loop: every
 * tool call is a full round trip, and every round trip resends the whole turn
 * (system prompt, catalog, messages, every result so far). A turn that reads 20
 * files pays 20 sends and grows quadratically with its own work.
 *
 * Here the model writes ONE script: the tools become functions, the script walks
 * them, and only what it prints or returns comes back. Twenty calls cost one step,
 * and the intermediate results never enter the context at all.
 *
 * The name says what it is FOR, not what it runs. Called `execute_code` it lost to
 * `bash` every time: the model read "run code", already had a tool for that, and
 * used this one as a wrapper around a single shell command — six round trips, one
 * command each. The value is the fan-out, not the language.
 *
 * The trade is honest and worth stating: the model stops seeing what it did not ask
 * the script to print. That is a win for work that is already decided (scan,
 * aggregate, apply in batch) and a loss for exploration, where the next step depends
 * on what the last answer said — for that, the tool stays in the normal loop. The
 * description tells the model exactly this, because the model is what picks.
 */

/**
 * The manual of the sandbox. Written once and never assembled per turn: the names
 * are the tool names the model already sees in the same request, so listing them
 * again would spend context on every step of every turn to repeat a fact it has.
 */
const DESCRIPTION =
  'Calls this turn\'s tools from ONE script and returns only what it prints (console.log) or returns (`return value`) — ' +
  'everything in between stays out of your context. ' +
  'Inside it every tool of this turn is an async function under the same name (`tools.bash`, `tools.read`, `tools.glob`…; ' +
  '`tools.names` lists them), returning exactly the text you would have received yourself. ' +
  'PUT THE WHOLE JOB IN ONE RUN — a script with a single tool call is that call plus a round trip, and the round trips are ' +
  'what this exists to remove. Chain the steps instead: ' +
  '`const files = (await tools.glob({ pattern: "**/*.ts" })).trim().split("\\n"); const rows = []; ' +
  'for (const f of files) rows.push(await tools.bash({ command: "wc -l " + f })); return rows.sort().slice(-5).join("\\n")`. ' +
  'Explore the same way: when you are unsure what a tool returns, whether a path exists or where a folder sits, print a slice ' +
  'and branch on it INSIDE the script instead of coming back with a second one. ' +
  'Plain JavaScript — no require, no filesystem, no network, no timers: `tools`, `console` and the language are all there is. ' +
  'Each run starts clean (no variables from the previous one). A failed or denied tool call throws, so try/catch it and adapt ' +
  'in the same run; errors carry the stack in your own line numbers.'

export interface RunToolsOptions {
  input: SendMessageInput
  ctx: ToolContext
  /** The turn's ToolSet — read on every run, since it is still being assembled when this is created. */
  tools: () => ToolSet
}

export function createRunToolsTool(options: RunToolsOptions) {
  const { input, ctx } = options
  const mode = input.options.permissionMode ?? 'ask'
  // The same gate the model's own calls go through — a script must not be a way
  // around the permission card. Created once, so "allow for this turn" inside a
  // script holds for the whole run instead of being asked on every call.
  const approve = createToolApproval(
    input.options.followGlobalPermission ? () => globalMode(input.sessionId, mode) : mode,
    input.sessionId,
    input.directory ?? null,
    `${input.sessionId}-run-tools`,
    ctx.abort,
  )

  return tool({
    description: DESCRIPTION,
    inputSchema: z.object({
      code: z
        .string()
        .describe(
          'JavaScript source, run as the body of an async function: `await tools.<name>(args)` calls a tool, `return value` sends something back, console.log sends text.',
        ),
      timeout: z
        .number()
        .optional()
        .describe(`Time limit in milliseconds (default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}).`),
    }),
    execute: async ({ code, timeout }, { abortSignal }) => {
      if (!code.trim()) return 'The script is empty — write the JavaScript that does the work.'
      if (code.length > MAX_CODE_CHARS) {
        return `The script has ${code.length} characters (max ${MAX_CODE_CHARS}). Split the work in smaller scripts.`
      }
      const timeoutMs = Math.min(Math.max(timeout ?? DEFAULT_TIMEOUT_MS, 5_000), MAX_TIMEOUT_MS)
      const signal = abortSignal ?? ctx.abort
      const bridge = createToolBridge({ tools: options.tools, approve, signal, idPrefix: `${input.sessionId}-exec` })
      const run = await runScript({ code, names: bridge.names, bridge: bridge.call, timeoutMs, signal })
      console.info(
        `[run_tools] ${(run.ms / 1000).toFixed(1)}s · ${bridge.calls.length} tool call(s) · ${run.printed} console line(s)` +
          `${run.stopped ? ` · ${run.stopped}` : ''}${run.error ? ' · error' : ''}`,
      )
      return formatRun(run, bridge.calls, timeoutMs)
    },
  })
}
