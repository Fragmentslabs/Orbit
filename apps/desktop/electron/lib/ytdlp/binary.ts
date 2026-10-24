import { app } from 'electron'
import { execFile } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { addBundledToolDir, userShellEnv } from '../shell-env'

/**
 * O yt-dlp que as tools de download usam.
 *
 * O binário NÃO viaja com o app, e isso é decisão, não preguiça: o yt-dlp
 * muda toda semana para acompanhar os sites, e um binário empacotado num
 * release envelhece no disco do usuário sem ele perceber. A procura segue a
 * ideia do ffmpeg (video/ffmpeg.ts), com uma fonte a mais:
 *
 *   1. ORBIT_YTDLP_PATH — um caminho explícito (arquivo ou pasta), para quem
 *      testa ou empacota por fora;
 *   2. a cópia gerenciada pelo Orbit (userData/orbit-data/bin), baixada pelo
 *      ytdlp_install do release oficial;
 *   3. o que vier com o app (resources/ytdlp), se um dia for empacotado como
 *      SEMENTE de uma instalação offline;
 *   4. o PATH do usuário (brew, pipx, ~/.local/bin).
 *
 * A cópia gerenciada vem antes da semente e do PATH de propósito: é a única
 * que o próprio app consegue manter atualizada (um yt-dlp de brew/pip recusa
 * `-U` e só atualiza pelo gerenciador dele), e é para ela que o refreshYtdlp
 * empurra uma semente empacotada e desatualizada.
 */

const EXE = process.platform === 'win32' ? '.exe' : ''
const RELEASE = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download'

export type YtdlpSource = 'env' | 'bundled' | 'managed' | 'path'

export interface YtdlpPaths {
  bin: string
  source: YtdlpSource
}

/** Nome do arquivo oficial do release para a plataforma — universal no macOS. */
export function assetName(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string | null {
  if (platform === 'darwin') return 'yt-dlp_macos'
  if (platform === 'win32') {
    if (arch === 'arm64') return 'yt-dlp_arm64.exe'
    if (arch === 'ia32') return 'yt-dlp_x86.exe'
    return 'yt-dlp.exe'
  }
  if (platform === 'linux') {
    if (arch === 'arm64') return 'yt-dlp_linux_aarch64'
    if (arch === 'arm') return 'yt-dlp_linux_armv7l'
    return 'yt-dlp_linux'
  }
  return null
}

/** Pasta da cópia gerenciada pelo app (a que o ytdlp_install escreve). */
export function managedDir(): string {
  return path.join(app.getPath('userData'), 'orbit-data', 'bin')
}

function managedBin(): string | null {
  if (!app) return null
  const bin = path.join(managedDir(), `yt-dlp${EXE}`)
  return fs.existsSync(bin) ? bin : null
}

function bundledDir(): string | null {
  if (!app) return null
  if (app.isPackaged) return path.join(process.resourcesPath, 'ytdlp')
  const appPath = typeof app.getAppPath === 'function' ? app.getAppPath() : null
  if (!appPath) return null
  return path.join(appPath, 'resources', 'ytdlp', `${process.platform}-${process.arch}`)
}

function fileIn(dir: string | null | undefined): string | null {
  if (!dir) return null
  const candidate = path.join(dir, `yt-dlp${EXE}`)
  return fs.existsSync(candidate) ? candidate : null
}

function fromEnv(): string | null {
  const raw = process.env.ORBIT_YTDLP_PATH?.trim()
  if (!raw) return null
  try {
    const stat = fs.statSync(raw)
    if (stat.isDirectory()) return fileIn(raw)
    return stat.isFile() ? raw : null
  } catch {
    return null
  }
}

function findInPath(name: string): string | null {
  const env = userShellEnv()
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'
  for (const dir of (env[key] ?? '').split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, name + EXE)
    try {
      if (fs.statSync(candidate).isFile()) return candidate
    } catch {
      // segue procurando
    }
  }
  return null
}

let cached: YtdlpPaths | null | undefined

/** Esquece a procura em cache — depois de instalar/atualizar o binário. */
export function invalidateYtdlpCache(): void {
  cached = undefined
}

export function resolveYtdlp(): YtdlpPaths | null {
  if (cached !== undefined) return cached
  const env = fromEnv()
  if (env) cached = { bin: env, source: 'env' }
  else {
    const managed = managedBin()
    if (managed) cached = { bin: managed, source: 'managed' }
    else {
      const bundled = fileIn(bundledDir())
      if (bundled) cached = { bin: bundled, source: 'bundled' }
      else {
        const fromPath = findInPath('yt-dlp')
        cached = fromPath ? { bin: fromPath, source: 'path' } : null
      }
    }
  }
  return cached
}

