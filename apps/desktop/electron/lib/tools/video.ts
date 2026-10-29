import { tool, type ToolSet } from 'ai'
import fs from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { looksLikeAttachmentRef, resolveAttachmentRef } from '../attachment-ref'
import { edlSchema, type Edl } from '../video/edl'
import { VIDEO_GUIDES } from '../video/guide'
import { probeMedia, type MediaProbe } from '../video/ffmpeg'
import { addVideoToGallery } from '../video/video-gallery'
import { renderEdl } from '../video/render'
import { registerVideo } from '../video/store'
import { renderTimeline } from '../video/timeline'
import { editDirFor, packTranscript, plainText, readCachedTranscript, sec, transcribeVideo, wordsText } from '../video/transcript'
import { saveDocument, saveMedia } from '../media'
import { clock } from './audio'
import { resolveSafePath, resolveWritePath, type ToolContext } from './context'
import { recordToolWrite } from '../session/write-journal'

/**
 * Edição de vídeo para o agente (EDL).
 *
 * A divisão segue o video-use: o agente LÊ o material pela transcrição por
 * palavra (transcribe), OLHA só nos pontos de decisão (video_timeline),
 * DECIDE num EDL e o código renderiza (video_render). O ffmpeg completo
 * continua no `bash` para o que o EDL não cobre. Motion (a composição HTML) é
 * outra coisa — uma peça do Orbit, com as tools dela em tools/motion.ts.
 *
 * Os vídeos que vão para o usuário entram na resposta como player (VideoPart,
 * montado pelo chat-engine a partir do `videoUrl` do resultado).
 */

/** Limite da imagem que vai ao modelo (o mesmo do panel_screenshot). */
const MAX_MODEL_IMAGE_BYTES = 300_000
/** Transcrição empacotada maior que isto fica só no arquivo. */
const MAX_PACKED_CHARS = 40_000

const timelineStash = new Map<string, { base64: string }>()

function describeProbe(p: MediaProbe, rel: string): string {
  const v = p.video[0]
  const a = p.audio[0]
  const parts = [
    `${rel}: ${sec(p.durationMs)} s, ${(p.sizeBytes / 1e6).toFixed(1)} MB, ${p.format}`,
    v
      ? `video ${v.codec} ${p.display?.width}x${p.display?.height}${v.rotation ? ` (rotated ${v.rotation}°)` : ''} @ ${v.fps} fps`
      : 'no video',
    a ? `audio ${a.codec} ${a.sampleRate} Hz ${a.channels}ch` : 'no audio',
  ]
  return parts.join(' · ')
}

/** Só o nome de um arquivo de saída — nunca um caminho que escape da pasta edit/. */
function outputName(name: string | undefined, fallback: string): string {
  const base = path.basename(name || fallback)
  if (!/\.(mp4|mov|webm|m4v|mkv)$/i.test(base)) return `${base}.mp4`
  return base
}

/**
 * Caminhos do EDL resolvidos: contra a pasta de trabalho (e checados) ou, quando
 * são a referência de um anexo (vdo_…, aud_…, img_…), para o arquivo do app. É por
 * aqui que um vídeo anexado vira fonte de um corte sem passar por pasta nenhuma.
 */
async function resolveEdl(edl: Edl, resolvePath: (p: string) => Promise<string>): Promise<Edl> {
  const sources = Object.fromEntries(await Promise.all(Object.entries(edl.sources).map(async ([id, p]) => [id, await resolvePath(p)] as const)))
  return {
    ...edl,
    sources,
    overlays: edl.overlays ? await Promise.all(edl.overlays.map(async (o) => ({ ...o, file: await resolvePath(o.file) }))) : undefined,
    music: edl.music ? { ...edl.music, file: await resolvePath(edl.music.file) } : undefined,
    subtitles:
      edl.subtitles && edl.subtitles.file ? { ...edl.subtitles, file: await resolvePath(edl.subtitles.file) } : edl.subtitles,
  }
}

