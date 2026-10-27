import { app } from 'electron'
import { tool } from 'ai'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { getAppSettings } from '../app-settings'
import { AUDIO_SCHEME, audioFilePath } from '../audio-store'
import { registerAudioMedia, saveDocument } from '../media'
import { probeMedia } from '../video/ffmpeg'
import { registerVideo } from '../video/store'
import { addVideoToGallery } from '../video/video-gallery'
import { transcribeAudioPcm } from '../voice'
import { decodeAudioFile } from '../voice/decode'
import { describeBinary, installYtdlp, requireYtdlp, resolveYtdlp, ytdlpVersion } from '../ytdlp/binary'
import { bytesText, describeInfo, durationText, parseInfo } from '../ytdlp/info'
import {
  buildDownloadArgs,
  infoArgs,
  nameTemplate,
  runYtdlp,
  subtitleArgs,
  ytdlpError,
  type AudioFormat,
  type CookieBrowser,
  type VideoQuality,
  type YtdlpRunResult,
} from '../ytdlp/run'
import { cueText, matchLanguage, parseSubtitleFile, timestampedCues, type SubtitleCue } from '../ytdlp/subtitles'
import { resolveWritePath, type ToolContext } from './context'

/**
 * Mídia por LINK: baixar vídeo, extrair áudio, ler a transcrição e (com o
 * texto em mãos) resumir.
 *
 * Quem faz o trabalho pesado é o yt-dlp, que resolve milhares de sites; o que
 * este módulo acrescenta é o que ele não faz sozinho:
 *
 *  - decidir por QUAL transcrição: a legenda que o site já tem (segundos,
 *    sem modelo nenhum) antes de baixar o áudio e passar pelo motor de ditado;
 *  - entregar o resultado no lugar certo: o acervo do próprio app e a aba
 *    Mídia, ou a pasta do projeto quando o pedido diz onde salvar;
 *  - relatar números medidos (duração, tamanho, resolução, idioma da legenda),
 *    nunca o que o modelo de vídeo promete.
 *
 * Resumir NÃO é uma tool: é o que o agente faz com o texto que a transcrição
 * devolve. Uma tool "resumir" esconderia a transcrição e impediria o usuário
 * de pedir o texto; do jeito que está, pedir um resumo é chamar
 * ytdlp_transcript com deliver "context" e escrever o resumo.
 */

const SAFE_SESSION = /^[A-Za-z0-9_-]{1,80}$/
const VIDEO_EXT = new Set(['mp4', 'mkv', 'webm', 'mov', 'm4v', 'avi', 'flv', 'ts', '3gp'])
const AUDIO_EXT = new Set(['mp3', 'm4a', 'aac', 'opus', 'ogg', 'oga', 'wav', 'flac', 'weba'])
const SUB_EXT = new Set(['json3', 'vtt', 'srt', 'srv'])
const COOKIE_BROWSERS = ['chrome', 'safari', 'firefox', 'edge', 'brave', 'chromium', 'opera', 'vivaldi'] as const
/** Texto maior que isto não entra inteiro no contexto (o arquivo/documento tem tudo). */
const MAX_TRANSCRIPT_CHARS = 40_000
/** Restos de execuções interrompidas somem depois disso. */
const STALE_TMP_MS = 24 * 60 * 60 * 1000

function extOf(file: string): string {
  return path.extname(file).slice(1).toLowerCase()
}

/**
 * Onde o app guarda o que baixa. Fica no armazenamento dele, nunca na pasta do
 * projeto — e é isso que faz do arquivo um item do acervo, listável na aba.
 */
function downloadsDir(sessionId: string): string {
  if (!SAFE_SESSION.test(sessionId)) throw new Error(`invalid session id: ${sessionId}`)
  return path.join(app.getPath('userData'), 'orbit-data', 'ytdlp', sessionId)
}

function assertLink(url: string): void {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`"${url}" is not a link — pass the page URL of the video, the audio or the playlist.`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`"${url}" is not an http(s) link — pass the page URL of the video, the audio or the playlist.`)
  }
}

