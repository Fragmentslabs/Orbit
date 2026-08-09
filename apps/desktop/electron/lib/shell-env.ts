/**
 * Apps Electron no macOS herdam um PATH sanitizado (/usr/bin:/bin:/usr/sbin:/sbin)
 * do LaunchServices — sem /opt/homebrew/bin etc. O Terminal.app só funciona porque
 * abre shell de LOGIN, que roda /etc/zprofile → path_helper monta o PATH real.
 *
 * Este módulo replica esse comportamento nos shells que o Orbit abre:
 *  - stdin interativo (PTY): spawn com `-l` (login shell); e
 *  - comandos não-interativos (ferramenta bash do agente, processos em segundo
 *    plano): injeta um PATH enriquecido no env, já que `zsh -c` não lê ~/.zshrc
 *    (onde fica o nvm, por exemplo).
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Args de login shell para o PTY do terminal. No Windows, sem mudanças. */
export function loginShellArgs(): string[] {
  return process.platform === 'win32' ? [] : ['-l']
}

/** env de spawn que garante o PATH completo do usuário (dirs do /etc, Homebrew, nvm). */
export function userShellEnv(): NodeJS.ProcessEnv {
  if (process.platform === 'win32') return process.env

  const parts = new Set(pathList(process.env.PATH ?? ''))

  for (const p of [...readPathFile('/etc/paths'), ...listPathDirs('/etc/paths.d')]) {
    parts.add(p)
  }
  parts.add('/opt/homebrew/bin')
  parts.add('/usr/local/bin')
  parts.add(path.join(os.homedir(), '.local', 'bin'))

  const nvmBin = latestNvmBin()
  if (nvmBin) parts.add(nvmBin)

  return { ...process.env, PATH: [...parts].join(':') }
}

function pathList(value: string): string[] {
  return value.split(':').map(p => p.trim()).filter(Boolean)
}

function readPathFile(file: string): string[] {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').map(l => l.trim()).filter(Boolean)
  } catch {
    return []
  }
}

function listPathDirs(dir: string): string[] {
  try {
    return fs.readdirSync(dir)
      .filter(name => !name.startsWith('.'))
      .flatMap(name => readPathFile(path.join(dir, name)))
  } catch {
    return []
  }
}

/** Caminho $NVM_DIR/versions/node/<última>/bin, se o nvm estiver em uso. */
function latestNvmBin(): string | undefined {
  const nvmDir = process.env.NVM_DIR || path.join(os.homedir(), '.nvm')
  const versionsDir = path.join(nvmDir, 'versions', 'node')
  let entries: string[]
  try {
    entries = fs.readdirSync(versionsDir)
  } catch {
    return undefined
  }
  const versions = entries.filter(v => /^v\d+\.\d+\.\d+$/.test(v)).sort(compareVersions)
  const latest = versions.at(-1)
  return latest ? path.join(versionsDir, latest, 'bin') : undefined
}

function compareVersions(a: string, b: string): number {
  const pa = a.slice(1).split('.').map(Number)
  const pb = b.slice(1).split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i]
  }
  return 0
}