export function createVideoTools(
  ctx: ToolContext,
  scope: {
    sessionId: string
    canShow: boolean
    readOnly: boolean
    /** Idioma da pessoa ("Portuguese", "English"…): o título do documento entregue é para ela. */
    language?: string
    /** "Fala em texto" ligado nas Preferências: desligado, a tool `transcribe` não existe. */
    sttEnabled?: boolean
    /**
     * Modo chat: não há pasta de projeto. O que o agente produz mora no
     * armazenamento do app (`outputDir`, dentro da pasta da conversa) e entra na
     * galeria de mídia como vídeo, onde pode ser visto e excluído — liberando o
     * arquivo. No modo código a saída fica no projeto, que é do usuário.
     */
    chat?: { outputDir: string }
  },
): ToolSet {
  const rel = (abs: string) => path.relative(ctx.directory, abs) || abs

  /**
   * O arquivo de uma tool de LEITURA: um caminho da pasta de trabalho, ou a
   * referência de um anexo do chat (vdo_…). A referência é a única forma de o
   * agente alcançar o que está fora da pasta — o app a traduz para o arquivo dele.
   */
  const mediaFile = async (p: string): Promise<{ file: string; label: string }> => {
    if (looksLikeAttachmentRef(p)) {
      const attachment = await resolveAttachmentRef(p)
      if (!attachment) throw new Error(`attachment not found: ${p} — use the ref from the attachment note`)
      return { file: attachment.file, label: attachment.id }
    }
    const file = resolveSafePath(ctx, p)
    return { file, label: rel(file) }
  }

  const show = async (file: string, title: string, durationMs?: number, opts: { preview?: boolean } = {}) => {
    if (!scope.canShow) return {}
    // No chat o vídeo final é do app: entra na galeria (e some de lá com a
    // exclusão). A prévia não — é descartável e se sobrescreve a cada render.
    if (scope.chat && !opts.preview) {
      const { entry } = await addVideoToGallery({ file, name: title, sessionId: scope.sessionId, source: 'chat' })
      return { videoUrl: entry.videoUrl, title, durationMs, path: file }
    }
    const { url } = await registerVideo(file, scope.sessionId)
    return { videoUrl: url, title, durationMs, path: file }
  }

  const tools: ToolSet = {
    video_guide: tool({
      description:
        'Returns the craft guide for video work. Call it ONCE per conversation before your first edit plan (topic "editing"), before writing a motion composition ("motion"), or before setting up Remotion ("remotion").',
      inputSchema: z.object({ topic: z.enum(['editing', 'motion', 'remotion']) }),
      execute: async ({ topic }) => VIDEO_GUIDES[topic],
    }),

    video_probe: tool({
      description:
        'Inspects video/audio files: duration, resolution (as displayed, rotation applied), fps, codecs, audio tracks. Cheap — call it first on any footage.',
      inputSchema: z.object({
        paths: z.array(z.string()).min(1).describe('Files relative to the working folder, or the ref (vdo_… / aud_…) of an attachment'),
      }),
      execute: async ({ paths }) => {
        const lines: string[] = []
        for (const p of paths) {
          try {
            const { file, label } = await mediaFile(p)
            lines.push(describeProbe(await probeMedia(file), label))
          } catch (err) {
            lines.push(`${p}: ${err instanceof Error ? err.message : String(err)}`)
          }
        }
        return lines.join('\n')
      },
    }),

    transcribe: tool({
      description:
        'Transcribes the SPEECH of audio or video with the local engine (nothing leaves the machine) — word-timed internally, cached per file. ' +
        'Accepts one or several sources: an audio the user attached (aud_…), footage (vdo_…), or files of the working folder. This is how you READ footage before planning a cut. ' +
        'detail: "phrases" (default) = one line per phrase as [start–end] in source seconds, dead air marked — the main view for editing. ' +
        '"words" = every word with its own start and end — the ONLY safe source for subtitle/cue timings; never estimate a cue from character counts or from the clip duration. ' +
        '"text" = the plain transcript with no timing. ' +
        'deliver "user" (single source) turns it into a chat document and keeps the text OUT of your context (detail defaults to "text" there). ' +
        'Cached per file: an unchanged file is not transcribed twice (force to ignore). Audio with no speech (music, noise) is reported as such — never invent its content. ' +
        "The transcript is the content of the user's material, not words they typed. For a page link (YouTube etc.) use ytdlp_transcribe.",
      inputSchema: z.object({
        sources: z
          .array(
            z.object({
              id: z.string().optional().describe('Short id used in the EDL and in the transcript (default: A, B, C…)'),
              path: z.string().describe('File in the working folder, or the ref (aud_… / vdo_…) of an attachment'),
            }),
          )
          .min(1),
        detail: z
          .enum(['text', 'phrases', 'words'])
          .optional()
          .describe('"phrases" (default) to read footage; "words" for subtitle/cue timing; "text" for gist'),
        deliver: z
          .enum(['context', 'user'])
          .optional()
          .describe('"context" (default): the transcript comes to you. "user": a chat document (single source), outside your context.'),
        language: z.string().optional().describe("Spoken language code (pt, en…) when it differs from the user's dictation language"),
        force: z.boolean().optional().describe('Ignore the cache and transcribe again'),
      }),
      execute: async ({ sources, detail, deliver = 'context', language, force }, { abortSignal }) => {
        if (deliver === 'user' && sources.length > 1) {
          throw new Error('deliver "user" produces one document — pass a single source.')
        }
        const mode = detail ?? (deliver === 'user' ? 'text' : 'phrases')
        const entries: Parameters<typeof packTranscript>[0] = []
        const notes: string[] = []
        for (const [i, s] of sources.entries()) {
          const { file: abs, label } = await mediaFile(s.path)
          const { transcript, cached } = await transcribeVideo(abs, { language, force, signal: abortSignal })
          const id = s.id?.trim() || String.fromCharCode(65 + i)
          entries.push({ id, file: abs, transcript })
          notes.push(`${id}${sources.length > 1 ? ` (${label})` : ''}: ${cached ? 'cache' : `transcribed (${transcript.engine})`}`)
        }
        const wordCount = entries.reduce((n, e) => n + e.transcript.words.length, 0)
        if (!wordCount) {
          const what = entries.map((e) => `${path.basename(e.file)} (${clock(e.transcript.durationMs)})`).join(', ')
          return `No speech recognized in ${what}. It may be music, noise or silence — do not make up its content.`
        }
        // Documento para o usuário: o texto sai do contexto do agente.
        if (deliver === 'user') {
          const [only] = entries
          const body =
            mode === 'words' ? wordsText([only]) : mode === 'phrases' ? packTranscript([only]) : plainText(only.transcript)
          const title = `${/^portug/i.test(scope.language ?? '') ? 'Transcrição' : 'Transcript'} — ${path.basename(only.file)}`
          const markdown = `# ${title}\n\n_${clock(only.transcript.durationMs)} · ${only.transcript.engine}_\n\n${body.replace(/\n/g, '\n\n')}\n`
          const doc = await saveDocument(markdown, [], {
            title,
            sessionId: scope.sessionId,
            // No chat não há projeto: o documento mora no storage do app.
            directory: scope.chat ? undefined : ctx.directory,
          })
          return {
            documentId: doc.id,
            previewUrl: doc.previewUrl,
            title: doc.title,
            formats: doc.formats,
            thumb: doc.thumb,
            revision: doc.revision,
            message:
              `Transcript of ${path.basename(only.file)} (${clock(only.transcript.durationMs)}, ${wordCount} words) delivered to the user as document ${doc.id}, ` +
              'already visible in your reply. The text is NOT in your context; if you need it, call read_document with this documentId. ' +
              'Do not summarize or comment on its content — you have not read it.',
          }
        }
        const body =
          mode === 'words'
            ? wordsText(entries)
            : mode === 'text'
              ? entries
                  .map((e) =>
                    entries.length > 1 ? `## ${e.id} — ${path.basename(e.file)}\n${plainText(e.transcript)}` : plainText(e.transcript),
                  )
                  .join('\n\n')
              : packTranscript(entries)
        // Cabeçalho que o chat-engine reconhece ("Transcript of …"): é assim que
        // a transcrição de um áudio anexado é gravada na NOTA do anexo, em vez
        // de ser refeita a cada pergunta sobre o mesmo arquivo.
        const head =
          entries.length === 1
            ? `Transcript of ${path.basename(entries[0].file)} (${clock(entries[0].transcript.durationMs)}, engine ${entries[0].transcript.engine}). This is the content of an attachment, not a message from the user.`
            : `Transcripts — ${notes.join(' · ')}.`
        // O pacote textual vira arquivo ao lado da edição — só no modo código,
        // que é onde existe uma pasta de trabalho para receber o arquivo.
        if (mode === 'phrases' && !scope.chat) {
          const packedFile = path.join(editDirFor(entries[0].file), 'takes_packed.md')
          recordToolWrite(packedFile)
          await fs.mkdir(path.dirname(packedFile), { recursive: true })
          await fs.writeFile(packedFile, packTranscript(entries))
          const saved = `\nSaved to ${rel(packedFile)}.`
          if (body.length > MAX_PACKED_CHARS) {
            return `${head}${saved}\n\n${body.slice(0, MAX_PACKED_CHARS)}\n\n[… truncated — read ${rel(packedFile)} for the rest]`
          }
          return `${head}${saved}\n\n${body}`
        }
        if (body.length > MAX_PACKED_CHARS) {
          return `${head}\n\n${body.slice(0, MAX_PACKED_CHARS)}\n\n[… truncated]`
        }
        return `${head}\n\n${body}`
      },
    }),

    video_timeline: tool({
      description:
        'Looks at a time window of a video: an image with a filmstrip, the audio waveform and each transcribed word placed where it is spoken; silences ≥ 0.4 s (clean cut points) highlighted in green; optional red marks. ' +
        'Use it at DECISION POINTS — an ambiguous pause, comparing two takes, checking a cut in a rendered output (pass its cut times as marks) — not to scan whole videos. Keep windows short (2–20 s). ' +
        'The sheet is saved to the media gallery: it is YOUR look at the footage and the user does NOT see it, unless you pass show: true (or show it later with show_image, using the media ref this tool returns).',
      inputSchema: z.object({
        path: z.string().describe('File in the working folder, or the ref (vdo_…) of an attached video'),
        start: z.number().min(0).describe('Seconds'),
        end: z.number().positive().describe('Seconds'),
        frames: z.number().int().min(1).max(16).optional().describe('Filmstrip frames, default 8'),
        marks: z.array(z.number()).optional().describe('Seconds to mark with a red line (e.g. cut points of a rendered output)'),
        show: z
          .boolean()
          .optional()
          .describe('Also put the sheet in your reply, where the user sees it (default false: only you read it)'),
      }),
      execute: async ({ path: p, start, end, frames, marks, show = false }, { toolCallId }) => {
        const { file: abs, label } = await mediaFile(p)
        if (end <= start) throw new Error('end must be after start')
        const probe = await probeMedia(abs)
        const endMs = Math.min(end * 1000, probe.durationMs)
        const startMs = Math.min(start * 1000, endMs - 100)
        const transcript = await readCachedTranscript(abs)
        const words = transcript?.words ?? []
        const { image, silences } = await renderTimeline({
          file: abs,
          startMs,
          endMs,
          frames: frames ?? 8,
          words,
          marks: marks?.map((m) => m * 1000),
          hasVideo: probe.video.length > 0,
          hasAudio: probe.audio.length > 0,
        })
        const inside = words.filter((w) => w.endMs > startMs && w.startMs < endMs)
        // A imagem vai SEMPRE para a galeria. Antes ela existia só no contexto
        // do modelo: não havia arquivo, URL nem item para mostrar depois, e o
        // agente anunciava "aí está" com a conversa vazia.
        const mediaUrl = await saveMedia(image, 'webp', {
          source: 'chat',
          sessionId: scope.sessionId,
          name: `Timeline ${label} ${sec(startMs)}–${sec(endMs)} s`,
        })
        const shown = show && scope.canShow
        const text = [
          `Timeline of ${label} ${sec(startMs)}–${sec(endMs)} s.`,
          transcript ? '' : 'No transcript cached for this file — words are not shown and silence is not measured (run transcribe).',
          inside.length ? `Words: ${inside.map((w) => `${w.text}@${sec(w.startMs)}-${sec(w.endMs)}`).join(' ')}` : '',
          // Sem transcrição não há como saber onde há fala: declarar a janela
          // inteira como silêncio (o que a conta de lacunas fazia com zero
          // palavras) era falso num vídeo com trilha.
          transcript
            ? silences.length
              ? `Silences ≥0.4s: ${silences.map((s) => `${sec(s.startMs)}–${sec(s.endMs)}`).join(', ')}`
              : 'No silence ≥0.4s in this window.'
            : '',
          ctx.modelVision === false ? 'This model has no vision: you cannot see the sheet — rely on this report.' : '',
          shown
            ? 'The sheet is attached to your reply — the user sees it.'
            : scope.canShow
              ? `The sheet is in the media gallery (${mediaUrl}) and is NOT in the user's chat: to show it, call show_image with this media ref.`
              : // Worker: não tem show_image — quem mostra é a sessão principal.
                `The sheet is in the media gallery (${mediaUrl}) and cannot be shown from this session: report this media ref so it can be shown with show_image.`,
        ]
          .filter(Boolean)
          .join('\n')
        if (ctx.modelVision !== false) timelineStash.set(toolCallId, { base64: image.toString('base64') })
        return {
          message: text,
          mediaUrl,
          alt: `Timeline ${label} ${sec(startMs)}–${sec(endMs)} s`,
          shown,
        }
      },
      toModelOutput: ({ toolCallId, output }) => {
        const stashed = timelineStash.get(toolCallId)
        timelineStash.delete(toolCallId)
        const text = typeof output === 'string' ? output : (output as { message: string }).message
        if (!stashed) return { type: 'text', value: text }
        if (Buffer.byteLength(stashed.base64, 'base64') > MAX_MODEL_IMAGE_BYTES) {
          return { type: 'text', value: `${text}\n[Image omitted: too large — use a shorter window or fewer frames.]` }
        }
        return {
          type: 'content',
          value: [
            { type: 'text', text },
            { type: 'image-data', data: stashed.base64, mediaType: 'image/webp' },
          ],
        }
      },
    }),

    video_render: tool({
      description:
        'Renders an EDL (edit decision list) into a video in the edit/ folder next to the first source, and shows it to the user as a player. ' +
        'The code enforces the production rules: cut edges snapped OUT of words with a little air (needs transcribe first), 30 ms audio fades at every cut, ranges concatenated without a second re-encode, overlays time-shifted into their window, subtitles burned LAST, loudness normalized (default -14 LUFS, true peak -1 dBTP) and measured. ' +
        'Render a preview (720p, fast) first, check the cut points it returns with video_timeline, then the final. ' +
        'Pass the EDL inline or as a JSON file path (edl/edlPath). Times: ranges in SOURCE seconds; overlays/subtitle files in OUTPUT seconds. A source, overlay or music file can be the ref (vdo_…, img_…, aud_…) of an attachment — no need to copy it anywhere first.',
      inputSchema: z.object({
        edl: edlSchema.optional(),
        edlPath: z.string().optional().describe('JSON file with the EDL (relative to the working folder)'),
        output: z.string().optional().describe('File name inside edit/ — default preview.mp4 (preview) or final.mp4'),
        preview: z.boolean().optional().describe('720p, fast encode — for checking. Default false'),
        language: z.string().optional().describe('Speech language code, used if subtitles force a transcription'),
        show: z.boolean().optional().describe('Show the result as a player in your reply (default true)'),
      }),
      execute: async ({ edl, edlPath, output, preview = false, language, show: showIt = true }, { abortSignal }) => {
        let raw: Edl | undefined = edl
        if (!raw && edlPath) raw = edlSchema.parse(JSON.parse(await fs.readFile(resolveSafePath(ctx, edlPath), 'utf8')))
        if (!raw) throw new Error('pass the EDL inline (edl) or its JSON file (edlPath)')
        const resolved = await resolveEdl(raw, async (p) => (await mediaFile(p)).file)
        const firstSource = resolved.sources[resolved.ranges[0].source]
        // A saída vai ao lado da fonte — a menos que a fonte seja um anexo (que
        // mora no armazenamento do app) ou que estejamos no chat: aí vai para a
        // pasta de saída desta conversa (chat) ou para edit/ do projeto (código).
        const fromAttachment = path.relative(ctx.directory, firstSource).startsWith('..')
        const editDir = scope.chat
          ? path.join(ctx.directory, scope.chat.outputDir)
          : fromAttachment
            ? path.join(ctx.directory, 'edit')
            : editDirFor(firstSource)
        // A pasta da edição inteira é escrita do turno (render, EDL, prévias).
        resolveWritePath(ctx, editDir)
        // No chat cada vídeo final tem nome próprio (cada um é um item da
        // galeria); a prévia é uma só, sobrescrita.
        const finalName = scope.chat ? `video-${Date.now().toString(36)}.mp4` : 'final.mp4'
        const outName = outputName(output, preview ? 'preview.mp4' : finalName)
        const result = await renderEdl(resolved, { editDir, outName, preview, language, signal: abortSignal })
        // O EDL efetivo (com as bordas já encaixadas) fica ao lado: dá para refazer e revisar.
        const planFile = path.join(editDir, `${path.parse(outName).name}.edl.json`)
        await fs.writeFile(
          planFile,
          JSON.stringify(
            { ...raw, ranges: result.ranges.map((r) => ({ ...r, start: r.startMs / 1000, end: r.endMs / 1000 })) },
            null,
            2,
          ),
        )
        const l = result.loudness
        const lines = [
          `Rendered ${rel(result.output)} — ${sec(result.durationMs)} s, ${result.width}x${result.height} @ ${result.fps} fps${preview ? ' (preview)' : ''}.`,
          `Cut points (output seconds): ${result.cutsMs.length ? result.cutsMs.map((c) => sec(c)).join(', ') : 'none (single range)'}.`,
          result.snapNotes.length
            ? `Snapped edges: ${result.snapNotes.map((s) => `range ${s.range} ${s.edge} ${sec(s.fromMs)}→${sec(s.toMs)} (${s.why})`).join('; ')}.`
            : '',
          l ? `Loudness: ${l.integratedLufs ?? '?'} LUFS integrated, true peak ${l.truePeakDb ?? '?'} dBTP, LRA ${l.lra ?? '?'} LU.` : '',
          result.subtitlesFile ? `Subtitles: ${rel(result.subtitlesFile)}.` : '',
          `Effective EDL: ${rel(planFile)}.`,
          ...result.warnings.map((w) => `Warning: ${w}`),
          'Self-check: run video_timeline on the OUTPUT around each cut point (± 1.5 s, marks = the cut) — look for visual jumps, clipped words, hidden subtitles — and fix before calling it done (max 3 passes).',
        ].filter(Boolean)
        return {
          message: lines.join('\n'),
          ...(showIt ? await show(result.output, path.basename(result.output), result.durationMs, { preview }) : {}),
        }
      },
    }),
  }

  // Modo plano: olhar e ler sim, escrever não — o render grava o vídeo.
  if (scope.readOnly) delete tools.video_render
  // Sem "Fala em texto" ligado não há motor: a tool de transcrição nem aparece.
  if (scope.sttEnabled === false) delete tools.transcribe

  if (scope.canShow) {
    tools.show_video = tool({
      description: 'Shows a video file from the working folder IN YOUR REPLY as a player (e.g. a render made with bash/ffmpeg, or a source the user asked to see).',
      inputSchema: z.object({
        path: z.string(),
        title: z.string().optional(),
      }),
      execute: async ({ path: p, title }) => {
        const abs = resolveSafePath(ctx, p)
        const probe = await probeMedia(abs)
        if (!probe.video.length) throw new Error(`${p} has no video stream`)
        return {
          message: `Showing ${rel(abs)} (${sec(probe.durationMs)} s) in your reply.`,
          ...(await show(abs, title || path.basename(abs), probe.durationMs)),
        }
      },
    })
  }

  return tools
}
