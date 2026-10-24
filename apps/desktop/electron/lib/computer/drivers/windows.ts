import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
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
 * Driver Windows: um host PowerShell persistente (bridges/windows.ps1 +
 * windows-host.cs) fala UI Automation, DWM e GDI. Simétrico ao driver do macOS —
 * mesmos tipos, mesmas operações —, só que o processo vive entre as chamadas:
 * o Add-Type paga 1–2 s uma vez, não a cada operação.
 *
 * O Windows não tem permissão de sistema a pedir: o que pode faltar é o host
 * subir (PowerShell em Constrained Language Mode) ou o app-alvo estar
 * elevado, e ambos viram erro claro.
 */

const READ_TIMEOUT_MS = 10_000
const ACTION_TIMEOUT_MS = 15_000
/** A compilação do C# (Add-Type) conta só no primeiro pedido de cada host. */
const STARTUP_GRACE_MS = 25_000

let hostFile: Promise<string> | null = null

/**
 * Grava host.ps1 e host.cs lado a lado, numa pasta que carrega o hash do
 * conteúdo (uma versão nova do Orbit nunca roda o host velho). O .ps1 vai com
 * BOM: sem ele, o PowerShell 5.1 lê o arquivo na página de código ANSI.
 */
function ensureHostFiles(): Promise<string> {
  hostFile ??= (async () => {
    const hash = createHash('sha1').update(HOST_PS1).update(HOST_CS).digest('hex').slice(0, 10)
    const dir = path.join(os.tmpdir(), 'orbit-computer', `win-${hash}`)
    await fsp.mkdir(dir, { recursive: true })
    await fsp.writeFile(path.join(dir, 'host.cs'), HOST_CS, 'utf8')
    const ps1 = path.join(dir, 'host.ps1')
    await fsp.writeFile(ps1, String.fromCharCode(0xfeff) + HOST_PS1, 'utf8')
    return ps1
  })().catch((err) => {
    hostFile = null
    throw err
  })
  return hostFile
}

/** Sem janela de console piscando a cada partida do host. */
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

/** Encerra o host (fim do app). O próximo uso sobe outro. */
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
    // directedPointer: o que o modo dirigido entrega é só pela UI Automation
    // (ver "Decisão de entrada" no plano); messageMouse fica desligado até o
    // Stage 0 provar, por tipo de app, que mensagem de janela chega.
    capabilities: () => ({ directedPointer: true, dragNeedsGlobal: true, accessibilityTree: true, messageMouse: false }),
    perms: (signal) => run('perms', {}, { timeoutMs: READ_TIMEOUT_MS, signal }),
    // O Windows não tem diálogo de captura de tela.
    requestScreen: async () => ({ before: true, granted: true }),
    apps: (signal) => run<AppsSnapshot>('apps', {}, { timeoutMs: READ_TIMEOUT_MS, signal }),
    tree: (request: TreeRequest, signal) => run<TreeSnapshot>('tree', request, { timeoutMs: READ_TIMEOUT_MS, signal }),
    act: (action: BridgeAction, signal) => {
      const { op, ...args } = action
      return run<ElementResult>(op, args, { timeoutMs: ACTION_TIMEOUT_MS, signal })
    },
    // Não há flag de acessibilidade ligada nos apps para devolver.
    restore: async () => undefined,
    capture: async (windowId, signal) => {
      const file = path.join(os.tmpdir(), 'orbit-computer', `shot-${process.pid}-${windowId}-${Date.now()}.png`)
      await fsp.mkdir(path.dirname(file), { recursive: true })
      try {
        // O host escreve o PNG e devolve o caminho: base64 pelo stdout custaria
        // ~33% a mais e uma cópia na linha JSON.
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
