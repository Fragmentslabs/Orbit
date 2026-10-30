import { tool } from 'ai'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { z } from 'zod'
import type { ToolContext } from './context'
import { userShellEnv } from '../shell-env'
import { registerProcess, type ProcessInfo } from '../process-manager'
import { parseFileView, parseInspection, symbolSearchPattern } from '../bash-inspect'

const DEFAULT_TIMEOUT = 2 * 60 * 1000
const MAX_TIMEOUT = 10 * 60 * 1000
/**
 * Stored output: the beginning AND the end. Keeping only the beginning, as before, lost
 * exactly what matters in a build or test that fails — the error and the summary
 * come at the end — and the agent ran it again to see. The middle is what gets dropped.
 */
const OUTPUT_HEAD = 6_000
const OUTPUT_TAIL = 10_000
const SIGKILL_GRACE = 200
// Tolerance window after the abort's kill: if the process did not emit 'close'
// in that time, the kill failed (e.g. taskkill without permission on Windows) — the
// runShell resolves anyway (it never leaves the agent's turn stuck).
const SETTLE_GRACE_MS = 5000

const execFileAsync = promisify(execFile)

async function killTree(pid: number): Promise<void> {
  const isWin = process.platform === 'win32'
  if (isWin) {
    // taskkill via execFile (asynchronous): execSync BLOCKED the main process —
    // it froze every IPC handler during the kill, including new clicks
    // on the stop button. Failure (exit != 0) is common (process already dead) and is
    // covered by runShell's settle watchdog.
    try {
      await execFileAsync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true })
    } catch {
      // process may have already exited
    }
    return
  }
  try {
    process.kill(-pid, 'SIGTERM')
    setTimeout(() => {
      // Reinforcement SIGKILL in case the SIGTERM was not enough
      try { process.kill(-pid, 'SIGKILL') } catch { /* already exited */ }
    }, SIGKILL_GRACE)
  } catch {
    // with no group of its own (e.g. spawn without detached) — it falls back to a direct kill
    try { process.kill(pid, 'SIGTERM') } catch { /* already exited */ }
  }
}

function makeLabel(command: string): string {
  const flat = command.replace(/\s+/g, ' ').trim()
  return `auto: ${flat.slice(0, 60)}${flat.length > 60 ? '…' : ''}`
}

/** Accumulates a process's output keeping only the beginning and the end. */
export function createOutputCollector(headChars = OUTPUT_HEAD, tailChars = OUTPUT_TAIL) {
  let head = ''
  let tail = ''
  let total = 0
  return {
    append(text: string) {
      total += text.length
      const room = Math.max(0, headChars - head.length)
      head += text.slice(0, room)
      const rest = text.slice(room)
      if (rest) tail = (tail + rest).slice(-tailChars)
    },
    text(): string {
      const omitted = total - head.length - tail.length
      if (omitted <= 0) return head + tail
      return `${head}\n… (${omitted} characters omitted from the middle of the output) …\n${tail}`
    },
  }
}

