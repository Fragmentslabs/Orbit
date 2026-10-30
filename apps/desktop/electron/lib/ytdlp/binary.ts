import { app } from 'electron'
import { execFile } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { addBundledToolDir, userShellEnv } from '../shell-env'

/**
 * The yt-dlp that the download tools use.
 *
 * The binary does NOT travel with the app, and that is a decision, not laziness:
 * yt-dlp changes every week to keep up with the sites, and a binary packaged in a
 * release ages on the user's disk without them noticing. The search follows the
 * ffmpeg idea (video/ffmpeg.ts), with one more source:
 *
 *   1. ORBIT_YTDLP_PATH — an explicit path (file or folder), for whoever tests or
 *      packages from outside;
 *   2. the copy managed by Orbit (userData/orbit-data/bin), downloaded by
 *      ytdlp_install from the official release;
 *   3. whatever ships with the app (resources/ytdlp), if one day it is packaged as
 *      a SEED of an offline installation;
 *   4. the user's PATH (brew, pipx, ~/.local/bin).
 *
 * The managed copy comes before the seed and the PATH on purpose: it is the only
 * one the app itself can keep up to date (a yt-dlp from brew/pip refuses `-U` and
 * only updates through its own manager), and it is into it that refreshYtdlp pushes
 * a packaged seed that is out of date.
 */

const EXE = process.platform === 'win32' ? '.exe' : ''
const RELEASE = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download'

export type YtdlpSource = 'env' | 'bundled' | 'managed' | 'path'

export interface YtdlpPaths {
  bin: string
  source: YtdlpSource
}

/** Name of the official release file for the platform — universal on macOS. */
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

/** Folder of the copy managed by the app (the one ytdlp_install writes). */
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
      // keeps looking
    }
  }
  return null
}

let cached: YtdlpPaths | null | undefined

/** Forgets the cached search — after installing/updating the binary. */
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
 * Called at startup: the copy the app already downloaded enters the PATH of the
 * agent's shells, so `bash` finds `yt-dlp` the way it finds ffmpeg.
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
 * Version of the binary (the first run of a PyInstaller binary is slow). Cached
 * because `ytdlp_info` asks for the version on every call; `fresh` is for whoever
 * just installed/updated and needs the new value.
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

/** Days since the date yt-dlp uses as version (`2026.10.24`). */
export function versionAgeDays(version: string | null): number | null {
  const parsed = /^(\d{4})\.(\d{2})\.(\d{2})/.exec(version ?? '')
  if (!parsed) return null
  const then = Date.UTC(Number(parsed[1]), Number(parsed[2]) - 1, Number(parsed[3]))
  const days = Math.floor((Date.now() - then) / 86_400_000)
  return Number.isFinite(days) ? Math.max(0, days) : null
}

/** Line that `ytdlp_info` returns along with the content: which binary answered. */
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
  /** Why it could not be updated (when `updated` is false). */
  reason?: string
}

let lastRefreshAt = 0
const REFRESH_THROTTLE_MS = 15 * 60 * 1000

/** Runs a binary command without caring about the result (the `-U`). */
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
 * Tries to bring yt-dlp to the current release — without touching what belongs to
 * the user.
 *
 * runYtdlp is the one that decides to call it, when an execution fails with an
 * extractor error (the classic symptom of an old binary). The throttle exists so that
 * a sequence of failures (playlist, site down) does not become a sequence of 35 MB
 * downloads.
 *
 * - managed copy (or packaged seed): downloads the current release;
 * - copy from the PATH: only the standalone binary accepts `-U`; brew/pip answer that
 *   their manager is the one that updates, and that comes back as `reason`;
 * - ORBIT_YTDLP_PATH: explicit path, it is not touched.
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
 * Downloads (or updates) the official yt-dlp binary into the app folder.
 *
 * The download is verified against the SHA2-256SUMS of the SAME release; if that file
 * does not come, the installation goes on (it is HTTPS from GitHub) but the result
 * says the checksum was not checked — the caller passes that on.
 *
 * It does not run in the Mac App Store build: the sandbox does not allow running a
 * downloaded binary, and the failure has to be explicit instead of a bare EPERM.
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
      // A diverging checksum is a security failure: it does not install. The
      // unavailability of the sums file only keeps the result honest.
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
  // The managed path is always the same: without forgetting the cache, the version
  // returned would be that of the PREVIOUS binary that was just replaced.
  const version = await ytdlpVersion(target, { fresh: true })
  if (!version) throw new Error(`yt-dlp was downloaded to ${target} but does not run — try again, or install it with brew/pipx`)
  return { bin: target, version, asset, checksum }
}
