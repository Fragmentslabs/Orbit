import { spawn } from 'node:child_process'
import path from 'node:path'
import { userShellEnv } from '../shell-env'
import { resolveFfmpeg } from '../video/ffmpeg'
import { refreshYtdlp, requireYtdlp, type YtdlpRefreshResult } from './binary'

/**
 * Execution of yt-dlp: the arguments the tools build and the spawn that runs them.
 *
 * Two rules that apply to everything here:
 *
 *  - `--ignore-config`: the result cannot depend on the user's
 *    ~/.config/yt-dlp/config (an `-o` or `--exec` in there would change the
 *    behavior of the tool without anyone seeing it). Whoever needs a cookie or
 *    another option asks for it through the tool.
 *  - `--ffmpeg-location`: the ffmpeg that ships with the app is the one that
 *    separates the video from the audio and extracts the audio track. Without
 *    pointing at it, yt-dlp would look for an ffmpeg on the PATH that may not
 *    exist.
 */

export interface YtdlpRunResult {
  code: number
  stdout: string
  stderr: string
  /** What happened when the error looked like an old binary (see looksStale). */
  refresh?: YtdlpRefreshResult
}

/** stdout ceiling: a `-J` of a giant playlist cannot become app memory. */
const MAX_STDOUT = 64 * 1024 * 1024

export function baseYtdlpArgs(): string[] {
  const args = ['--ignore-config', '--no-warnings', '--no-colors', '--no-progress']
  const ffmpeg = resolveFfmpeg()
  if (ffmpeg) args.push('--ffmpeg-location', path.dirname(ffmpeg.ffmpeg))
  return args
}

/**
 * Errors that usually mean an old binary: the player extraction changed, the
 * signature (nsig) changed, or the site started requiring the new version of the
 * challenge. Those are the ones the next release fixes.
 *
 * The ones no update solves stay out — private video, removed, regional block, 429
 * rate limit, nonexistent format. Downloading 35 MB to fail the same way is worse
 * than returning the original error.
 */
const STALE_PATTERNS = [
  /unable to extract/i,
  /\bnsig\b/i,
  /unable to download video data/i,
  /failed to parse (?:json|player|initial)/i,
  /player response/i,
  /signature (?:extraction )?failed/i,
  /no video formats found/i,
  /confirm you.{0,4}re not a bot/i,
  /http error 403/i,
]

export function looksStale(res: { stdout: string; stderr: string }): boolean {
  const text = `${res.stderr}\n${res.stdout}`
  return STALE_PATTERNS.some((pattern) => pattern.test(text))
}

export interface YtdlpRunOptions {
  signal?: AbortSignal
  cwd?: string
  /** Default: true — an error that looks like an old binary updates and repeats once. */
  retryOnStale?: boolean
}

/**
 * Runs yt-dlp and returns the RAW result — exit code included, without throwing on a
 * non-zero code: an error in the middle of a playlist still leaves finished files,
 * and the tool is the one that decides what to do.
 *
 * If the failure looks like an old extractor, it updates the binary and repeats
 * ONCE. The retry does not hide the error: the result carries what happened in the
 * update, and that is what the final message tells (ytdlpError).
 */
export async function runYtdlp(args: string[], opts: YtdlpRunOptions = {}): Promise<YtdlpRunResult> {
  const first = await runYtdlpOnce(args, opts)
  if (first.code === 0 || opts.retryOnStale === false || !looksStale(first)) return first

  let refresh: YtdlpRefreshResult
  try {
    refresh = await refreshYtdlp({ signal: opts.signal })
  } catch (error) {
    if (opts.signal?.aborted) throw new Error('cancelled')
    refresh = { updated: false, from: null, to: null, reason: (error as Error).message }
  }
  if (!refresh.updated) return { ...first, refresh }
  return { ...(await runYtdlpOnce(args, opts)), refresh }
}

function runYtdlpOnce(args: string[], opts: YtdlpRunOptions = {}): Promise<YtdlpRunResult> {
  const { bin } = requireYtdlp()
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, [...baseYtdlpArgs(), ...args], {
      cwd: opts.cwd,
      env: userShellEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const out: Buffer[] = []
    let outBytes = 0
    let err = ''
    proc.stdout.on('data', (chunk: Buffer) => {
      outBytes += chunk.length
      if (outBytes > MAX_STDOUT) {
        proc.kill('SIGKILL')
        return
      }
      out.push(chunk)
    })
    proc.stderr.on('data', (chunk: Buffer) => {
      err += chunk.toString()
      if (err.length > 400_000) err = err.slice(-200_000)
    })
    const onAbort = () => proc.kill('SIGKILL')
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    proc.on('error', (error) => {
      opts.signal?.removeEventListener('abort', onAbort)
      reject(error)
    })
    proc.on('close', (code) => {
      opts.signal?.removeEventListener('abort', onAbort)
      if (opts.signal?.aborted) return reject(new Error('cancelled'))
      if (outBytes > MAX_STDOUT) return reject(new Error('yt-dlp produced more output than Orbit can read (playlist too large?)'))
      resolve({ code: code ?? 1, stdout: Buffer.concat(out).toString('utf8'), stderr: err })
    })
  })
}

/** The error lines of yt-dlp, which is where it says what actually happened. */
export function ytdlpError(res: YtdlpRunResult): string {
  const lines = res.stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  const errors = lines.filter((line) => /^ERROR:/i.test(line)).map((line) => line.replace(/^ERROR:\s*/i, ''))
  const text = (errors.length ? errors.slice(-8) : lines.slice(-6)).join('\n') || `yt-dlp exited with code ${res.code}`
  if (!res.refresh) return text

  // The error looked like an old binary. Saying what was done keeps the agent from asking
  // the user for an update that already happened (or that is not possible).
  const note = res.refresh.updated
    ? `yt-dlp was updated (${res.refresh.from ?? '?'} → ${res.refresh.to ?? '?'}) and the command failed again — this is not a stale binary.`
    : `yt-dlp was not updated: ${res.refresh.reason ?? 'no reason given'}.`
  return `${text}\n(${note})`
}

