import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ToolSet } from 'ai'
import type { Hook, HookEvent } from '@shared/hooks'
import { HOOK_DEFAULT_TIMEOUT_MS } from '@shared/hooks'
import { userShellEnv } from '../shell-env'
import { hooksFor, noteHookRun } from './store'

/**
 * Runs the user's hooks around a tool call.
 *
 * The contract is the one Claude Code and Hermes use, so a script written for
 * either works here: the call arrives as JSON on stdin, exit 0 lets it through,
 * exit 2 blocks it (pre) or sends stderr back to the model (post). Any other
 * outcome — another exit code, a crash, a timeout — is logged and lets the call
 * through: a broken hook must not be able to freeze the agent, only a hook that
 * says "no" on purpose stops it.
 */

const MAX_OUTPUT = 4_000
const MAX_STDIN_OUTPUT = 20_000

export interface HookCall {
  event: HookEvent
  toolName: string
  input: unknown
  sessionId: string
  directory: string | null
  /** post_tool_call: what the tool returned. */
  output?: unknown
}

interface ExecResult {
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  ms: number
}

/** The file the call touches, absolute — what a formatter or a guard needs most. */
function touchedFile(input: unknown, directory: string | null): string | undefined {
  const args = (input ?? {}) as Record<string, unknown>
  const raw = [args.filePath, args.path, args.file].find((v): v is string => typeof v === 'string' && v.length > 0)
  if (!raw) return undefined
  return directory ? path.resolve(directory, raw) : raw
}

function outputText(output: unknown): string {
  const text = typeof output === 'string' ? output : JSON.stringify(output ?? null)
  return text.length > MAX_STDIN_OUTPUT ? `${text.slice(0, MAX_STDIN_OUTPUT)}…` : text
}

export function execHook(hook: Hook, call: HookCall): Promise<ExecResult> {
  const started = Date.now()
  const timeoutMs = hook.timeoutMs ?? HOOK_DEFAULT_TIMEOUT_MS
  const file = touchedFile(call.input, call.directory)
  const payload = JSON.stringify({
    event: call.event,
    tool: call.toolName,
    input: call.input ?? null,
    ...(call.event === 'post_tool_call' ? { output: outputText(call.output) } : {}),
    sessionId: call.sessionId,
    directory: call.directory,
    ...(file ? { file } : {}),
  })
  const env = {
    ...userShellEnv(),
    ORBIT_HOOK_EVENT: call.event,
    ORBIT_TOOL_NAME: call.toolName,
    ORBIT_SESSION_ID: call.sessionId,
    ...(call.directory ? { ORBIT_PROJECT_DIR: call.directory } : {}),
    ...(file ? { ORBIT_FILE: file } : {}),
  }
  const isWin = process.platform === 'win32'
  // A folder that is gone (a removed worktree) would fail the spawn itself.
  const cwd = call.directory && existsSync(call.directory) ? call.directory : os.homedir()

  return new Promise((resolve) => {
    const child = isWin
      ? spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', hook.command], {
          cwd,
          env,
          windowsHide: true,
        })
      : spawn(process.env.SHELL || '/bin/bash', ['-c', hook.command], {
          cwd,
          env,
          // Own process group, so the timeout kills what the hook started too.
          detached: true,
        })

    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < MAX_OUTPUT) stdout += chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_OUTPUT) stderr += chunk.toString('utf8')
    })

    const finish = (exitCode: number | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({
        exitCode,
        stdout: stdout.slice(0, MAX_OUTPUT).trim(),
        stderr: stderr.slice(0, MAX_OUTPUT).trim(),
        timedOut,
        ms: Date.now() - started,
      })
    }

    const timer = setTimeout(() => {
      timedOut = true
      try {
        if (!isWin && child.pid) process.kill(-child.pid, 'SIGKILL')
        else child.kill('SIGKILL')
      } catch {
        // already gone
      }
      finish(null)
    }, timeoutMs)

    child.on('error', (err) => {
      stderr += String(err.message)
      finish(null)
    })
    child.on('close', (code) => finish(code))
    // A hook that never reads stdin closes the pipe early: that is fine, not an error.
    child.stdin?.on('error', () => {})
    child.stdin?.end(payload)
  })
}

async function runHooks(call: HookCall): Promise<string[]> {
  const verdicts: string[] = []
  for (const hook of hooksFor(call.event, call.toolName, call.directory)) {
    const result = await execHook(hook, call)
    const blocked = result.exitCode === 2
    noteHookRun(hook.id, {
      at: Date.now(),
      tool: call.toolName,
      exitCode: result.exitCode,
      blocked,
      ...(result.timedOut ? { timedOut: true } : {}),
      ms: result.ms,
      ...(result.stderr || result.stdout ? { output: (result.stderr || result.stdout).slice(0, 500) } : {}),
    })
    if (result.timedOut || (result.exitCode !== 0 && !blocked)) {
      console.warn(
        `[hooks] ${hook.id} (${call.event} ${call.toolName}) ${result.timedOut ? 'timed out' : `exited ${result.exitCode}`}: ${result.stderr.slice(0, 200)}`,
      )
    }
    if (blocked) {
      verdicts.push(result.stderr || result.stdout || `Blocked by the hook "${hook.description ?? hook.command}".`)
      // A pre hook's "no" is final: the remaining hooks would only judge a call that will not happen.
      if (call.event === 'pre_tool_call') break
    }
  }
  return verdicts
}

/** The reason the call is blocked, or null when every hook let it through. */
export async function runPreToolHooks(call: Omit<HookCall, 'event' | 'output'>): Promise<string | null> {
  const verdicts = await runHooks({ ...call, event: 'pre_tool_call' })
  return verdicts[0] ?? null
}

/** Feedback for the model from the hooks that exited 2 (empty when none did). */
export async function runPostToolHooks(call: Omit<HookCall, 'event'>): Promise<string> {
  const verdicts = await runHooks({ ...call, event: 'post_tool_call' })
  return verdicts.join('\n')
}

/**
 * Wraps every tool's execute with the post_tool_call hooks — in place, because
 * run_tools reads this same object for its script API and must fire them too.
 * The check for hooks happens per call: one added mid-turn already applies.
 */
export function attachPostToolHooks(tools: ToolSet, scope: { sessionId: string; directory: string | null }): ToolSet {
  for (const [name, definition] of Object.entries(tools)) {
    const original = definition.execute
    if (typeof original !== 'function') continue
    definition.execute = async (input: unknown, options: unknown) => {
      const output = await (original as (i: unknown, o: unknown) => Promise<unknown>)(input, options)
      if (hooksFor('post_tool_call', name, scope.directory).length === 0) return output
      const feedback = await runPostToolHooks({ toolName: name, input, output, ...scope })
      // Only a text result can carry the note; a structured one (an image, a part list)
      // keeps its shape, and the run stays on the hooks screen.
      if (!feedback || typeof output !== 'string') return output
      return `${output}\n\n[post_tool_call hook]\n${feedback}`
    }
  }
  return tools
}
