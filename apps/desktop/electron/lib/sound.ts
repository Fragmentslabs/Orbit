import { app } from 'electron'
import path from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync } from 'node:fs'

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

/** Log de diagnóstico de som (arquivo pequeno, só eventos de playback). */
export function logSom(msg: string): void {
  try {
    const dir = app.getPath('logs')
    mkdirSync(dir, { recursive: true })
    appendFileSync(path.join(dir, 'sound.log'), `[${new Date().toISOString()}] ${msg}\n`)
  } catch {
    // log é best-effort; nunca pode derrubar o playback
  }
}

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
  // Normaliza o nome: aceita 'entrance' e 'entrance.wav' (os chamadores passam
  // com ou sem extensão — sem isso o existsSync falhava e o som não tocava).
  const arquivo = nome.endsWith('.wav') ? nome : `${nome}.wav`
  return app.isPackaged
    ? path.join(process.resourcesPath, 'sounds', arquivo)
    : path.join(app.getAppPath(), 'assets', 'sounds', arquivo)
}

/** true quando há um player capaz de tocar WAV nesta plataforma. */
export async function somCustomDisponivel(): Promise<boolean> {
  return (await resolverPlayer()) !== null
}

/** Toca um WAV (fire-and-forget). Resolve `true` se o player iniciou. */
export function tocarSom(nome: string): Promise<boolean> {
  return new Promise((resolve) => {
    void resolverPlayer().then((player) => {
      if (!player) return logSom(`${nome}: sem player disponível`), resolve(false)
      const caminho = caminhoSom(nome)
      if (!existsSync(caminho)) return logSom(`${nome}: WAV não encontrado em ${caminho}`), resolve(false)
      const child = spawn(player.bin, player.args(caminho), { stdio: 'ignore', windowsHide: true })
      child.on('error', (erro) => {
        logSom(`${nome}: falha ao iniciar ${player.bin} — ${erro.message}`)
        resolve(false)
      })
      child.once('spawn', () => {
        logSom(`${nome}: ${player.bin} iniciado (${caminho})`)
        resolve(true)
      })
      child.once('exit', (code, signal) => {
        logSom(`${nome}: ${player.bin} saiu (code=${code} signal=${signal ?? 'nenhum'})`)
      })
    })
  })
}