/**
 * Onde os arquivos caem.
 *
 * Sem `outputDir`: o acervo do próprio app (`orbit-data/ytdlp/<sessão>`), nos
 * DOIS modos. Nada é inventado dentro do projeto do usuário, e o arquivo — por
 * ser do app — entra na aba Mídia, onde a pessoa o encontra e o apaga.
 *
 * `outputDir` explícito é outra coisa: o arquivo vai para a pasta do projeto,
 * passa a ser do usuário e a galeria NÃO o lista — excluir um item de lá
 * apagaria um arquivo dele.
 */
function outputDirFor(ctx: ToolContext | null, sessionId: string, wanted?: string): string {
  const explicit = wanted?.trim()
  if (ctx && explicit) return resolveWritePath(ctx, explicit)
  return downloadsDir(sessionId)
}

async function pruneStale(outDir: string): Promise<void> {
  try {
    const entries = await fs.readdir(outDir, { withFileTypes: true })
    const cutoff = Date.now() - STALE_TMP_MS
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith('.ytdlp-')) continue
      const full = path.join(outDir, entry.name)
      try {
        const stat = await fs.stat(full)
        if (stat.mtimeMs < cutoff) await fs.rm(full, { recursive: true, force: true })
      } catch {
        // pasta sumiu no meio — nada a fazer
      }
    }
  } catch {
    // pasta de saída ainda não existe
  }
}

async function makeTmp(outDir: string): Promise<string> {
  const dir = path.join(outDir, `.ytdlp-${randomBytes(4).toString('hex')}`)
  await fs.mkdir(dir, { recursive: true })
  return dir
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file)
    return true
  } catch {
    return false
  }
}

/**
 * Tira os arquivos da pasta temporária e leva para a de saída. Nome repetido
 * ganha um sufixo curto em vez de ser sobrescrito — baixar o mesmo vídeo em
 * duas qualidades não pode apagar a primeira.
 */
async function moveOut(tmp: string, outDir: string): Promise<string[]> {
  const names = await fs.readdir(tmp)
  const moved: string[] = []
  for (const name of names.sort()) {
    if (name.endsWith('.part') || name.endsWith('.ytdl')) continue
    const source = path.join(tmp, name)
    const stat = await fs.stat(source).catch(() => null)
    if (!stat?.isFile()) continue
    let target = path.join(outDir, name)
    if (await exists(target)) {
      const ext = path.extname(name)
      const base = name.slice(0, name.length - ext.length)
      target = path.join(outDir, `${base} (${randomBytes(2).toString('hex')})${ext}`)
    }
    await fs.rename(source, target)
    moved.push(target)
  }
  return moved
}

interface FileFact {
  path: string
  name: string
  size: number
  durationMs: number
  kind: 'video' | 'audio' | 'file'
  dims: string | null
}

async function factOf(file: string): Promise<FileFact> {
  const ext = extOf(file)
  const stat = await fs.stat(file).catch(() => null)
  const fact: FileFact = { path: file, name: path.basename(file), size: stat?.size ?? 0, durationMs: 0, kind: 'file', dims: null }
  if (!VIDEO_EXT.has(ext) && !AUDIO_EXT.has(ext)) return fact
  try {
    const probe = await probeMedia(file)
    const video = probe.video[0]
    return {
      ...fact,
      durationMs: probe.durationMs,
      kind: video ? 'video' : 'audio',
      dims: video && probe.display ? `${probe.display.width}x${probe.display.height}` : null,
    }
  } catch {
    return { ...fact, kind: VIDEO_EXT.has(ext) ? 'video' : 'audio' }
  }
}

/** Caminho como o usuário o lê: relativo à pasta de trabalho no código. */
function shownPath(file: string, ctx: ToolContext | null): string {
  if (!ctx) return path.basename(file)
  const rel = path.relative(ctx.directory, file)
  // Fora das pastas de trabalho (a pasta escolhida para o download, o
  // armazenamento do app para o transcript) o relativo vira uma escada de
  // "../": ali o caminho absoluto é o que a pessoa reconhece.
  return !rel || rel.startsWith('..') || path.isAbsolute(rel) ? file : rel
}