/**
 * Chamado na partida: a cópia que o app já baixou entra no PATH dos shells do
 * agente, para o `bash` achar `yt-dlp` como acha o ffmpeg.
 */
export function registerYtdlpOnPath(): void {
  const found = resolveYtdlp()
  if (found && found.source !== 'path') addBundledToolDir(path.dirname(found.bin))
}

export function ytdlpMissingMessage(): string {
  return (
    'yt-dlp is not installed. Call ytdlp_install to download the official standalone binary into Orbit\'s storage ' +
    '(no admin rights, nothing installed system-wide), or install it yourself — brew install yt-dlp, pipx install yt-dlp — ' +
    'and the tools pick it up from PATH.'
  )
}

export function requireYtdlp(): YtdlpPaths {
  const found = resolveYtdlp()
  if (!found) throw new Error(ytdlpMissingMessage())
  return found
}

let versionCache: { bin: string; version: string | null; at: number } | null = null
const VERSION_TTL = 10 * 60 * 1000

/**
 * Versão do binário (a primeira execução de um binário PyInstaller é lenta).
 * Cacheada porque o `ytdlp_info` pede a versão em toda chamada; `fresh` é para
 * quem acabou de instalar/atualizar e precisa do valor novo.
 */
export function ytdlpVersion(bin: string, opts: { fresh?: boolean } = {}): Promise<string | null> {
  if (!opts.fresh && versionCache && versionCache.bin === bin && Date.now() - versionCache.at < VERSION_TTL) {
    return Promise.resolve(versionCache.version)
  }
  return new Promise((resolve) => {
    execFile(bin, ['--version'], { env: userShellEnv(), timeout: 30_000, windowsHide: true }, (err, stdout) => {
      const version = err ? null : stdout.trim() || null
      versionCache = { bin, version, at: Date.now() }
      resolve(version)
    })
  })
}

/** Dias desde a data que o yt-dlp usa como versão (`2026.10.24`). */
export function versionAgeDays(version: string | null): number | null {
  const parsed = /^(\d{4})\.(\d{2})\.(\d{2})/.exec(version ?? '')
  if (!parsed) return null
  const then = Date.UTC(Number(parsed[1]), Number(parsed[2]) - 1, Number(parsed[3]))
  const days = Math.floor((Date.now() - then) / 86_400_000)
  return Number.isFinite(days) ? Math.max(0, days) : null
}

/** Linha que o `ytdlp_info` devolve junto do conteúdo: qual binário respondeu. */
export function describeBinary(found: YtdlpPaths, version: string | null): string {
  const where =
    found.source === 'managed'
      ? 'managed copy'
      : found.source === 'env'
        ? 'ORBIT_YTDLP_PATH'
        : found.source === 'bundled'
          ? 'bundled with the app'
          : 'from PATH'
  const age = versionAgeDays(version)
  const stamp = version ?? 'unknown version'
  return age === null ? `yt-dlp ${stamp} (${where})` : `yt-dlp ${stamp} (${where}, ${age} days old)`
}

export interface YtdlpRefreshResult {
  updated: boolean
  from: string | null
  to: string | null
  /** Por que não deu para atualizar (quando `updated` é false). */
  reason?: string
}

let lastRefreshAt = 0
const REFRESH_THROTTLE_MS = 15 * 60 * 1000

/** Roda um comando do binário sem se importar com o resultado (o `-U`). */
function runQuiet(bin: string, args: string[], signal?: AbortSignal): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      bin,
      args,
      { env: userShellEnv(), timeout: 120_000, windowsHide: true, signal },
      (err, stdout, stderr) => {
        const text = `${stdout ?? ''}${stderr ?? ''}`.trim()
        resolve(text || (err ? err.message : ''))
      },
    )
  })
}

/**
 * Tenta trazer o yt-dlp para o release atual — sem tocar no que é do usuário.
 *
 * Quem decide chamar é o `runYtdlp`, quando uma execução falha com erro de
 * extractor (o sintoma clássico de binário velho). O throttle existe para uma
 * sequência de falhas (playlist, site fora do ar) não virar uma sequência de
 * downloads de 35 MB.
 *
 * - cópia gerenciada (ou semente empacotada): baixa o release de agora;
 * - cópia do PATH: só o binário standalone aceita `-U`; brew/pip respondem
 *   que quem atualiza é o gerenciador deles, e isso volta como `reason`;
 * - ORBIT_YTDLP_PATH: caminho explícito, não se mexe.
 */
