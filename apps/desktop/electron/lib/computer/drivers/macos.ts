import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { systemPreferences } from 'electron'
import BRIDGE_SOURCE from '../bridges/macos.js?raw'
import { createBridgeRunner } from '../runner'
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
 * Driver macOS: a bridge JXA roda num `osascript` filho. O TCC atribui a
 * permissão ao processo responsável (o Orbit), então a Acessibilidade e a
 * Gravação de Tela concedidas ao app valem para o filho — em dev, o dono é o
 * binário do Electron, não o Orbit.
 */

const READ_TIMEOUT_MS = 10_000
const ACTION_TIMEOUT_MS = 15_000

let bridgeFile: Promise<string> | null = null

/** Grava a bridge uma vez por versão do conteúdo (o nome carrega o hash). */
function ensureBridgeFile(): Promise<string> {
  bridgeFile ??= (async () => {
    const hash = createHash('sha1').update(BRIDGE_SOURCE).digest('hex').slice(0, 10)
    const dir = path.join(os.tmpdir(), 'orbit-computer')
    await fsp.mkdir(dir, { recursive: true })
    const file = path.join(dir, `macos-bridge-${hash}.js`)
    await fsp.writeFile(file, BRIDGE_SOURCE, 'utf8')
    return file
  })().catch((err) => {
    bridgeFile = null
    throw err
  })
  return bridgeFile
}

const run = createBridgeRunner('osascript', async () => ['-l', 'JavaScript', await ensureBridgeFile()])

function execOnce(command: string, args: string[], timeoutMs: number, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: timeoutMs, signal }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stderr: String(stderr) }))
      else resolve(String(stdout))
    })
  })
}

function screenGranted(): boolean {
  try {
    return systemPreferences.getMediaAccessStatus('screen') === 'granted'
  } catch {
    return false
  }
}

export function createMacosDriver(): ComputerDriver {
  return {
    platform: 'darwin',
    capabilities: () => ({ directedPointer: true, dragNeedsGlobal: true, accessibilityTree: true }),
    perms: (signal) => run('perms', {}, { timeoutMs: READ_TIMEOUT_MS, signal }),
    apps: (signal) => run<AppsSnapshot>('apps', {}, { timeoutMs: READ_TIMEOUT_MS, signal }),
    tree: (request: TreeRequest, signal) => run<TreeSnapshot>('tree', request, { timeoutMs: READ_TIMEOUT_MS, signal }),
    act: (action: BridgeAction, signal) => {
      const { op, ...args } = action
      return run<ElementResult>(op, args, { timeoutMs: ACTION_TIMEOUT_MS, signal })
    },
    restore: async (pids) => {
      if (!pids.length) return
      await run('restore', { pids }, { timeoutMs: READ_TIMEOUT_MS }).catch(() => undefined)
    },
    capture: async (windowId, signal) => {
      const file = path.join(os.tmpdir(), 'orbit-computer', `shot-${process.pid}-${windowId}-${Date.now()}.png`)
      await fsp.mkdir(path.dirname(file), { recursive: true })
      try {
        // -o sem sombra; -x sem som; -l captura a janela mesmo coberta por outra.
        await execOnce('screencapture', ['-x', '-o', `-l${windowId}`, '-t', 'png', file], READ_TIMEOUT_MS, signal)
        const buffer = await fsp.readFile(file)
        if (buffer.length === 0) throw new Error('empty capture')
        return buffer
      } catch (err) {
        if (signal?.aborted) throw new ComputerError('aborted', 'Computer use was stopped.')
        if (!screenGranted()) {
          throw new ComputerError('screenDenied', 'Screen Recording permission is not granted to Orbit — the screenshot is unavailable (the accessibility tree still works).')
        }
        throw new ComputerError('windowNotFound', `Could not capture the window (${(err as Error).message.trim()}). It may have closed or been minimized — call cu_apps again.`)
      } finally {
        await fsp.rm(file, { force: true })
      }
    },
    openApp: async (app, signal) => {
      // Bundle id (com.apple.TextEdit) abre por -b; nome (TextEdit) por -a.
      const args = /^[\w-]+(\.[\w-]+)+$/.test(app) ? ['-b', app] : ['-a', app]
      try {
        await execOnce('open', args, ACTION_TIMEOUT_MS, signal)
      } catch {
        throw new ComputerError('appNotFound', `Could not open "${app}" — check the app name or bundle id.`)
      }
    },
  }
}
