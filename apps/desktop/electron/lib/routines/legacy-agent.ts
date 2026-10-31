import { execFile } from 'node:child_process'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

/**
 * The LaunchAgent that kept Orbit resident is gone.
 *
 * Up to 0.1.4 the app wrote `ai.orbit.background` into ~/Library/LaunchAgents to
 * come back at login — and after a crash — with `--hidden`. It did the job, and
 * charged a price that only showed up in the system settings: a bare plist has no
 * bundle, so the "background items" panel named it after whoever signed the code,
 * the developer, instead of the app. The login item does the same job (minus the
 * crash restart) and the system can call it Orbit.
 *
 * What is left here is the migration: an app that already ran 0.1.4 still carries
 * the plist and the loaded job, and the panel keeps listing them under the
 * developer's name until both are gone.
 */

const execFileAsync = promisify(execFile)
const LABEL = 'ai.orbit.background'

function plistPath(): string {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`)
}

function uid(): number {
  return process.getuid?.() ?? os.userInfo().uid
}

/**
 * Unloads the job and deletes the plist. Idempotent: on a machine that never ran
 * 0.1.4 there is nothing to do, and a failure here must not take the startup down
 * with it.
 */
export async function removeLegacyBackgroundAgent(): Promise<void> {
  if (process.platform !== 'darwin') return
  const file = plistPath()
  const exists = await fsp
    .access(file)
    .then(() => true)
    .catch(() => false)
  if (!exists) return
  await execFileAsync('launchctl', ['bootout', `gui/${uid()}/${LABEL}`]).catch(() => {})
  await fsp.rm(file, { force: true }).catch(() => {})
}
