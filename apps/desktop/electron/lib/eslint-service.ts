import path from 'node:path'
import { Worker } from 'node:worker_threads'

/**
 * The PROJECT's ESLint, serving the files panel.
 *
 * Two decisions worth recording:
 *
 * 1. It is the eslint of the open project, resolved from its `package.json` —
 *    not one that Orbit bundles. What shows up underlined has to be what the
 *    project considers an error; a second opinion from an analyzer of ours would be
 *    noise, and would diverge from what the CI rejects.
 *
 * 2. It runs in a worker thread, not in the main process. Linting is CPU work:
 *    running it here would block the main's event loop on every pause in
 *    typing — and the chat stream goes through the main. Measured in this
 *    repository: the first call takes ~2.8s (loading eslint, config and
 *    plugins) and the following ones 16–40ms, because the instance stays alive.
 *
 * The worker's script is a string evaluated instead of a separate file: the
 * main is bundled by vite into a single bundle, and a worker file would require
 * an entry point of its own just for this.
 */

const WORKER_SOURCE = [
  "const { parentPort } = require('node:worker_threads')",
  "const { createRequire } = require('node:module')",
  'let engine = null',
  'let unavailable = false',
  "parentPort.on('message', async (msg) => {",
  '  if (unavailable) {',
  '    parentPort.postMessage({ id: msg.id, unavailable: true })',
  '    return',
  '  }',
  '  try {',
  '    if (!engine) {',
  '      // Resolves from the FILE, not from the root: in a monorepo the eslint that',
  "      // counts is the closest one to it, which is the same one that sees the config",
  '      // to be applied. The root is the fallback.',
  '      let ESLint',
  '      try {',
  "        ESLint = createRequire(msg.filePath)('eslint').ESLint",
  '      } catch {',
  "        ESLint = createRequire(msg.root + '/package.json')('eslint').ESLint",
  '      }',
  '      engine = new ESLint({ cwd: msg.root })',
  '    }',
  '    const results = await engine.lintText(msg.content, {',
  '      filePath: msg.filePath,',
  '      warnIgnored: false,',
  '    })',
  '    parentPort.postMessage({ id: msg.id, messages: results[0] ? results[0].messages : [] })',
  '  } catch (err) {',
  '    // Project without eslint, or a config that does not load: give up for good instead',
  '    // of repeating the error on every keystroke.',
  '    unavailable = true',
  '    parentPort.postMessage({',
  '      id: msg.id,',
  '      unavailable: true,',
  '      error: String((err && err.message) || err),',
  '    })',
  '  }',
  '})',
].join('\n')

/** An eslint message, already in the format the renderer consumes. */
export interface LintMessage {
  line: number
  column: number
  endLine?: number
  endColumn?: number
  message: string
  ruleId: string | null
  /** 1 = warning, 2 = error (the same as eslint). */
  severity: number
}

export type LintFileResult =
  | { ok: true; messages: LintMessage[] }
  /** Project without a usable eslint — the panel stops asking. */
  | { ok: false; unavailable: true }

interface Pending {
  resolve: (value: LintFileResult) => void
  timer: NodeJS.Timeout
}

interface Instance {
  worker: Worker
  pending: Map<number, Pending>
  unavailable: boolean
}

/** One worker per root: each project has its own config and plugins. */
const instances = new Map<string, Instance>()
let nextId = 1

/** Ceiling per call: a slow plugin cannot leave the panel waiting. */
const LINT_TIMEOUT_MS = 15_000

function settle(instance: Instance, id: number, value: LintFileResult): void {
  const pending = instance.pending.get(id)
  if (!pending) return
  clearTimeout(pending.timer)
  instance.pending.delete(id)
  pending.resolve(value)
}

function instanceFor(root: string): Instance {
  const existing = instances.get(root)
  if (existing) return existing
  const worker = new Worker(WORKER_SOURCE, { eval: true })
  const instance: Instance = { worker, pending: new Map(), unavailable: false }
  worker.on('message', (msg: { id: number; messages?: LintMessage[]; unavailable?: boolean; error?: string }) => {
    if (msg.unavailable) {
      if (!instance.unavailable && msg.error) {
        console.warn('[eslint] unavailable for', root, '—', msg.error)
      }
      instance.unavailable = true
      settle(instance, msg.id, { ok: false, unavailable: true })
      return
    }
    settle(instance, msg.id, { ok: true, messages: msg.messages ?? [] })
  })
  worker.on('error', (err: unknown) => {
    console.error('[eslint] worker failed:', err instanceof Error ? err.message : String(err))
    instance.unavailable = true
    for (const id of [...instance.pending.keys()]) {
      settle(instance, id, { ok: false, unavailable: true })
    }
  })
  // The worker cannot keep the app open on shutdown.
  worker.unref()
  instances.set(root, instance)
  return instance
}

export async function lintFile(
  root: string,
  filePath: string,
  content: string,
): Promise<LintFileResult> {
  const normalizedRoot = path.resolve(root).replace(/\\/g, '/')
  const instance = instanceFor(normalizedRoot)
  if (instance.unavailable) return { ok: false, unavailable: true }
  const id = nextId++
  return new Promise<LintFileResult>((resolve) => {
    const timer = setTimeout(() => {
      settle(instance, id, { ok: false, unavailable: true })
    }, LINT_TIMEOUT_MS)
    instance.pending.set(id, { resolve, timer })
    instance.worker.postMessage({
      id,
      root: normalizedRoot,
      filePath: path.resolve(filePath),
      content,
    })
  })
}

/** Shuts the workers down — called when the app closes. */
export function stopLintWorkers(): void {
  for (const instance of instances.values()) void instance.worker.terminate()
  instances.clear()
}