function describeFacts(facts: FileFact[], ctx: ToolContext | null): string[] {
  return facts.map((fact) => {
    const bits = [
      bytesText(fact.size),
      fact.kind === 'video' ? fact.dims : null,
      fact.durationMs ? durationText(fact.durationMs / 1000) : null,
    ].filter((bit): bit is string => Boolean(bit))
    return `- ${shownPath(fact.path, ctx)}${bits.length ? ` (${bits.join(', ')})` : ''}`
  })
}

function noFilesError(res: YtdlpRunResult, maxBytes: number | undefined): string {
  const reason = ytdlpError(res)
  return maxBytes
    ? `${reason}\nNothing was saved — maxBytes was ${bytesText(maxBytes)}; drop the limit or pick a lower quality.`
    : `${reason}\nNothing was saved.`
}

/** Legenda baixada junto, ou áudio, viram o texto que o agente lê. */
function transcriptBody(cues: SubtitleCue[], timestamps: boolean): string {
  return timestamps ? timestampedCues(cues) : cueText(cues)
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length
}

/** Os idiomas que a legenda deve tentar: o pedido, o do ditado, e inglês. */
function requestedLanguages(language: string | undefined): string[] {
  const out: string[] = []
  if (language?.trim()) out.push(language.trim())
  const settings = getAppSettings().voice.stt.language
  if (settings) out.push(settings)
  out.push('en')
  return out
}

