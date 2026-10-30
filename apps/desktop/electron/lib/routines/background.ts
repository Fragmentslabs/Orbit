import { app } from 'electron'
import { execFile } from 'node:child_process'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

/**
 * Residency (macOS): Orbit lives in the Dock with the window closed, and this
 * LaunchAgent brings it back at login — and after a crash — with `--hidden`, so
 * routines fire without anyone remembering to open the app. It is not a
 * preference: being resident is what makes a routine a routine.
 *
 * Two details here are easy to get wrong, both learned the hard way:
 *
 *  - `KeepAlive` is `{ SuccessfulExit: false }`, never `true`. With `true`,
 *    launchd relaunches the job every time its process exits — and the instance
 *    it spawns while the app is ALREADY running dies in the single-instance
 *    lock, which launchd reads as "it died", and respawns. Forever, every ~10 s,
 *    booting a whole Electron that quits on the next line.
 *  - It is installed once and re-registered only when the command in the plist
 *    changes. A `bootout` on every boot would kill the very job we are running
 *    in when launchd starts the app at login.
 */

const execFileAsync = promisify(execFile)
const LABEL = 'ai.orbit.background'

function plistPath(): string {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`)
}

function uid(): number {
  return process.getuid?.() ?? os.userInfo().uid
}

/** Command the LaunchAgent runs: the executable with --hidden (+ appRoot in dev). */
function launchCommand(): string[] {
  const appRoot = process.env.APP_ROOT
  const needsAppPath = !app.isPackaged && Boolean(appRoot)
  return [process.execPath, '--hidden', ...(needsAppPath ? [appRoot as string] : [])]
}

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function plistXml(): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    `  <key>Label</key><string>${LABEL}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    ...launchCommand().map((arg) => `    <string>${escapeXml(arg)}</string>`),
    '  </array>',
    '  <key>RunAtLoad</key><true/>',
    '  <key>KeepAlive</key>',
    '  <dict>',
    '    <key>SuccessfulExit</key><false/>',
    '  </dict>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n')
}

async function isLoaded(): Promise<boolean> {
  try {
    await execFileAsync('launchctl', ['print', `gui/${uid()}/${LABEL}`])
    return true
  } catch {
    return false
  }
}

/**
 * Installs (or repairs) the agent. Idempotent and cheap: with the plist already
 * matching what this build runs and the job loaded, it touches nothing — which
 * is also what keeps the login launch from booting out the instance it is
 * running in.
 */
export async function installBackgroundAgent(): Promise<void> {
  if (process.platform !== 'darwin') return
  try {
    const desired = plistXml()
    const current = await fsp.readFile(plistPath(), 'utf8').catch(() => null)
    if (current === desired && (await isLoaded())) return
    await fsp.mkdir(path.dirname(plistPath()), { recursive: true })
    if (current !== desired) await fsp.writeFile(plistPath(), desired, 'utf8')
    // Re-register so launchd picks up new ProgramArguments (a new build, or the
    // dev Electron and the installed app sharing the same label).
    await execFileAsync('launchctl', ['bootout', `gui/${uid()}/${LABEL}`]).catch(() => {})
    await execFileAsync('launchctl', ['bootstrap', `gui/${uid()}`, plistPath()])
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.warn('[routines] background agent setup failed:', message)
  }
}
