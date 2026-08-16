import { app } from 'electron'
import path from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'

/**
 * Reprodução de sons custom (WAV) no main process.
 *
 * Sons do produto: `entrance.wav` (abertura do app) e `notification.wav`
 * (banners de notificação). Em dev os arquivos ficam em `assets/sounds` na
 * raiz do app; em produção são copiados pelo electron-builder
 * (`extraResources`) para `Resources/sounds`.
 *
 * Player por plataforma: macOS `afplay`, Windows SoundPlayer via PowerShell,
 * Linux `paplay`/`aplay`/`ffplay`. Quando nenhum player está disponível o
 * chamador cai no som nativo do sistema (ver notifications.ts).
 */

type Player = { bin: string; args: (caminho: string) => string[] }

let playerCache: Player | null | 'unknown' = 'unknown'

function existeComando(cmd: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('which', [cmd], (erro, stdout) => resolve(!erro && stdout.trim().length > 0))
  })
}

async function resolverPlayer(): Promise<Player | null> {
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
        `(New-Object Media.SoundPlayer '${p.replace(/'/g, "''")}').Play()`,
      ],
    }
  } else if (process.platform === 'linux') {
    for (const bin of ['paplay', 'aplay', 'ffplay']) {
      if (await existeComando(bin)) {
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

/** Caminho do WAV pelo nome (dev: raiz do app; produção: Resources/sounds). */
export function caminhoSom(nome: string): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'sounds', nome)
    : path.join(app.getAppPath(), 'assets', 'sounds', nome)
}

/** true quando há um player capaz de tocar WAV nesta plataforma. */
export async function somCustomDisponivel(): Promise<boolean> {
  return (await resolverPlayer()) !== null
}

/** Toca um WAV (fire-and-forget). Resolve `true` se o player iniciou. */
export function tocarSom(nome: string): Promise<boolean> {
  return new Promise((resolve) => {
    void resolverPlayer().then((player) => {
      if (!player) return resolve(false)
      const caminho = caminhoSom(nome)
      if (!existsSync(caminho)) return resolve(false)
      const child = spawn(player.bin, player.args(caminho), { stdio: 'ignore', windowsHide: true })
      child.on('error', () => resolve(false))
      child.once('spawn', () => resolve(true))
    })
  })
}