import { spawn } from 'node:child_process'
import path from 'node:path'
import { userShellEnv } from '../shell-env'
import { resolveFfmpeg } from '../video/ffmpeg'
import { refreshYtdlp, requireYtdlp, type YtdlpRefreshResult } from './binary'

/**
 * Execução do yt-dlp: os argumentos que as tools montam e o spawn que os roda.
 *
 * Duas regras que valem para tudo aqui:
 *
 *  - `--ignore-config`: o resultado não pode depender do
 *    ~/.config/yt-dlp/config do usuário (um `-o` ou `--exec` lá dentro
 *    mudaria o comportamento da tool sem ninguém ver). Quem precisa de cookie
 *    ou de outra opção pede pela tool.
 *  - `--ffmpeg-location`: o ffmpeg que vem com o app é o que separa o vídeo
 *    do áudio e extrai a faixa de áudio. Sem apontar para ele, o yt-dlp
 *    procuraria um ffmpeg no PATH que pode não existir.
 */

export interface YtdlpRunResult {
  code: number
  stdout: string
  stderr: string
  /** O que aconteceu quando o erro parecia binário velho (ver looksStale). */
  refresh?: YtdlpRefreshResult
}

/** Teto do stdout: um `-J` de playlist gigante não pode virar memória do app. */
const MAX_STDOUT = 64 * 1024 * 1024

export function baseYtdlpArgs(): string[] {
  const args = ['--ignore-config', '--no-warnings', '--no-colors', '--no-progress']
  const ffmpeg = resolveFfmpeg()
  if (ffmpeg) args.push('--ffmpeg-location', path.dirname(ffmpeg.ffmpeg))
  return args
}

/**
 * Erros que costumam ser sinônimo de binário velho: a extração do player
 * mudou, a assinatura (nsig) mudou, ou o site passou a exigir a versão nova do
 * desafio. São os que o release seguinte conserta.
 *
 * Ficam de fora os que atualização nenhuma resolve — vídeo privado, removido,
 * bloqueio regional, 429 de rate limit, formato inexistente. Baixar 35 MB para
 * falhar igual é pior que devolver o erro original.
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
  /** Default: true — um erro com cara de binário velho atualiza e repete uma vez. */
  retryOnStale?: boolean
}

/**
 * Roda o yt-dlp e devolve o resultado CRU — código de saída incluído, sem
 * lançar por código diferente de zero: um erro no meio de uma playlist ainda
 * deixa arquivos prontos, e quem decide o que fazer é a tool.
 *
 * Se a falha tem cara de extractor velho, atualiza o binário e repete UMA vez.
 * O retry não esconde o erro: o resultado carrega o que aconteceu na
 * atualização, e é isso que a mensagem final conta (ytdlpError).
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

/** As linhas de erro do yt-dlp, que é onde ele diz o que de fato aconteceu. */
export function ytdlpError(res: YtdlpRunResult): string {
  const lines = res.stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  const errors = lines.filter((line) => /^ERROR:/i.test(line)).map((line) => line.replace(/^ERROR:\s*/i, ''))
  const text = (errors.length ? errors.slice(-8) : lines.slice(-6)).join('\n') || `yt-dlp exited with code ${res.code}`
  if (!res.refresh) return text

  // O erro parecia binário velho. Dizer o que foi feito evita que o agente peça
  // ao usuário uma atualização que já aconteceu (ou que não é possível).
  const note = res.refresh.updated
    ? `yt-dlp was updated (${res.refresh.from ?? '?'} → ${res.refresh.to ?? '?'}) and the command failed again — this is not a stale binary.`
    : `yt-dlp was not updated: ${res.refresh.reason ?? 'no reason given'}.`
  return `${text}\n(${note})`
}

// ---------------------------------------------------------------------------
// Argumentos (puros — testados sem rodar nada)
// ---------------------------------------------------------------------------

export type VideoQuality = 'best' | '2160' | '1440' | '1080' | '720' | '480' | '360'
export type AudioFormat = 'best' | 'mp3' | 'm4a' | 'opus' | 'flac' | 'wav'
export type CookieBrowser = 'chrome' | 'safari' | 'firefox' | 'edge' | 'brave' | 'chromium' | 'opera' | 'vivaldi'

export interface DownloadPlan {
  url: string
  kind: 'video' | 'audio'
  /** Só para vídeo. */
  quality?: VideoQuality
  /** Só para áudio: o contêiner final (best mantém o original). */
  audioFormat?: AudioFormat
  playlist?: boolean
  playlistItems?: string
  maxBytes?: number
  cookiesFromBrowser?: CookieBrowser
  /** Caminho completo do template de saída (já dentro da pasta temporária). */
  output: string
}

/**
 * Seletor de formato do vídeo.
 *
 * `-f` faz duas coisas que `-S` sozinho não faz: impõe o TETO de resolução
 * (`res:1080` só ordena) e prefere vídeo mp4 + áudio m4a. Essa preferência não
 * é capricho: com o áudio opus/webm o yt-dlp é obrigado a mesclar em mkv, que o
 * player da resposta não abre. `-S` desempata pela resolução pedida e prefere
 * h264 — o codec que toca em qualquer aparelho.
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
    // Qualidade só existe para os formatos reencodados; no `best` não há o que
    // regular e a opção é ignorada.
    if ((plan.audioFormat ?? 'best') !== 'best') args.push('--audio-quality', '0')
    return args
  }
  args.push(...videoFormatArgs(plan.quality), '--merge-output-format', 'mp4/mkv')
  return args
}

/** Template de nome: título legível + id, para dois vídeos homônimos não colidirem. */
export function nameTemplate(playlist: boolean): string {
  return playlist ? '%(playlist_index)03d - %(title).100B [%(id)s].%(ext)s' : '%(title).120B [%(id)s].%(ext)s'
}

export function infoArgs(input: { url: string; playlist?: boolean; cookiesFromBrowser?: CookieBrowser }): string[] {
  const args = ['-J', input.url]
  // `--flat-playlist` conta e lista sem abrir cada item (uma playlist de 500
  // vídeos responderia em minutos se abrisse um por um).
  args.push(input.playlist ? '--yes-playlist' : '--no-playlist')
  if (input.playlist) args.push('--flat-playlist', '--playlist-end', '50')
  if (input.cookiesFromBrowser) args.push('--cookies-from-browser', input.cookiesFromBrowser)
  return args
}

/**
 * Os idiomas como o site os escreveu, sem curinga. O `.*` que pegaria pt-BR e
 * pt-PT de uma vez é uma armadilha: o YouTube oferece dezenas de traduções
 * automáticas e o yt-dlp tenta baixar TODAS — lento, e o servidor responde 429.
 * Quem decide a variante exata é o matchLanguage, a partir do JSON do info.
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
    // json3 traz palavra por palavra (YouTube); vtt/srt atendem o resto.
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