// ---------------------------------------------------------------------------
// Arguments (pure — tested without running anything)
// ---------------------------------------------------------------------------

export type VideoQuality = 'best' | '2160' | '1440' | '1080' | '720' | '480' | '360'
export type AudioFormat = 'best' | 'mp3' | 'm4a' | 'opus' | 'flac' | 'wav'
export type CookieBrowser = 'chrome' | 'safari' | 'firefox' | 'edge' | 'brave' | 'chromium' | 'opera' | 'vivaldi'

export interface DownloadPlan {
  url: string
  kind: 'video' | 'audio'
  /** Video only. */
  quality?: VideoQuality
  /** Audio only: the final container (best keeps the original). */
  audioFormat?: AudioFormat
  playlist?: boolean
  playlistItems?: string
  maxBytes?: number
  cookiesFromBrowser?: CookieBrowser
  /** Full path of the output template (already inside the temporary folder). */
  output: string
}

/**
 * Video format selector.
 *
 * `-f` does two things `-S` alone does not: it enforces the resolution CEILING
 * (`res:1080` only sorts) and prefers mp4 video + m4a audio. That preference is
 * not a whim: with opus/webm audio yt-dlp is forced to merge into mkv, which the
 * response player does not open. `-S` breaks the tie by the requested resolution
 * and prefers h264 — the codec that plays on any device.
 */
export function videoFormatArgs(quality: VideoQuality = '1080'): string[] {
  if (quality === 'best') return ['-f', 'bv*[ext=mp4]+ba[ext=m4a]/bv*+ba/b', '-S', 'res,vcodec:h264']
  const cap = `[height<=${quality}]`
  const filter = [
    `bv*[ext=mp4]${cap}+ba[ext=m4a]`,
    `bv*${cap}+ba[ext=m4a]`,
    `bv*${cap}+ba/b${cap}`,
    `b${cap}`,
    'b',
  ].join('/')
  return ['-f', filter, '-S', `res:${quality},vcodec:h264`]
}

export function buildDownloadArgs(plan: DownloadPlan): string[] {
  const args: string[] = [plan.url, '-o', plan.output, '--windows-filenames', '--trim-filenames', '150']
  args.push(plan.playlist ? '--yes-playlist' : '--no-playlist')
  if (plan.playlist && plan.playlistItems) args.push('-I', plan.playlistItems)
  if (plan.cookiesFromBrowser) args.push('--cookies-from-browser', plan.cookiesFromBrowser)
  if (plan.maxBytes && plan.maxBytes > 0) args.push('--max-filesize', String(Math.round(plan.maxBytes)))

  if (plan.kind === 'audio') {
    args.push('-f', 'ba/b', '-x', '--audio-format', plan.audioFormat ?? 'best', '--embed-metadata')
    // Quality only exists for the re-encoded formats; in `best` there is nothing
    // to tune and the option is ignored.
    if ((plan.audioFormat ?? 'best') !== 'best') args.push('--audio-quality', '0')
    return args
  }
  args.push(...videoFormatArgs(plan.quality), '--merge-output-format', 'mp4/mkv')
  return args
}

/** Name template: readable title + id, so two videos with the same name do not collide. */
export function nameTemplate(playlist: boolean): string {
  return playlist ? '%(playlist_index)03d - %(title).100B [%(id)s].%(ext)s' : '%(title).120B [%(id)s].%(ext)s'
}

export function infoArgs(input: { url: string; playlist?: boolean; cookiesFromBrowser?: CookieBrowser }): string[] {
  const args = ['-J', input.url]
  // `--flat-playlist` counts and lists without opening each item (a playlist of 500
  // videos would take minutes if it opened them one by one).
  args.push(input.playlist ? '--yes-playlist' : '--no-playlist')
  if (input.playlist) args.push('--flat-playlist', '--playlist-end', '50')
  if (input.cookiesFromBrowser) args.push('--cookies-from-browser', input.cookiesFromBrowser)
  return args
}

/**
 * The languages as the site wrote them, without a wildcard. The `.*` that would catch
 * pt-BR and pt-PT at once is a trap: YouTube offers dozens of automatic translations
 * and yt-dlp tries to download ALL of them — slow, and the server answers 429.
 * matchLanguage is the one that decides the exact variant, from the info JSON.
 */
export function subtitleLangPattern(languages: string[]): string {
  const seen = new Set<string>()
  const parts: string[] = []
  for (const raw of languages) {
    const lang = raw.trim()
    if (!lang) continue
    const key = lang.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    parts.push(lang)
  }
  return parts.join(',')
}

export function subtitleArgs(input: {
  url: string
  languages: string[]
  output: string
  cookiesFromBrowser?: CookieBrowser
}): string[] {
  const args = [
    input.url,
    '--skip-download',
    '--write-subs',
    '--write-auto-subs',
    '--sub-langs',
    subtitleLangPattern(input.languages),
    // json3 brings word by word (YouTube); vtt/srt serve the rest.
    '--sub-format',
    'json3/vtt/srt/srv/best',
    '-o',
    input.output,
    '--no-playlist',
    '--windows-filenames',
  ]
  if (input.cookiesFromBrowser) args.push('--cookies-from-browser', input.cookiesFromBrowser)
  return args
}
