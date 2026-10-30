import { app } from 'electron'
import { execFile } from 'node:child_process'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

/**
 * "Run in the background" (macOS): a LaunchAgent that relaunches Orbit with
 * `--hidden` if the process exits — the equivalent of the service gateway of
 * terminal agents, so routines do not depend on anyone remembering to open the
 * app.
 *
 * `KeepAlive` also relaunches after a ⌘Q: that is what the option PROMISES ("the
 * app reopens by itself if you quit"). It is opt-in and off by default — whoever
 * turns it on decides to live with that, and turning it off allows quitting for
 * real again.
 */

const execFileAsync = promisify(execFile)
const LABEL = 'ai.orbit.background'

function plistPath(): string {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`)
}

/** Command the LaunchAgent runs: the executable with --hidden (+ appRoot in dev). */
function launchCommand(): string[] {
  const appRoot = process.env.APP_ROOT
  const needsAppPath = !app.isPackaged && Boolean(appRoot)
  return [process.execPath, '--hidden', ...(needsAppPath ? [appRoot as string] : [])]
}

export function isBackgroundSupported(): boolean {
  return process.platform === 'darwin'
}

export async function backgroundState(): Promise<{ active: boolean; supported: boolean }> {
  const supported = isBackgroundSupported()
  if (!supported) return { active: false, supported }
  try {
    await fsp.access(plistPath())
    return { active: true, supported }
  } catch {
    return { active: false, supported }
  }
}

export async function applyBackground(active: boolean): Promise<{ ok: boolean; error?: string }> {
  if (!isBackgroundSupported()) return { ok: false, error: 'background execution only on macOS' }
  try {
    if (active) {
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
      // bootout tolerates "not loaded"; bootstrap registers it — RunAtLoad fires
      // right away and the app's single-instance turns that into a show().
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
    console.warn('[routines] background plan setup failed:', message)
    return { ok: false, error: message }
  }
}