export async function refreshYtdlp(opts: { signal?: AbortSignal; force?: boolean } = {}): Promise<YtdlpRefreshResult> {
  const found = resolveYtdlp()
  if (!found) throw new Error(ytdlpMissingMessage())
  if (found.source === 'env') {
    return { updated: false, from: null, to: null, reason: 'ORBIT_YTDLP_PATH is set — Orbit will not touch that file' }
  }
  if (!opts.force && Date.now() - lastRefreshAt < REFRESH_THROTTLE_MS) {
    return { updated: false, from: null, to: null, reason: 'yt-dlp was already refreshed in the last 15 minutes' }
  }
  lastRefreshAt = Date.now()
  const before = await ytdlpVersion(found.bin, { fresh: true })

  if (found.source === 'managed' || found.source === 'bundled') {
    const installed = await installYtdlp({ signal: opts.signal })
    return { updated: true, from: before, to: installed.version }
  }

  const output = await runQuiet(found.bin, ['-U'], opts.signal)
  const after = await ytdlpVersion(found.bin, { fresh: true })
  if (after && after !== before) return { updated: true, from: before, to: after }
  return {
    updated: false,
    from: before,
    to: after,
    reason: /brew|pip|package|managed/i.test(output)
      ? 'the yt-dlp found in PATH is managed by brew/pip and refuses to update itself — update it with that tool'
      : `the yt-dlp found in PATH did not update itself${output ? `: ${output.split('\n').pop()}` : ''}`,
  }
}

export interface YtdlpInstallResult {
  bin: string
  version: string | null
  asset: string
  checksum: 'verified' | 'unavailable'
}

/**
 * Baixa (ou atualiza) o binário oficial do yt-dlp para a pasta do app.
 *
 * O download é verificado contra o SHA2-256SUMS do MESMO release; se esse
 * arquivo não vier, a instalação continua (é HTTPS do GitHub) mas o resultado
 * diz que o checksum não foi conferido — o chamador repassa isso.
 *
 * Não roda no build do Mac App Store: o sandbox não permite executar um
 * binário baixado, e a falha precisa ser explícita em vez de um EPERM seco.
 */
export async function installYtdlp(opts: { signal?: AbortSignal } = {}): Promise<YtdlpInstallResult> {
  if (process.mas) {
    throw new Error(
      'the Mac App Store build is sandboxed and cannot execute a downloaded binary — use a build from orbit.fragmentslabs.com',
    )
  }
  const asset = assetName()
  if (!asset) throw new Error(`there is no official yt-dlp binary for ${process.platform}-${process.arch}`)

  const dir = managedDir()
  await fsp.mkdir(dir, { recursive: true })
  const target = path.join(dir, `yt-dlp${EXE}`)
  const tmp = path.join(dir, `.yt-dlp-${randomBytes(4).toString('hex')}.part`)

  const download = async (url: string, file: string): Promise<void> => {
    const res = await fetch(url, { signal: opts.signal, redirect: 'follow' })
    if (!res.ok || !res.body) throw new Error(`download failed: ${res.status} ${res.statusText} (${url})`)
    const handle = await fsp.open(file, 'w')
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        await handle.write(chunk)
      }
    } finally {
      await handle.close()
    }
  }

  let checksum: 'verified' | 'unavailable' = 'unavailable'
  try {
    await download(`${RELEASE}/${asset}`, tmp)

    try {
      const res = await fetch(`${RELEASE}/SHA2-256SUMS`, { signal: opts.signal, redirect: 'follow' })
      if (res.ok) {
        const sums = await res.text()
        const expected = sums
          .split('\n')
          .map((line) => line.trim().split(/\s+/))
          .find(([, name]) => name === asset)?.[0]
        if (expected) {
          const digest = createHash('sha256').update(await fsp.readFile(tmp)).digest('hex')
          if (digest !== expected.toLowerCase()) {
            throw new Error(`the downloaded binary does not match the official checksum (${asset}) — nothing was installed`)
          }
          checksum = 'verified'
        }
      }
    } catch (error) {
      // Checksum divergente é falha de segurança: não instala. Já a
      // indisponibilidade do arquivo de somas só deixa o resultado honesto.
      if (error instanceof Error && /checksum/.test(error.message)) throw error
    }

    if (process.platform !== 'win32') await fsp.chmod(tmp, 0o755)
    await fsp.rename(tmp, target)
  } catch (error) {
    await fsp.rm(tmp, { force: true })
    throw error
  }

  invalidateYtdlpCache()
  addBundledToolDir(dir)
  // O caminho gerenciado é sempre o mesmo: sem esquecer o cache, a versão
  // devolvida seria a do binário ANTERIOR que acabou de ser substituído.
  const version = await ytdlpVersion(target, { fresh: true })
  if (!version) throw new Error(`yt-dlp was downloaded to ${target} but does not run — try again, or install it with brew/pipx`)
  return { bin: target, version, asset, checksum }
}
