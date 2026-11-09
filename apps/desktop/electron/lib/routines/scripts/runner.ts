import fsp from 'node:fs/promises'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import * as XLSX from 'xlsx'
import type { RoutineScript } from '@shared/routines'
import { checkFetchUrl, resolveInsideFolders, safeHeaders } from './guards'
import { applyAuth, redactDeep, redactText, type SecretReader } from './secrets-guard'
import { BOOT_SOURCE, WORKER_SOURCE } from './sandbox-source'

/** What a script keeps between runs: free values and the ids it has already handled. */
export interface ScriptState {
  kv: Record<string, unknown>
  seen: string[]
}

export const EMPTY_SCRIPT_STATE: ScriptState = { kv: {}, seen: [] }

export type ScriptOutcome =
  | { ok: true; result: unknown; fires: string[]; logs: string[]; state: ScriptState }
  | { ok: false; error: string; logs: string[]; state: ScriptState }

/** The whole run, including everything the script waited for. */
const TOTAL_TIMEOUT_MS = 30_000
const FETCH_TIMEOUT_MS = 15_000
const MAX_BODY_CHARS = 1_000_000
const MAX_FILE_BYTES = 5_000_000
const MAX_ROWS = 5_000
const MAX_LISTED = 200

type Call = { type: 'call'; id: number; op: string; args: string }
type Done = { type: 'done'; ok: boolean; result?: string; error?: string; snapshot: string }

interface Capabilities {
  hosts: readonly string[]
  folders: readonly string[]
  readFiles: boolean
  secrets: readonly string[]
  readSecret: SecretReader
  /** Values of the secrets this run used: scrubbed from everything that comes back. */
  used: Set<string>
  fetchImpl: typeof fetch
}

/** Loaded on demand: the store needs Electron, which the pure parts of the runner do not. */
const defaultReadSecret: SecretReader = async (name) => (await import('./secrets-store')).readSecretValue(name)

/** Answers one bridge call. Never throws: a refusal travels as `{ error }`. */
async function answer(caps: Capabilities, op: string, rawArgs: string): Promise<string> {
  try {
    const args = JSON.parse(rawArgs) as Record<string, unknown>
    return JSON.stringify({ value: await perform(caps, op, args) })
  } catch (error) {
    return JSON.stringify({ error: redactText(error instanceof Error ? error.message : String(error), caps.used) })
  }
}

async function perform(caps: Capabilities, op: string, args: Record<string, unknown>): Promise<unknown> {
  if (op === 'fetch') {
    const checked = checkFetchUrl(String(args.url), caps.hosts)
    if (!checked.ok) throw new Error(checked.error)
    const headers = safeHeaders(args.headers)
    if (args.auth !== undefined) await applyAuth(args.auth, caps.secrets, caps.readSecret, caps.used, headers)
    const response = await caps.fetchImpl(checked.url, {
      method: 'GET',
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    return { status: response.status, body: redactText((await response.text()).slice(0, MAX_BODY_CHARS), caps.used) }
  }
  if (!caps.readFiles) throw new Error('The script did not declare that it reads files.')
  if (op === 'listFiles') {
    const dir = resolveInsideFolders(String(args.dir ?? '.'), caps.folders)
    if (!dir.ok) throw new Error(dir.error)
    const entries = await fsp.readdir(dir.path, { withFileTypes: true })
    return entries.slice(0, MAX_LISTED).map((e) => ({ name: e.name, dir: e.isDirectory() }))
  }
  const file = resolveInsideFolders(String(args.path), caps.folders)
  if (!file.ok) throw new Error(file.error)
  const stat = await fsp.stat(file.path)
  if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error('Not a file, or too large to read.')
  if (op === 'readFile') return await fsp.readFile(file.path, 'utf8')
  if (op === 'readSheet') {
    const book = XLSX.read(await fsp.readFile(file.path), { type: 'buffer' })
    const name = typeof args.sheet === 'string' && book.SheetNames.includes(args.sheet) ? args.sheet : book.SheetNames[0]
    const rows = XLSX.utils.sheet_to_json(book.Sheets[name], { defval: null })
    return { sheet: name, sheets: book.SheetNames, rows: rows.slice(0, MAX_ROWS), truncated: rows.length > MAX_ROWS }
  }
  throw new Error(`Unknown operation: ${op}`)
}

/**
 * Runs one script in its sandbox. `state` goes in and the updated one comes back; the caller
 * decides whether to keep it (a test run does not). Abilities are checked here, in the main
 * process, from what the script declared — never from what the script asks.
 */
export function runScript(options: {
  script: Pick<RoutineScript, 'code' | 'hosts' | 'readFiles' | 'secrets'>
  folders: readonly string[]
  state?: ScriptState
  input?: unknown
  fetchImpl?: typeof fetch
  /** Looks up a stored secret; defaults to the keychain-backed store. */
  readSecret?: SecretReader
}): Promise<ScriptOutcome> {
  const state = options.state ?? EMPTY_SCRIPT_STATE
  const caps: Capabilities = {
    hosts: options.script.hosts,
    folders: options.folders,
    readFiles: !!options.script.readFiles,
    secrets: options.script.secrets ?? [],
    readSecret: options.readSecret ?? defaultReadSecret,
    used: new Set<string>(),
    fetchImpl: options.fetchImpl ?? fetch,
  }
  return new Promise((resolve) => {
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16 },
      workerData: {
        boot: BOOT_SOURCE,
        code: options.script.code,
        state: JSON.stringify(state),
        input: JSON.stringify(options.input ?? null),
      },
    })
    let settled = false
    const finish = (outcome: ScriptOutcome) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      void worker.terminate()
      resolve(redactDeep(outcome, caps.used))
    }
    const timer = setTimeout(
      () => finish({ ok: false, error: 'The script took too long and was stopped.', logs: [], state }),
      TOTAL_TIMEOUT_MS,
    )
    worker.on('message', (message: Call | Done) => {
      if (message.type === 'call') {
        void answer(caps, message.op, message.args).then((payload) => {
          if (!settled) worker.postMessage({ type: 'reply', id: message.id, payload })
        })
        return
      }
      const snap = JSON.parse(message.snapshot) as { state: ScriptState; fires: string[]; logs: string[] }
      if (message.ok) {
        finish({ ok: true, result: JSON.parse(message.result ?? 'null'), fires: snap.fires, logs: snap.logs, state: snap.state })
      } else {
        finish({ ok: false, error: message.error ?? 'The script failed.', logs: snap.logs, state })
      }
    })
    worker.on('error', (error: Error) => finish({ ok: false, error: error.message, logs: [], state }))
    worker.on('exit', (code) => finish({ ok: false, error: `The script stopped (exit ${code}).`, logs: [], state }))
  })
}

/** Where a script run keeps its state file (one per routine). */
export function stateFile(root: string, routineId: string): string {
  return path.join(root, `${routineId}.json`)
}
