import { app } from 'electron'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { userShellEnv } from './shell-env'

/**
 * Reprodução de sons custom (WAV) no main process.
 *
 * Sons do produto: `entrance.wav` (abertura do app) e `notification.wav`
 * (banners de notificação). Em dev os arquivos ficam em `assets/sounds` na
 * raiz do app; em produção são copiados pelo electron-builder
 * (`extraResources`) para `Resources/sounds`.
 *
 * Player por plataforma: macOS `afplay`, Windows SoundPlayer via PowerShell,
 * Linux `pw-play`/`paplay`/`aplay`/`ffplay`. Quando nenhum player está
 * disponível o chamador cai no som nativo do sistema (ver notifications.ts).
 *
 * Todos os players precisam ser SÍNCRONOS: o áudio morre junto com o processo
 * que o toca. No Windows isso significa `PlaySync()` — com `Play()`, que é
 * assíncrono, o PowerShell saía em ~0,7s e cortava o som de entrada de 4,2s.
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

/** PATH do usuário (no Linux/macOS o app de GUI herda um PATH reduzido). */
let envCache: NodeJS.ProcessEnv | undefined
function playerEnv(): NodeJS.ProcessEnv {
  envCache ??= userShellEnv()
  return envCache
}

/**
 * Procura o binário nos diretórios do PATH lendo o disco.
 *
 * Antes isto chamava `which`, o que fazia a detecção inteira depender de um
 * utilitário externo: numa imagem enxuta sem ele, NENHUM player era achado e
 * o Linux ficava mudo. Ler o PATH não depende de nada.
 */
function existeComando(cmd: string): boolean {
  const dirs = (playerEnv().PATH ?? '').split(path.delimiter).filter(Boolean)
  for (const dir of dirs) {
    const alvo = path.join(dir, cmd)
    try {
      if (statSync(alvo).isFile()) return true
    } catch {
      // caminho inexistente ou sem permissão — segue para o próximo
    }
  }
  return false
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
        // PlaySync, não Play: Play() retorna na hora e o som morre junto com
        // o PowerShell, tocando menos de 1s de um WAV de 4s.
        `(New-Object Media.SoundPlayer '${p.replace(/'/g, "''")}').PlaySync()`,
      ],
    }
  } else if (process.platform === 'linux') {
    // pw-play primeiro: em distros com PipeWire sem a camada de compat do
    // PulseAudio ele é o único presente dos quatro.
    for (const bin of ['pw-play', 'paplay', 'aplay', 'ffplay']) {
      if (existeComando(bin)) {
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
      const child = spawn(player.bin, player.args(caminho), {
        stdio: 'ignore',
        windowsHide: true,
        env: playerEnv(),
      })
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
