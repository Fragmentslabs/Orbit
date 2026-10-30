import { app } from 'electron'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { userShellEnv } from './shell-env'

/**
 * Playback of custom sounds (WAV) in the main process.
 *
 * Product sounds: `notification.wav` (notification banners). The persona's
 * entrance sound no longer goes through here — the renderer plays it with WebAudio
 * (see src/lib/entrance-sound.ts), synchronized with the wake-up. In dev the
 * files live in `assets/sounds` at the app root; in production they are copied
 * by electron-builder (`extraResources`) to `Resources/sounds`.
 *
 * Player per platform: macOS `afplay`, Windows SoundPlayer via PowerShell,
 * Linux `pw-play`/`paplay`/`aplay`/`ffplay`. When no player is
 * available the caller falls back to the system's native sound (see notifications.ts).
 *
 * All players have to be SYNCHRONOUS: the audio dies along with the process
 * that plays it. On Windows that means `PlaySync()` — with `Play()`, which is
 * asynchronous, PowerShell exited in ~0.7s and cut the sound in the middle.
 */

type Player = { bin: string; args: (file: string) => string[] }

/** Sound diagnostic log (small file, playback events only). */
export function logSound(msg: string): void {
  try {
    const dir = app.getPath('logs')
    mkdirSync(dir, { recursive: true })
    appendFileSync(path.join(dir, 'sound.log'), `[${new Date().toISOString()}] ${msg}\n`)
  } catch {
    // the log is best-effort; it can never bring the playback down
  }
}

let playerCache: Player | null | 'unknown' = 'unknown'

/** The user's PATH (on Linux/macOS a GUI app inherits a reduced PATH). */
let envCache: NodeJS.ProcessEnv | undefined
function playerEnv(): NodeJS.ProcessEnv {
  envCache ??= userShellEnv()
  return envCache
}

/**
 * Looks for the binary in the PATH directories by reading the disk.
 *
 * Before, this called `which`, which made the whole detection depend on an
 * external utility: on a slim image without it, NO player was found and
 * Linux went silent. Reading the PATH depends on nothing.
 */
function commandExists(cmd: string): boolean {
  const dirs = (playerEnv().PATH ?? '').split(path.delimiter).filter(Boolean)
  for (const dir of dirs) {
    const candidate = path.join(dir, cmd)
    try {
      if (statSync(candidate).isFile()) return true
    } catch {
      // nonexistent path or no permission — moves on to the next one
    }
  }
  return false
}

async function resolvePlayer(): Promise<Player | null> {
  if (playerCache !== 'unknown') return playerCache

  let player: Player | null = null

  if (process.platform === 'darwin') {
    player = { bin: 'afplay', args: (p) => [p] }
  } else if (process.platform === 'win32') {
    player = {
      bin: 'powershell',
      args: (p) => [
        '-NoProfile',
        '-Command',
        // PlaySync, not Play: Play() returns right away and the sound dies along with
        // the PowerShell, playing less than 1s of a 4s WAV.
        `(New-Object Media.SoundPlayer '${p.replace(/'/g, "''")}').PlaySync()`,
      ],
    }
  } else if (process.platform === 'linux') {
    // pw-play first: on distros with PipeWire and no PulseAudio compatibility
    // layer it is the only one of the four present.
    for (const bin of ['pw-play', 'paplay', 'aplay', 'ffplay']) {
      if (commandExists(bin)) {
        player = {
          bin,
          args: (p) => (bin === 'ffplay' ? ['-nodisp', '-autoexit', '-loglevel', 'quiet', p] : [p]),
        }
        break
      }
    }
  }

  playerCache = player
  return player
}

/** Path of the WAV by name (dev: app root; production: Resources/sounds). */
export function soundPath(name: string): string {
  // Normalizes the name: it accepts 'entrance' and 'entrance.wav' (callers pass
  // with or without the extension — without this existsSync failed and the sound did not play).
  const file = name.endsWith('.wav') ? name : `${name}.wav`
  return app.isPackaged
    ? path.join(process.resourcesPath, 'sounds', file)
    : path.join(app.getAppPath(), 'assets', 'sounds', file)
}

/** true when there is a player capable of playing WAV on this platform. */
export async function customSoundAvailable(): Promise<boolean> {
  return (await resolvePlayer()) !== null
}

/** Plays a WAV (fire-and-forget). Resolves `true` if the player started. */
export function playSound(name: string): Promise<boolean> {
  return new Promise((resolve) => {
    void resolvePlayer().then((player) => {
      if (!player) return logSound(`${name}: no player available`), resolve(false)
      const file = soundPath(name)
      if (!existsSync(file)) return logSound(`${name}: WAV not found at ${file}`), resolve(false)
      const child = spawn(player.bin, player.args(file), {
        stdio: 'ignore',
        windowsHide: true,
        env: playerEnv(),
      })
      child.on('error', (error) => {
        logSound(`${name}: failed to start ${player.bin} — ${error.message}`)
        resolve(false)
      })
      child.once('spawn', () => {
        logSound(`${name}: ${player.bin} started (${file})`)
        resolve(true)
      })
      child.once('exit', (code, signal) => {
        logSound(`${name}: ${player.bin} exited (code=${code} signal=${signal ?? 'none'})`)
      })
    })
  })
}
