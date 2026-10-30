import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import HOST_ACTIONS_CS from '../bridges/windows-host-actions.cs?raw'
import HOST_CS from '../bridges/windows-host.cs?raw'
import HOST_PS1 from '../bridges/windows.ps1?raw'
import { createPersistentRunner, type PersistentRunner, type PersistentSpawn } from '../runner'
import {
  ComputerError,
  type AppsSnapshot,
  type BridgeAction,
  type ComputerDriver,
  type ElementResult,
  type TreeRequest,
  type TreeSnapshot,
} from '../types'

/**
 * Windows driver: a persistent PowerShell host (bridges/windows.ps1 +
 * windows-host.cs) speaks UI Automation, DWM and GDI. Symmetric to the macOS driver —
 * same types, same operations —, except that the process lives between calls: Add-Type
 * pays 1–2 s once, not on every operation.
 *
 * Windows has no system permission to ask for: what may be missing is the host
 * starting (PowerShell in Constrained Language Mode) or the target app being elevated,
 * and both become a clear error.
 */

const READ_TIMEOUT_MS = 10_000
const ACTION_TIMEOUT_MS = 15_000
/** The C# compilation (Add-Type) only counts on the first request of each host. */
const STARTUP_GRACE_MS = 25_000

let hostFile: Promise<string> | null = null

/**
 * Writes host.ps1, host.cs and actions.cs side by side, in a folder that carries the
 * content hash (a new Orbit version never runs the old host). The .ps1 goes with a
 * BOM: without it, PowerShell 5.1 reads the file in the ANSI codepage.
 */
function ensureHostFiles(): Promise<string> {
  hostFile ??= (async () => {
    const hash = createHash('sha1').update(HOST_PS1).update(HOST_CS).update(HOST_ACTIONS_CS).digest('hex').slice(0, 10)
    const dir = path.join(os.tmpdir(), 'orbit-computer', `win-${hash}`)
    await fsp.mkdir(dir, { recursive: true })
    await fsp.writeFile(path.join(dir, 'host.cs'), HOST_CS, 'utf8')
    await fsp.writeFile(path.join(dir, 'actions.cs'), HOST_ACTIONS_CS, 'utf8')
    const ps1 = path.join(dir, 'host.ps1')
    await fsp.writeFile(ps1, String.fromCharCode(0xfeff) + HOST_PS1, 'utf8')
    return ps1
  })().catch((err) => {
    hostFile = null
    throw err
  })
  return hostFile
}

/** Without a console window flashing on every host start. */
const spawnHost: PersistentSpawn = (command, args) => spawn(command, args, { windowsHide: true })

let sharedRunner: PersistentRunner | null = null

function defaultRunner(): PersistentRunner {
  sharedRunner ??= createPersistentRunner(
    'powershell.exe',
    async () => ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', await ensureHostFiles()],
    spawnHost,
    { startupGraceMs: STARTUP_GRACE_MS },
  )
  return sharedRunner
}

/** Shuts the host down (app exit). The next use starts another one. */
export function disposeWindowsHost(): void {
  sharedRunner?.dispose()
  sharedRunner = null
}

interface CaptureResult {
  file: string
  width: number
  height: number
  method: 'printwindow' | 'screen'
}

export function createWindowsDriver(run: PersistentRunner = defaultRunner()): ComputerDriver {
  return {
    platform: 'win32',
    // directedPointer: what the directed mode delivers comes only from UI Automation
    // (see "Input decision" in the plan); messageMouse stays off until
    // Stage 0 proves, per app type, that a window message arrives.
    capabilities: () => ({ directedPointer: true, dragNeedsGlobal: true, accessibilityTree: true, messageMouse: false }),
    perms: (signal) => run('perms', {}, { timeoutMs: READ_TIMEOUT_MS, signal }),
    // Windows has no screen capture dialog.
    requestScreen: async () => ({ before: true, granted: true }),
    apps: (signal) => run<AppsSnapshot>('apps', {}, { timeoutMs: READ_TIMEOUT_MS, signal }),
    tree: (request: TreeRequest, signal) => run<TreeSnapshot>('tree', request, { timeoutMs: READ_TIMEOUT_MS, signal }),
    act: (action: BridgeAction, signal) => {
      const { op, ...args } = action
      return run<ElementResult>(op, args, { timeoutMs: ACTION_TIMEOUT_MS, signal })
    },
    // There is no accessibility flag turned on in the apps to give back.
    restore: async () => undefined,
    capture: async (windowId, signal) => {
      const file = path.join(os.tmpdir(), 'orbit-computer', `shot-${process.pid}-${windowId}-${Date.now()}.png`)
      await fsp.mkdir(path.dirname(file), { recursive: true })
      try {
        // The host writes the PNG and returns the path: base64 through stdout would cost
        // ~33% more and a copy in the JSON line.
        const done = await run<CaptureResult>('capture', { windowId, file }, { timeoutMs: READ_TIMEOUT_MS, signal })
        const buffer = await fsp.readFile(done.file)
        if (buffer.length === 0) throw new ComputerError('windowNotFound', 'The capture came out empty.')
        return buffer
      } finally {
        await fsp.rm(file, { force: true })
      }
    },
    openApp: async (app, signal) => {
      await run('openApp', { app }, { timeoutMs: ACTION_TIMEOUT_MS * 2, signal })
    },
  }
}
