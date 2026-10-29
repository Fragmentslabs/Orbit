import { app } from 'electron'
import { execFile } from 'node:child_process'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

/**
 * "Rodar em segundo plano" (macOS): um LaunchAgent que relança o Orbit com
 * `--hidden` se o processo sair — o equivalente do gateway de serviço dos
 * agentes de terminal, para as rotinas não dependerem de ninguém lembrar de
 * abrir o app.
 *
 * `KeepAlive` relança também depois de um ⌘Q: é o que a opção PROMETE ("o
 * app reabre sozinho se você sair"). É opt-in e desligada por padrão — quem
 * liga decide viver com isso, e desligar volta a permitir sair de verdade.
 */

const execFileAsync = promisify(execFile)
const LABEL = 'ai.orbit.background'

function plistPath(): string {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`)
}

/** Comando que o LaunchAgent executa: o executável com --hidden (+ appRoot em dev). */
function launchCommand(): string[] {
  const appRoot = process.env.APP_ROOT
  const needsAppPath = !app.isPackaged && Boolean(appRoot)
  return [process.execPath, '--hidden', ...(needsAppPath ? [appRoot as string] : [])]
}

export function backgroundSuportado(): boolean {
  return process.platform === 'darwin'
}

export async function estadoBackground(): Promise<{ ativo: boolean; suportado: boolean }> {
  const suportado = backgroundSuportado()
  if (!suportado) return { ativo: false, suportado }
  try {
    await fsp.access(plistPath())
    return { ativo: true, suportado }
  } catch {
    return { ativo: false, suportado }
  }
}

export async function aplicarBackground(ativo: boolean): Promise<{ ok: boolean; error?: string }> {
  if (!backgroundSuportado()) return { ok: false, error: 'execução em segundo plano só no macOS' }
  try {
    if (ativo) {
      const plist = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
        '<plist version="1.0">',
        '<dict>',
        `  <key>Label</key><string>${LABEL}</string>`,
        '  <key>ProgramArguments</key>',
        '  <array>',
        ...launchCommand().map((arg) => `    <string>${arg.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</string>`),
        '  </array>',
        '  <key>RunAtLoad</key><true/>',
        '  <key>KeepAlive</key><true/>',
        '</dict>',
        '</plist>',
        '',
      ].join('\n')
      await fsp.mkdir(path.dirname(plistPath()), { recursive: true })
      await fsp.writeFile(plistPath(), plist, 'utf8')
      // bootout tolera "não carregado"; bootstrap registra — o RunAtLoad
      // dispara na hora e o single-instance do app transforma isso num show().
      const uid = process.getuid?.() ?? os.userInfo().uid
      await execFileAsync('launchctl', ['bootout', `gui/${uid}/${LABEL}`]).catch(() => {})
      await execFileAsync('launchctl', ['bootstrap', `gui/${uid}`, plistPath()])
    } else {
      const uid = process.getuid?.() ?? os.userInfo().uid
      await execFileAsync('launchctl', ['bootout', `gui/${uid}/${LABEL}`]).catch(() => {})
      await fsp.rm(plistPath(), { force: true })
    }
    return { ok: true }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.warn('[rotinas] ajuste do plano de fundo falhou:', message)
    return { ok: false, error: message }
  }
}
