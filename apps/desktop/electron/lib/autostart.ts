import { app } from 'electron'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/**
 * "Open with the system".
 *
 * Windows and macOS have Electron's native path. On Linux,
 * `setLoginItemSettings` does not create an autostart entry (the app is launched by the
 * desktop environment, not by a system registry), so the path is to
 * write the .desktop in ~/.config/autostart — which is exactly what the
 * session managers read.
 *
 * In dev mode the executable is Electron's and the app's folder becomes an argument:
 * without this, logging in would open an empty Electron instead of Orbit.
 */

const LINUX_DESKTOP_FILE = 'orbit.desktop'

/** Command the system must run to open Orbit, already as a list. */
function launchCommand(): string[] {
  const appRoot = process.env.APP_ROOT
  const needsAppPath = !app.isPackaged && Boolean(appRoot)
  return needsAppPath ? [process.execPath, appRoot as string] : [process.execPath]
}

function autostartFilePath(): string {
  const configDir = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')
  return path.join(configDir, 'autostart', LINUX_DESKTOP_FILE)
}

/** Single quotes in the Exec value (the .desktop format requires escaping them). */
function quoteDesktopArg(value: string): string {
  return `"${value.replace(/(["\\`$])/g, '\\$1')}"`
}

async function applyLinux(enabled: boolean): Promise<void> {
  const file = autostartFilePath()
  if (!enabled) {
    await fs.rm(file, { force: true })
    return
  }
  const [command, ...args] = launchCommand()
  const exec = [command, ...args].map(quoteDesktopArg).join(' ')
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(
    file,
    [
      '[Desktop Entry]',
      'Type=Application',
      'Name=Orbit',
      'Comment=Orbit coding assistant',
      `Exec=${exec}`,
      'Terminal=false',
      'X-GNOME-Autostart-enabled=true',
      '',
    ].join('\n'),
    'utf8',
  )
}

/**
 * Turns the automatic opening on/off. It returns the error instead of throwing: the
 * preference is written either way (the UI cannot keep lying that it
 * saved), but the caller logs the reason the system did not obey.
 */
export async function applyLaunchAtLogin(enabled: boolean): Promise<{ ok: boolean; error?: string }> {
  try {
    if (process.platform === 'linux') {
      await applyLinux(enabled)
      return { ok: true }
    }
    const [command, ...args] = launchCommand()
    app.setLoginItemSettings({
      openAtLogin: enabled,
      path: command,
      ...(args.length > 0 ? { args } : {}),
      // Only macOS understands it: it opens without stealing focus, like a tray app.
      ...(process.platform === 'darwin' ? { openAsHidden: true } : {}),
    })
    return { ok: true }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.warn('[autostart] could not set up launch at login:', message)
    return { ok: false, error: message }
  }
}
