import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { app, desktopCapturer, shell, systemPreferences } from 'electron'
import type { ComputerStatus, ComputerTestResult } from '@shared/computer'
import { createMacosDriver } from './drivers/macos'
import { computerRegistry } from './registry'
import { disposeComputerSessions, setComputerRestoreHandler } from './session'
import { ComputerError, type ComputerDriver } from './types'

/**
 * Fachada do Computer Use. A v1 só tem driver para o macOS e fica desligada
 * na Mac App Store: o sandbox de lá bloqueia acessibilidade e injeção de
 * eventos, e anunciar uma tool que não funciona é pior do que não ter.
 */

export { computerRegistry }

let driver: ComputerDriver | null = null

export function computerSupport(): { available: boolean; reason: ComputerStatus['reason'] } {
  if (process.mas) return { available: false, reason: 'mas' }
  if (process.platform !== 'darwin') return { available: false, reason: 'platform' }
  return { available: true, reason: null }
}

export function isComputerAvailable(): boolean {
  return computerSupport().available
}

export function getComputerDriver(): ComputerDriver {
  if (!driver) {
    if (!isComputerAvailable()) throw new ComputerError('unavailable', 'Computer use is not available on this platform.')
    driver = createMacosDriver()
    const d = driver
    setComputerRestoreHandler((pids) => d.restore(pids))
  }
  return driver
}

/** Troca o driver (testes). */
export function setComputerDriver(next: ComputerDriver | null): void {
  driver = next
  if (next) setComputerRestoreHandler((pids) => next.restore(pids))
}

const run = promisify(execFile)

/**
 * O app que o macOS trata como dono das permissões deste processo. O TCC
 * atribui ao processo responsável: aberto pelo Finder, é o próprio app; aberto
 * por um shell (`npm run dev`), é o app do terminal que lançou — e aí liberar o
 * "Electron" em Ajustes não adianta (visto na Fase 0: o Orbit em dev era do
 * Terminal). Sobe pelos pais até o primeiro bundle .app.
 */
export async function responsibleApp(): Promise<string | null> {
  let pid = process.ppid
  for (let i = 0; i < 12 && pid > 1; i++) {
    const { stdout } = await run('ps', ['-o', 'ppid=,comm=', '-p', String(pid)]).catch(() => ({ stdout: '' }))
    const match = /^\s*(\d+)\s+(.+)$/.exec(stdout.trim())
    if (!match) return null
    const bundle = /([^/]+)\.app\/Contents\/MacOS\//.exec(match[2])
    if (bundle) return bundle[1]
    pid = Number(match[1])
  }
  return null
}

export async function computerStatus(): Promise<ComputerStatus> {
  const support = computerSupport()
  const base: ComputerStatus = {
    available: support.available,
    reason: support.reason,
    platform: process.platform,
    accessibility: false,
    screen: 'unknown',
    dev: !app.isPackaged,
    responsible: null,
  }
  if (!support.available) return base
  base.responsible = await responsibleApp()
  try {
    base.accessibility = systemPreferences.isTrustedAccessibilityClient(false)
  } catch {
    base.accessibility = false
  }
  try {
    base.screen = systemPreferences.getMediaAccessStatus('screen')
  } catch {
    base.screen = 'unknown'
  }
  return base
}

/** Pede a permissão de Acessibilidade (o macOS abre o próprio diálogo). */
export function requestAccessibility(): boolean {
  if (!isComputerAvailable()) return false
  return systemPreferences.isTrustedAccessibilityClient(true)
}

/**
 * Pede a Gravação de Tela. O macOS só lista o app em Ajustes depois que ele
 * tenta capturar — e, em dev, o "Electron" da lista precisa ser o binário
 * deste projeto (Fase 0: liberar o Electron de outro projeto não vale). Pedir
 * as fontes de captura cria a entrada certa; depois abre o painel.
 */
export async function requestScreenRecording(): Promise<void> {
  if (!isComputerAvailable()) return
  await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } }).catch(() => undefined)
  await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture').catch(() => undefined)
}

/**
 * "Testar" das Preferências: uma chamada real à bridge, não só a leitura da
 * flag. É o que prova que a permissão concedida ao Orbit vale para o processo
 * filho que faz o trabalho.
 */
export async function testComputer(): Promise<ComputerTestResult> {
  const started = Date.now()
  try {
    const d = getComputerDriver()
    const perms = await d.perms()
    if (!perms.accessibility) {
      return { ok: false, ms: Date.now() - started, message: 'axDenied' }
    }
    const snapshot = await d.apps()
    const front = snapshot.apps.find((a) => a.active && a.pid !== process.pid) ?? snapshot.apps.find((a) => a.pid !== process.pid)
    const win = front ? snapshot.windows.find((w) => w.pid === front.pid) : undefined
    if (front && win) {
      const tree = await d.tree({ pid: front.pid, window: { frame: win.frame, title: win.title }, maxNodes: 60 })
      return { ok: true, ms: Date.now() - started, message: `${front.name}: ${tree.nodes.length}` }
    }
    return { ok: true, ms: Date.now() - started, message: '' }
  } catch (err) {
    return { ok: false, ms: Date.now() - started, message: err instanceof ComputerError ? err.code : String(err) }
  }
}

export async function disposeComputerUse(): Promise<void> {
  await disposeComputerSessions()
}

export { ComputerError } from './types'
export { stopComputer, getComputerActivity, setComputerStopHandler, endActivity } from './session'