function runShell(command: string, cwd: string, timeout: number, abort: AbortSignal, sessionId?: string) {
  return new Promise<{ output: string; exitCode: number | null; background?: ProcessInfo }>(
    (resolve, reject) => {
      const isWin = process.platform === 'win32'
      const child = isWin
        ? spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
            cwd,
            env: userShellEnv(),
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
          })
        : spawn(process.env.SHELL || '/bin/bash', ['-c', command], {
            cwd,
            env: userShellEnv(),
            // detached:true guarantees a group of its own (setsid): killTree covers the
            // whole tree AND the promotion to background preserves the children.
            detached: true,
            stdio: ['ignore', 'pipe', 'pipe'],
          })

      const collected = createOutputCollector()
      const append = (chunk: Buffer) => collected.append(chunk.toString('utf8'))
      child.stdout.on('data', append)
      child.stderr.on('data', append)

      const pid = child.pid
      const kill = () => { if (pid != null) void killTree(pid) }

      // Post-abort watchdog: if the kill fails silently (e.g. taskkill
      // without permission on Windows), 'close' never arrives and the Promise would stay
      // pending FOREVER — the agent's turn gets stuck and the stop button becomes a
      // no-op (the second abort is ignored because the signal was already aborted).
      // After SETTLE_GRACE_MS, it resolves anyway: it registers the still-alive
      // process in the manager (it becomes visible and killable in the process panel)
      // and returns the partial output with an explicit warning.
      let settleTimer: NodeJS.Timeout | undefined
      const armSettleWatchdog = () => {
        if (settleTimer) return
        settleTimer = setTimeout(() => {
          if (child.exitCode !== null && child.exitCode !== undefined) return
          child.stdout.removeListener('data', append)
          child.stderr.removeListener('data', append)
          child.removeAllListeners('close')
          child.removeAllListeners('error')
          abort.removeEventListener('abort', onAbort)
          const output = collected.text()
          if (pid == null) {
            resolve({ output, exitCode: null })
            return
          }
          const background = registerProcess(child, {
            label: makeLabel(command),
            command,
            cwd,
            pid,
            initialOutput: output,
            sessionId,
          })
          console.warn(
            `[shell] kill not confirmed after ${SETTLE_GRACE_MS / 1000}s — PID ${pid} still alive; ` +
              'recorded as background (follow/end it in the processes panel)',
          )
          resolve({ output, exitCode: null, background })
        }, SETTLE_GRACE_MS)
      }

      // Timeout promotes the command to background instead of killing it: dev servers
      // (npm run dev) and long builds stay alive, and the tool already returns
      // the partial output + pointer (bash_list/bash_output/bash_kill).
      const timer = setTimeout(() => {
        clearTimeout(timer)
        const output = collected.text()
        if (pid == null) return resolve({ output, exitCode: null })
        child.stdout.removeListener('data', append)
        child.stderr.removeListener('data', append)
        child.removeAllListeners('close')
        child.removeAllListeners('error')
        // From here on the process owns its own life: the turn's abort
        // (Stop, new message) must NOT bring it down — only bash_kill/trash. Without
        // this removal, the abort fired onAbort and killed the promoted process.
        abort.removeEventListener('abort', onAbort)
        const background = registerProcess(child, {
          label: makeLabel(command),
          command,
          cwd,
          pid,
          initialOutput: output,
          sessionId,
        })
        resolve({ output, exitCode: null, background })
      }, timeout)

      const onAbort = () => {
        clearTimeout(timer)
        abort.removeEventListener('abort', onAbort)
        kill()
        armSettleWatchdog()
      }
      abort.addEventListener('abort', onAbort)

      child.on('error', (err) => {
        clearTimeout(timer)
        if (settleTimer) clearTimeout(settleTimer)
        abort.removeEventListener('abort', onAbort)
        reject(err)
      })
      child.on('close', (exitCode) => {
        clearTimeout(timer)
        if (settleTimer) clearTimeout(settleTimer)
        abort.removeEventListener('abort', onAbort)
        resolve({ output: collected.text(), exitCode })
      })
    },
  )
}

/** Hints already given in this turn: one of each kind is enough, repeating only costs tokens. */
const hintsGiven = new WeakMap<ToolContext, Set<'search' | 'read'>>()

/**
 * Bash used to read or search code: it points to the right tool, once per
 * turn. After the code-index the agent started doing this MORE (62% of the
 * bash calls), outside the index and outside `read`.
 */
export function inspectionHint(ctx: ToolContext, command: string): string {
  const inspection = parseInspection(command, ctx.directory)
  if (!inspection) return ''
  const given = hintsGiven.get(ctx) ?? new Set()
  hintsGiven.set(ctx, given)
  const symbol = symbolSearchPattern(inspection)
  if (symbol && !given.has('search')) {
    given.add('search')
    return `\n\n[hint: to find where \`${symbol}\` is defined or used, code_search / code_refs answer from the symbol index in one call, with the source and its callers — prefer them over grep through bash.]`
  }
  if (parseFileView(inspection) && !given.has('read')) {
    given.add('read')
    return '\n\n[hint: read files with `read` (line-numbered, what edit expects) or code_outline for the signatures only — not cat/sed/head through bash.]'
  }
  return ''
}

export function createBashTool(ctx: ToolContext) {
  return tool({
    description:
      'Runs a shell command in the working folder and returns stdout/stderr. Use for builds, tests, git, etc. ' +
      'Commands that do not finish within the timeout are NOT killed: they keep running in the background ' +
      '(see bash_list / bash_output / bash_kill). For long-running commands (dev servers, watchers) prefer bash_background.',
    inputSchema: z.object({
      command: z.string().describe('Command to run'),
      description: z.string().optional().describe('Short description of what the command does'),
      timeout: z
        .number()
        .optional()
        .describe(
          'Timeout in milliseconds before the command moves to the background (max 10 minutes, default 2 minutes)',
        ),
    }),
    execute: async ({ command, timeout }) => {
      const ms = Math.min(Math.max(timeout ?? DEFAULT_TIMEOUT, 0), MAX_TIMEOUT)
      const { output, exitCode, background } = await runShell(command, ctx.directory, ms, ctx.abort, ctx.sessionId)
      if (background) {
        const partial = output.slice(0, 4000)
        return (
          `(timeout after ${ms / 1000}s — the command was NOT killed, it keeps running in the background)\n` +
          `PID ${background.pid} (label "${background.label}")\n` +
          `Follow it with bash_output and bash_list; stop it with bash_kill (pid ${background.pid}) when no longer needed.\n\n` +
          `Command: ${command}\n\nPartial output:\n${partial || '(no output yet)'}`
        )
      }
      const status = exitCode === 0 ? '' : `\n(exit code: ${exitCode})`
      return `${output || '(no output)'}${inspectionHint(ctx, command)}${status}`
    },
  })
}
