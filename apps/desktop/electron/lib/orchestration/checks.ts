import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { userShellEnv } from '../shell-env'
import { perfSpan } from '../perf'
import { acquireHeavySlot } from '../heavy-commands'

const execFileAsync = promisify(execFile)

/**
 * Project checks for the orchestra in Rigorous mode: the orchestrator only
 * accepts a worker's work after running one of them.
 *
 * It never runs a free command: the list comes from the project itself
 * (package.json scripts, Makefile targets) and the orchestrator picks one by
 * name. That way "verify" never becomes "run anything" — the reviewer has no
 * shell.
 */

export interface Check {
  /** How the orchestrator picks it: "typecheck", "test", "make lint" */
  name: string
  command: string
  args: string[]
  /** Folder where it runs (the one holding package.json/Makefile) */
  folder: string
}

/** Scripts that verify without changing anything or staying up (watch, dev server). */
const CHECK_SCRIPT = /^(typecheck|type-check|tsc|lint|test|tests|check|verify)(:[\w-]+)?$/
const NEVER_TERMINATES = /(watch|dev|serve|start|ui)\b/i
const MAKE_TARGETS = new Set(['test', 'lint', 'check', 'typecheck'])

async function readJson(file: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

async function exists(file: string): Promise<boolean> {
  return fs.access(file).then(() => true, () => false)
}

/** Package manager from the lockfile, walking up to the given root. */
async function packageManager(folder: string, root: string): Promise<'npm' | 'pnpm' | 'yarn' | 'bun'> {
  let current = folder
  for (;;) {
    if (await exists(path.join(current, 'pnpm-lock.yaml'))) return 'pnpm'
    if (await exists(path.join(current, 'yarn.lock'))) return 'yarn'
    if ((await exists(path.join(current, 'bun.lockb'))) || (await exists(path.join(current, 'bun.lock')))) return 'bun'
    if (await exists(path.join(current, 'package-lock.json'))) return 'npm'
    const parent = path.dirname(current)
    if (current === root || parent === current || path.relative(root, parent).startsWith('..')) return 'npm'
    current = parent
  }
}

/**
 * Checks available for a working folder: the ones from that folder's
 * package.json and Makefile and, when it is a subfolder, the ones from the
 * repository root (a monorepo with scripts at the root).
 */
export async function discoverChecks(folder: string, repositoryRoot?: string): Promise<Check[]> {
  const folders = [...new Set([folder, repositoryRoot].filter((p): p is string => !!p))]
  const found: Check[] = []
  const names = new Set<string>()
  for (const dir of folders) {
    const pkg = await readJson(path.join(dir, 'package.json'))
    const scripts = (pkg?.scripts ?? {}) as Record<string, unknown>
    const pm = pkg ? await packageManager(dir, repositoryRoot ?? dir) : 'npm'
    for (const [name, body] of Object.entries(scripts)) {
      // "watch" may be in the name (test:watch → vitest) or in the command
      if (!CHECK_SCRIPT.test(name) || typeof body !== 'string' || NEVER_TERMINATES.test(name) || NEVER_TERMINATES.test(body)) continue
      const label = dir === folder ? name : `${name} (root)`
      if (names.has(label)) continue
      names.add(label)
      found.push({ name: label, command: pm, args: ['run', name], folder: dir })
    }
    try {
      const makefile = await fs.readFile(path.join(dir, 'Makefile'), 'utf8')
      for (const line of makefile.split('\n')) {
        const target = /^([A-Za-z][\w-]*):(?!=)/.exec(line)?.[1]
        if (!target || !MAKE_TARGETS.has(target)) continue
        const label = dir === folder ? `make ${target}` : `make ${target} (root)`
        if (names.has(label)) continue
        names.add(label)
        found.push({ name: label, command: 'make', args: [target], folder: dir })
      }
    } catch {
      // no Makefile
    }
  }
  return found
}

const MAX_OUTPUT = 6000

/** Runs one check; the output comes back clipped at the end (where the errors usually are). */
export async function runCheck(check: Check, signal?: AbortSignal): Promise<{ ok: boolean; output: string }> {
  // A check is `npm run typecheck`/`test` — a compiler or a test runner, the
  // processes that reach GBs. It shares the machine-wide slots with the workers'
  // bash, so a review never adds a fifth compiler to a wave of four.
  let release: () => void
  try {
    release = await acquireHeavySlot(signal)
  } catch {
    return { ok: false, output: '(aborted while waiting for another heavy command to finish)' }
  }
  const perf = perfSpan('check', { name: check.name, folder: check.folder })
  try {
    const { stdout, stderr } = await execFileAsync(check.command, check.args, {
      cwd: check.folder,
      env: { ...userShellEnv(), CI: '1', FORCE_COLOR: '0' },
      timeout: 10 * 60_000,
      maxBuffer: 20 * 1024 * 1024,
      signal,
    })
    perf.end({ ok: true })
    return { ok: true, output: clip(`${stdout}\n${stderr}`) }
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string; code?: number | string }
    const output = `${e.stdout ?? ''}\n${e.stderr ?? ''}`.trim() || e.message || String(err)
    perf.end({ ok: false, code: e.code })
    return { ok: false, output: clip(`(exited with ${e.code ?? 'error'})\n${output}`) }
  } finally {
    release()
  }
}

function clip(text: string): string {
  const clean = text.trim()
  return clean.length > MAX_OUTPUT ? `…\n${clean.slice(-MAX_OUTPUT)}` : clean
}
