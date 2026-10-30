/**
 * Electron apps on macOS inherit a sanitized PATH (/usr/bin:/bin:/usr/sbin:/sbin)
 * from LaunchServices — without /opt/homebrew/bin etc. Terminal.app only works because it
 * opens a LOGIN shell, which runs /etc/zprofile → path_helper assembles the real PATH.
 *
 * This module replicates that behavior in the shells Orbit opens:
 *  - interactive stdin (PTY): spawn with `-l` (login shell); and
 *  - non-interactive commands (the agent's bash tool, background
 *    processes): injects an enriched PATH into the env, since `zsh -c` does not read ~/.zshrc
 *    (where nvm lives, for example).
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Login shell args for the terminal's PTY. On Windows, no changes. */
export function loginShellArgs(): string[] {
  return process.platform === 'win32' ? [] : ['-l']
}

/**
 * Folders of binaries that come with the app (video editing's ffmpeg), put
 * at the END of the PATH: the agent finds `ffmpeg` in bash even without the user having one,
 * and one installed by them still wins. Registered by the main at startup —
 * this module does not know Electron.
 */
const bundledToolDirs: string[] = []

export function addBundledToolDir(dir: string): void {
  if (!bundledToolDirs.includes(dir)) bundledToolDirs.push(dir)
}

/** spawn env that guarantees the user's full PATH (/etc dirs, Homebrew, nvm). */
export function userShellEnv(): NodeJS.ProcessEnv {
  if (process.platform === 'win32') {
    if (bundledToolDirs.length === 0) return process.env
    // The Windows env ignores case ("Path"), the copy does not: it rewrites the SAME
    // key, otherwise the child receives two and keeps any one of them.
    const env = { ...process.env }
    const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'
    env[key] = [...(env[key] ?? '').split(';').filter(Boolean), ...bundledToolDirs].join(';')
    return env
  }

  const parts = new Set(pathList(process.env.PATH ?? ''))

  for (const p of [...readPathFile('/etc/paths'), ...listPathDirs('/etc/paths.d')]) {
    parts.add(p)
  }
  parts.add('/opt/homebrew/bin')
  parts.add('/usr/local/bin')
  parts.add(path.join(os.homedir(), '.local', 'bin'))

  const nvmBin = latestNvmBin()
  if (nvmBin) parts.add(nvmBin)
  for (const dir of bundledToolDirs) parts.add(dir)

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

/** $NVM_DIR/versions/node/<latest>/bin path, if nvm is in use. */
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