export function createYtdlpTools(
  scope: {
    sessionId: string
    /** Worker não mostra player nem grava na galeria — o resultado é só texto. */
    canShow: boolean
    /** Idioma da conversa, para o título do documento entregue ao usuário. */
    language?: string
  },
  ctx: ToolContext | null,
) {
  const sessionId = scope.sessionId

  /**
   * Vídeo entregue: toca na conversa e, quando o arquivo é do app, entra na aba
   * Mídia. Arquivo que a pessoa mandou salvar na pasta do projeto fica FORA da
   * aba — a galeria só lista o que ela mesma apaga.
   */
  const publishVideo = async (file: string, owned: boolean): Promise<string | null> => {
    if (!scope.canShow) return null
    if (!owned) {
      const { url } = await registerVideo(file, sessionId)
      return url
    }
    const { entry } = await addVideoToGallery({ file, name: path.basename(file), sessionId, source: 'chat' })
    return entry.videoUrl ?? null
  }

  /**
   * Áudio entregue: uma cópia na pasta de áudio do acervo (a que toca na aba).
   * Cópia de arquivo, não de bytes — um podcast de duas horas não passa pela
   * memória. Fora do acervo (arquivo do projeto) não entra na aba.
   */
  const publishAudio = async (file: string, owned: boolean): Promise<string | null> => {
    if (!scope.canShow || !owned) return null
    const id = `aud_${Date.now().toString(36)}${randomBytes(4).toString('hex')}.${extOf(file)}`
    const dest = audioFilePath(id)
    await fs.mkdir(path.dirname(dest), { recursive: true })
    await fs.copyFile(file, dest)
    const size = (await fs.stat(dest)).size
    await registerAudioMedia({
      id,
      path: dest,
      size,
      sessionId,
      name: path.basename(file, path.extname(file)),
      source: 'chat',
    })
    // A cópia do acervo é a que vale; a baixada só existia para ela.
    await fs.rm(file, { force: true })
    return `${AUDIO_SCHEME}://${id}`
  }

  /**
   * Quando o binário velho era a causa, o runYtdlp atualizou e repetiu sozinho.
   * Contar isso ao modelo evita que ele peça ao usuário uma atualização que já
   * aconteceu — e explica por que a chamada demorou.
   */
  const refreshNote = (res: YtdlpRunResult | null): string => {
    if (!res?.refresh?.updated) return ''
    return `yt-dlp was updated from ${res.refresh.from ?? 'an older release'} to ${res.refresh.to ?? 'the current release'} while answering this.`
  }

  const downloadTool = tool({
    description:
      'Downloads the video or the audio of a page (or a playlist) with yt-dlp and saves it as a real file. ' +
      'Use it for "baixa esse vídeo", "pega o áudio desse link", "em mp3", "em 720p", "baixa a playlist". ' +
      'kind "video" (default) merges the best video+audio into mp4/mkv; kind "audio" extracts the audio track (audioFormat best keeps the original codec, mp3/m4a/opus/flac/wav re-encode). ' +
      'quality caps the resolution (default 1080 — "best" keeps the largest, which can be a very large file). ' +
      'playlist: true downloads every entry (playlistItems "1-10" limits it). maxBytes makes yt-dlp skip anything above the ceiling. ' +
      'cookiesFromBrowser reads the cookies of a browser the user is logged into — only for private, age-restricted or subscriber-only pages. ' +
      "In code mode the files stay in Orbit's own storage and show up in the Media tab (pass outputDir to write them into the project instead); in chat the media appears in your reply and in the chat media. " +
      'The result reports the measured size, resolution and duration of every file — relay those numbers instead of promising qualities. ' +
      'Downloading may violate a site\'s terms or copyright; it is the user\'s call and their responsibility. ' +
      'For what is SAID in the media, call ytdlp_transcript instead of downloading the video first.',
    inputSchema: z.object({
      url: z.string().min(1).describe('The page URL of the video, the audio or the playlist.'),
      kind: z.enum(['video', 'audio']).optional().describe('"video" (default) or "audio" (extracts the audio track).'),
      quality: z
        .enum(['best', '2160', '1440', '1080', '720', '480', '360'])
        .optional()
        .describe('Maximum video height. Default 1080; "best" is the largest available (often a very large file).'),
      audioFormat: z
        .enum(['best', 'mp3', 'm4a', 'opus', 'flac', 'wav'])
        .optional()
        .describe('Audio container when kind is "audio". Default "best" (keeps the source codec, no re-encode); the others re-encode.'),
      playlist: z.boolean().optional().describe('Download the whole playlist. Off by default (a link with a list= downloads just the video).'),
      playlistItems: z.string().optional().describe('Which entries, like "1-10" or "1,3,5". Only with playlist.'),
      maxBytes: z.number().int().positive().optional().describe('Ceiling in bytes: files above it are skipped instead of downloaded.'),
      cookiesFromBrowser: z
        .enum(COOKIE_BROWSERS)
        .optional()
        .describe('Read cookies from this browser (the user must be logged in there). For private or age-restricted pages.'),
      ...(ctx
        ? {
            outputDir: z
              .string()
              .optional()
              .describe(
                "Folder for the files, relative to the working folder. Omit it and they stay in Orbit's storage, listed in the Media tab.",
              ),
          }
        : {}),
    }),
    execute: async (input, { abortSignal }) => {
      assertLink(input.url)
      const kind = input.kind ?? 'video'
      const wanted = (input as { outputDir?: string }).outputDir?.trim()
      const outDir = outputDirFor(ctx, sessionId, wanted)
      // Sem caminho declarado o arquivo é do app (entra na aba Mídia); com
      // caminho, é arquivo do projeto — toca, mas não entra na aba.
      const owned = !wanted
      await fs.mkdir(outDir, { recursive: true })
      await pruneStale(outDir)
      const tmp = await makeTmp(outDir)
      let moved: string[] = []
      let updated = ''
      try {
        const res = await runYtdlp(
          buildDownloadArgs({
            url: input.url,
            kind,
            quality: input.quality as VideoQuality | undefined,
            audioFormat: input.audioFormat as AudioFormat | undefined,
            playlist: input.playlist,
            playlistItems: input.playlistItems,
            maxBytes: input.maxBytes,
            cookiesFromBrowser: input.cookiesFromBrowser as CookieBrowser | undefined,
            output: path.join(tmp, nameTemplate(Boolean(input.playlist))),
          }),
          { signal: abortSignal, cwd: tmp },
        )
        updated = refreshNote(res)
        moved = await moveOut(tmp, outDir)
        if (!moved.length) throw new Error(noFilesError(res, input.maxBytes))
      } finally {
        await fs.rm(tmp, { recursive: true, force: true })
      }

      const media = moved.filter((file) => VIDEO_EXT.has(extOf(file)) || AUDIO_EXT.has(extOf(file)))
      const subtitleFiles = moved.filter((file) => SUB_EXT.has(extOf(file)))
      const facts = await Promise.all(media.map(factOf))
      const videos = facts.filter((fact) => fact.kind === 'video')
      const audios = facts.filter((fact) => fact.kind === 'audio')

      // Arquivo do app: TODA mídia entra na galeria (senão o que foi baixado
      // fica preso no storage, sem o usuário alcançar pela aba), e a resposta
      // mostra a primeira de cada tipo. Arquivo do projeto: só registra para
      // tocar — a galeria não lista o que não é dela.
      let videoUrl: string | null = null
      let audioUrl: string | null = null
      for (const fact of videos) {
        const url = await publishVideo(fact.path, owned)
        if (!videoUrl) videoUrl = url
      }
      for (const fact of audios) {
        const url = await publishAudio(fact.path, owned)
        if (!audioUrl) audioUrl = url
      }

      const header =
        `${kind === 'audio' ? 'Audio' : 'Video'} downloaded (${facts.length || moved.length} file(s))` +
        `${kind === 'video' && !videos.length && audios.length ? ' — the site had no video stream, only audio' : ''}.`
      const lines = [header, ...describeFacts(facts, ctx)]
      if (updated) lines.push(updated)
      if (subtitleFiles.length) {
        lines.push(`Also saved subtitles: ${subtitleFiles.map((file) => shownPath(file, ctx)).join(', ')}.`)
      }
      if (!facts.length && moved.length) lines.push(`${moved.length} file(s): ${moved.map((file) => shownPath(file, ctx)).join(', ')}.`)
      if (ctx) {
        lines.push(`Folder: ${shownPath(outDir, ctx)}.`)
        if (owned) lines.push('The media is in the Media tab of the side panel too.')
        if (facts.some((fact) => fact.size > 500 * 1024 * 1024)) {
          lines.push('Note: this is a large file — say how big it is instead of leaving the user to discover it.')
        }
      } else if (scope.canShow) {
        lines.push('The media is visible in your reply and in the chat media.')
      }

      const message = lines.join('\n')
      if (videoUrl) {
        return {
          videoUrl,
          title: videos[0].name,
          durationMs: videos[0].durationMs,
          path: videos[0].path,
          message,
        }
      }
      if (audioUrl) {
        return {
          audioUrl,
          title: path.basename(audios[0].path, path.extname(audios[0].path)),
          durationMs: audios[0].durationMs,
          message,
        }
      }
      return message
    },
  })

  return {
    /**
     * Só aparece quando falta o binário — o modelo chama quando alguma tool
     * acima responde "yt-dlp is not installed".
     */
    ytdlp_install: tool({
      description:
        'Downloads (or updates) the official standalone yt-dlp binary from the yt-dlp GitHub releases into Orbit\'s own storage, and verifies it against the release checksum. ' +
        'Call it ONLY when another ytdlp_* tool says yt-dlp is not installed, or when the user explicitly asks to update it — an extraction failure already triggers an automatic update-and-retry on its own. ' +
        'Nothing is installed system-wide and no admin rights are needed; a copy already installed with brew/pipx also works, in which case you do not need this.',
      inputSchema: z.object({}),
      execute: async (_input, { abortSignal }) => {
        const previous = resolveYtdlp()
        const result = await installYtdlp({ signal: abortSignal })
        const replaced =
          previous && previous.source === 'path'
            ? ` Orbit is now using its own managed copy instead of the one found in PATH (${previous.bin}) — delete that one if the user no longer wants it.`
            : previous && previous.source !== 'managed'
              ? ` Previous copy: ${previous.bin}.`
              : ''
        return (
          `yt-dlp ${result.version ?? ''} installed at ${result.bin} (official release asset ${result.asset}, checksum ${result.checksum}).` +
          `${replaced} The ytdlp_* tools work now.`
        )
      },
    }),

    ytdlp_info: tool({
      description:
        'Reads a page WITHOUT downloading anything: title, uploader, duration, available resolutions, whether h264 exists, subtitle languages (manual and auto-generated), chapters, live status and, for a playlist, its entries. ' +
        'Call it first when you need to choose a quality, decide whether the transcription can come from subtitles, or confirm the link is the video the user meant. ' +
        'It never downloads media, so it is cheap — but do not call it when the user already said exactly what they want and the choice is obvious.',
      inputSchema: z.object({
        url: z.string().min(1).describe('The page URL.'),
        playlist: z.boolean().optional().describe('Read the link as a playlist: list its first 50 entries instead of the single video.'),
        cookiesFromBrowser: z
          .enum(COOKIE_BROWSERS)
          .optional()
          .describe('Read cookies from this browser — for private, age-restricted or subscriber-only pages.'),
      }),
      execute: async (input, { abortSignal }) => {
        assertLink(input.url)
        const res = await runYtdlp(infoArgs({ url: input.url, playlist: input.playlist, cookiesFromBrowser: input.cookiesFromBrowser as CookieBrowser | undefined }), {
          signal: abortSignal,
        })
        if (res.code !== 0) throw new Error(ytdlpError(res))
        const text = describeInfo(parseInfo(res.stdout), { maxEntries: input.playlist ? 50 : 25 })
        // Qual binário respondeu, e há quanto tempo ele foi compilado: uma data
        // velha aqui explica uma extração que falha, antes de culpar o site.
        const found = requireYtdlp()
        const version = await ytdlpVersion(found.bin)
        const footer = [describeBinary(found, version), refreshNote(res)].filter(Boolean).join(' ')
        return `${text}\n\n${footer}`
      },
    }),

    ytdlp_download: downloadTool,

    ytdlp_transcript: tool({
      description:
        'Reads what is SAID in a video or audio page and returns the transcript — use it to summarize, quote, answer questions or turn a talk into notes. ' +
        'It first tries the subtitles the site already has (fast, no model, often word-timed); only when there are none (or mode is "audio") it downloads the audio and transcribes locally with the dictation engine — nothing leaves the machine. ' +
        'deliver "context" (default) brings the text to you (truncated at 40,000 characters; the full text is saved as a file in code mode and as a document in chat when it is longer); ' +
        'deliver "user" gives the transcript itself to the user as a chat document and stays OUT of your context — use it when they just want the transcript, then do not summarize what you did not read. ' +
        'For a summary, use deliver "context" and write the summary yourself (create_document when they want a file). ' +
        'language is the language you want the subtitles/transcription in (pt, en…); omit to use the dictation language. ' +
        'The result says where the text came from (subtitles vs local engine), the language it actually came out in and how many words — repeat that, do not guess.',
      inputSchema: z.object({
        url: z.string().min(1).describe('The page URL of the video or audio.'),
        language: z.string().optional().describe('Language code for subtitles/transcription (pt, en, es…). Omit for the dictation language.'),
        mode: z
          .enum(['auto', 'subtitles', 'audio'])
          .optional()
          .describe('"auto" (default) subtitles when available, otherwise local transcription. "subtitles" fails instead of transcribing; "audio" always transcribes the audio locally.'),
        timestamps: z.boolean().optional().describe('Prefix each passage with [m:ss].'),
        deliver: z
          .enum(['context', 'user'])
          .optional()
          .describe('"context" (default): the text comes to you. "user": it becomes a chat document for the user, outside your context.'),
        cookiesFromBrowser: z
          .enum(COOKIE_BROWSERS)
          .optional()
          .describe('Read cookies from this browser — for private, age-restricted or subscriber-only pages.'),
        ...(ctx
          ? {
              savePath: z
                .string()
                .optional()
                .describe(
                  "Where to write the transcript (Markdown), relative to the working folder. Omit it and the text stays in Orbit's own storage, never in the project.",
                ),
            }
          : {}),
      }),
      execute: async (input, { abortSignal }) => {
        assertLink(input.url)
        const mode = input.mode ?? 'auto'
        // Temporários e o texto final ficam na pasta interna da sessão: um
        // transcript não inventa pasta dentro do projeto. Para ter o arquivo no
        // repositório, o agente passa savePath — aí a escolha está declarada.
        const outDir = downloadsDir(sessionId)
        await fs.mkdir(outDir, { recursive: true })
        await pruneStale(outDir)
        const tmp = await makeTmp(outDir)
        let updated = ''
        try {
          const infoRes = await runYtdlp(
            infoArgs({ url: input.url, cookiesFromBrowser: input.cookiesFromBrowser as CookieBrowser | undefined }),
            { signal: abortSignal },
          )
          if (infoRes.code !== 0) throw new Error(ytdlpError(infoRes))
          updated = refreshNote(infoRes)
          const info = parseInfo(infoRes.stdout)
          if (info._type === 'playlist' || (!info.formats?.length && info.entries?.length)) {
            throw new Error(
              'that link is a playlist, not a single video — open the entry the user wants (or use ytdlp_download with playlist: true to fetch them all).',
            )
          }
          const title = info.title ?? 'the video'
          const durationMs = Math.round(Number(info.duration ?? 0) * 1000)
          const manual = Object.keys(info.subtitles ?? {})
          const auto = Object.keys(info.automatic_captions ?? {})
          const wanted = requestedLanguages(input.language)

          let cues: SubtitleCue[] = []
          let source: string | null = null
          let usedLanguage: string | null = null

          if (mode !== 'audio') {
            // Manual vence a automática: é a legenda que alguém revisou.
            const manualLang = matchLanguage(manual, wanted)
            const autoLang = manualLang ? null : matchLanguage(auto, wanted)
            const chosen = manualLang ?? autoLang
            if (chosen) {
              const subTmp = path.join(tmp, 'subs')
              await fs.mkdir(subTmp, { recursive: true })
              const subRes = await runYtdlp(
                subtitleArgs({
                  url: input.url,
                  languages: [chosen],
                  output: path.join(subTmp, '%(id)s.%(ext)s'),
                  cookiesFromBrowser: input.cookiesFromBrowser as CookieBrowser | undefined,
                }),
                { signal: abortSignal },
              )
              updated ||= refreshNote(subRes)
              const files = subRes.code === 0 ? await fs.readdir(subTmp) : []
              const subFile = files.find((name) => SUB_EXT.has(extOf(name)))
              if (subFile) {
                const parsed = parseSubtitleFile(await fs.readFile(path.join(subTmp, subFile), 'utf8'), subFile)
                if (parsed.length && cueText(parsed)) {
                  cues = parsed
                  usedLanguage = chosen
                  source = manualLang ? 'the video\'s own subtitles' : 'auto-generated captions'
                }
              }
            }
          }

          if (!cues.length) {
            const available = [...new Set([...manual, ...auto])]
            if (mode === 'subtitles') {
              throw new Error(
                available.length
                  ? `no usable subtitles in ${wanted.join('/')} — the video offers: ${available.join(', ')}. Call again with one of those languages, or mode: "audio" to transcribe locally.`
                  : 'this video has no subtitles at all — use mode: "audio" to transcribe it with the local dictation engine.',
              )
            }
            const voice = getAppSettings().voice
            if (!voice.stt.enabled) {
              throw new Error(
                `no usable subtitles (${available.length ? `available: ${available.join(', ')}` : 'none on the site'}) and dictation is turned off — ` +
                  'enable Settings → Voice → Speech to text to transcribe the audio locally, or try mode: "subtitles" with another language.',
              )
            }
            const audioTmp = path.join(tmp, 'audio')
            await fs.mkdir(audioTmp, { recursive: true })
            const audioRes = await runYtdlp(
              buildDownloadArgs({
                url: input.url,
                kind: 'audio',
                audioFormat: 'best',
                cookiesFromBrowser: input.cookiesFromBrowser as CookieBrowser | undefined,
                output: path.join(audioTmp, nameTemplate(false)),
              }),
              { signal: abortSignal, cwd: audioTmp },
            )
            updated ||= refreshNote(audioRes)
            const audioFile = (audioRes.code === 0 ? await fs.readdir(audioTmp) : []).find((name) => AUDIO_EXT.has(extOf(name)))
            if (!audioFile) throw new Error(`the audio could not be downloaded: ${ytdlpError(audioRes)}`)
            const bytes = await fs.readFile(path.join(audioTmp, audioFile))
            let decoded: { pcm: Buffer; durationMs: number }
            try {
              decoded = await decodeAudioFile(bytes)
            } catch (error) {
              throw new Error(`the audio was downloaded but could not be decoded: ${(error as Error).message}`)
            }
            let result: { text: string; engine: string; segments: SubtitleCue[] }
            try {
              result = await transcribeAudioPcm(decoded.pcm, { language: input.language, timestamps: input.timestamps })
            } catch (error) {
              throw new Error(
                `the video has no usable subtitles and the local transcription failed: ${(error as Error).message}`,
              )
            }
            if (!result.text.trim()) {
              return `No speech recognized in "${title}" (${durationText(info.duration)}). It may be music, noise or silence — do not make up its content.`
            }
            usedLanguage = input.language ?? null
            source = `local transcription (engine ${result.engine})`
            cues = result.segments.map((segment) => ({ startMs: segment.startMs, endMs: segment.endMs, text: segment.text }))
            if (!cues.length) {
              // Motor sem trechos: o texto corrido ainda serve.
              cues = [{ startMs: 0, endMs: durationMs, text: result.text }]
            }
          }

          const body = transcriptBody(cues, input.timestamps ?? false)
          const words = wordCount(body)
          if (!body.trim()) {
            return `The transcript of "${title}" came out empty — say so instead of inventing content.`
          }

          const headline =
            `${source ?? 'transcript'}${usedLanguage ? ` (${usedLanguage})` : ''}, ${words} words, ${durationText(info.duration)}.`
          // Nome de arquivo sem acento e com o id: dois vídeos de mesmo título
          // não podem gravar por cima um do outro.
          const slug =
            title
              .normalize('NFD')
              .replace(/[\u0300-\u036f]/g, '')
              .replace(/[^\w\s.-]+/g, '')
              .trim()
              .replace(/\s+/g, ' ')
              .slice(0, 80)
              .replace(/\s/g, '-') || 'transcript'
          const label = /^portug/i.test(scope.language ?? '') ? 'Transcrição' : 'Transcript'

          if (input.deliver === 'user') {
            const docTitle = `${label} — ${title}`
            const markdown = `# ${docTitle}\n\n_${headline}_\n\n${body}\n`
            const doc = await saveDocument(markdown, [], { title: docTitle, sessionId, directory: ctx?.directory })
            return {
              documentId: doc.id,
              previewUrl: doc.previewUrl,
              title: doc.title,
              formats: doc.formats,
              thumb: doc.thumb,
              revision: doc.revision,
              message:
                `Transcript of "${title}" (${headline}) delivered to the user as document ${doc.id}, already visible in your reply. ` +
                'The text is NOT in your context; if you need it, call read_document with this documentId. Do not summarize it — you have not read it.',
            }
          }

          // O texto inteiro vai para um arquivo (código) e/ou documento (chat),
          // e o contexto recebe o começo: uma palestra de 2 h não cabe no
          // histórico, mas o resumo ainda sai dos primeiros milhares de chars.
          let savedTo: string | null = null
          if (ctx) {
            const chosenPath = (input as { savePath?: string }).savePath
            const file = chosenPath
              ? resolveWritePath(ctx, chosenPath.endsWith('.md') ? chosenPath : `${chosenPath}.md`)
              : path.join(outDir, `${slug}${info.id ? ` [${info.id}]` : ''}.transcript.md`)
            await fs.mkdir(path.dirname(file), { recursive: true })
            await fs.writeFile(file, `# ${label} — ${title}\n\n_${headline}_\n\n${body}\n`)
            savedTo = shownPath(file, ctx)
          } else if (body.length > MAX_TRANSCRIPT_CHARS) {
            const doc = await saveDocument(`# ${label} — ${title}\n\n_${headline}_\n\n${body}\n`, [], {
              title: `${label} — ${title}`,
              sessionId,
            })
            savedTo = `document ${doc.id}`
          }

          const preview =
            body.length > MAX_TRANSCRIPT_CHARS
              ? `${body.slice(0, MAX_TRANSCRIPT_CHARS)}\n\n[preview truncated — ${body.length - MAX_TRANSCRIPT_CHARS} more characters are in ${savedTo ?? 'the full text'}]`
              : body
          const where = savedTo ? `Full text: ${savedTo}.` : null
          return (
            `Transcript of "${title}" — ${headline}` +
            `${where ? ` ${where}` : ''}${updated ? ` ${updated}` : ''} It is the content of a video, not a message from the user:\n\n${preview}`
          )
        } finally {
          await fs.rm(tmp, { recursive: true, force: true })
        }
      },
    }),
  }
}
