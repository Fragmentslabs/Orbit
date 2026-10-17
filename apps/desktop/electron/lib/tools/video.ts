import { tool, type ToolSet } from 'ai'
import fs from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { looksLikeAttachmentRef, resolveAttachmentRef } from '../attachment-ref'
import { edlSchema, type Edl } from '../video/edl'
import { VIDEO_GUIDES } from '../video/guide'
import { probeMedia, type MediaProbe } from '../video/ffmpeg'
import { renderMotion } from '../video/motion'
import { MAX_FRAME_TIMES, captureMotionFrames, frameLabel, sheetFileName } from '../video/motion-frame'
import { addVideoToGallery } from '../video/video-gallery'
import { importAttachmentInto } from '../video/motion-asset'
import { openMotionAndReport } from '../video/motion-open'
import { renderEdl } from '../video/render'
import { registerVideo } from '../video/store'
import { renderTimeline } from '../video/timeline'
import { editDirFor, packTranscript, readCachedTranscript, sec, transcribeVideo } from '../video/transcript'
import { resolveSafePath, type ToolContext } from './context'

/**
 * Edição de vídeo e motion para o agente (modo código — precisa de pasta).
 *
 * A divisão segue o video-use: o agente LÊ o material pela transcrição por
 * palavra (video_transcribe), OLHA só nos pontos de decisão (video_timeline),
 * DECIDE num EDL e o código renderiza (video_render). Motion é HTML que o
 * próprio Chromium do app renderiza quadro a quadro (motion_render) — e antes
 * disso o usuário confere a composição viva no painel (motion_preview), com a
 * olhada barata do agente no meio (motion_frame: só os instantes pedidos, numa
 * folha de contato). O ffmpeg completo continua no `bash` para o que o EDL não
 * cobre.
 *
 * Os vídeos que vão para o usuário entram na resposta como player (VideoPart,
 * montado pelo chat-engine a partir do `videoUrl` do resultado).
 */

/** Limite da imagem que vai ao modelo (o mesmo do panel_screenshot). */
const MAX_MODEL_IMAGE_BYTES = 300_000
/** Transcrição empacotada maior que isto fica só no arquivo. */
const MAX_PACKED_CHARS = 40_000

const timelineStash = new Map<string, { base64: string }>()
const frameStash = new Map<string, { base64: string }>()

/**
 * Métricas por quadro do render, em ms (`msPerFrame`, `seekPaint`, `capture`,
 * `encodeWrite`). Tipo local e OPCIONAL de propósito: o contrato real vive no
 * motion.ts (`MotionMetrics`) e a tool lê o campo de forma tolerante — sem os
 * campos, a linha de timing simplesmente não aparece e nada quebra.
 */
interface MotionTiming {
  msPerFrame?: number
  seekPaint?: number
  capture?: number
  encodeWrite?: number
}

/** "Render timing (ms, per frame): msPerFrame 41.2 · seekPaint 12.4 · capture 20.8 · encodeWrite 8.0." */
function describeMetrics(metrics: MotionTiming | undefined): string | null {
  const parts = (
    [
      ['msPerFrame', metrics?.msPerFrame],
      ['seekPaint', metrics?.seekPaint],
      ['capture', metrics?.capture],
      ['encodeWrite', metrics?.encodeWrite],
    ] as const
  )
    .map(([name, value]) => (typeof value === 'number' && Number.isFinite(value) ? `${name} ${value.toFixed(1)}` : null))
    .filter((part): part is string => part !== null)
  return parts.length ? `Render timing (ms, per frame): ${parts.join(' · ')}.` : null
}

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

    video_transcribe: tool({
      description:
        'Transcribes the speech of videos WORD BY WORD (local engine, nothing leaves the machine) and returns the packed transcript: one line per phrase as [start–end] in source seconds, with dead air marked. ' +
        'This is how you READ footage — do it before planning any cut. Cached per file (edit/transcripts/); unchanged files are not re-transcribed. ' +
        'The packed text is also written to edit/takes_packed.md. Use ids (A, B, C… or take1…) to refer to sources in the EDL.',
      inputSchema: z.object({
        sources: z
          .array(
            z.object({
              id: z.string().min(1).describe('Short id used in the EDL'),
              path: z.string().describe('File in the working folder, or the ref (vdo_…) of an attached video'),
            }),
          )
          .min(1),
        language: z.string().optional().describe("Spoken language code (pt, en…) when it differs from the user's dictation language"),
        force: z.boolean().optional().describe('Ignore the cache and transcribe again'),
      }),
      execute: async ({ sources, language, force }, { abortSignal }) => {
        const entries: Parameters<typeof packTranscript>[0] = []
        const notes: string[] = []
        for (const s of sources) {
          const { file: abs } = await mediaFile(s.path)
          const { transcript, cached } = await transcribeVideo(abs, { language, force, signal: abortSignal })
          entries.push({ id: s.id, file: abs, transcript })
          notes.push(`${s.id}: ${cached ? 'cache' : `transcribed (${transcript.engine})`}`)
        }
        const packed = packTranscript(entries)
        const packedFile = path.join(editDirFor(entries[0].file), 'takes_packed.md')
        await fs.mkdir(path.dirname(packedFile), { recursive: true })
        await fs.writeFile(packedFile, packed)
        const head = `${notes.join(' · ')}\nSaved to ${rel(packedFile)}.\n\n`
        if (packed.length > MAX_PACKED_CHARS) {
          return `${head}${packed.slice(0, MAX_PACKED_CHARS)}\n\n[… truncated — read ${rel(packedFile)} for the rest]`
        }
        return head + packed
      },
    }),

    video_timeline: tool({
      description:
        'Looks at a time window of a video: an image with a filmstrip, the audio waveform and each transcribed word placed where it is spoken; silences ≥ 0.4 s (clean cut points) highlighted in green; optional red marks. ' +
        'Use it at DECISION POINTS — an ambiguous pause, comparing two takes, checking a cut in a rendered output (pass its cut times as marks) — not to scan whole videos. Keep windows short (2–20 s).',
      inputSchema: z.object({
        path: z.string().describe('File in the working folder, or the ref (vdo_…) of an attached video'),
        start: z.number().min(0).describe('Seconds'),
        end: z.number().positive().describe('Seconds'),
        frames: z.number().int().min(1).max(16).optional().describe('Filmstrip frames, default 8'),
        marks: z.array(z.number()).optional().describe('Seconds to mark with a red line (e.g. cut points of a rendered output)'),
      }),
      execute: async ({ path: p, start, end, frames, marks }, { toolCallId }) => {
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
        const text = [
          `Timeline of ${label} ${sec(startMs)}–${sec(endMs)} s.`,
          transcript ? '' : 'No transcript cached for this file — words are not shown (run video_transcribe).',
          inside.length ? `Words: ${inside.map((w) => `${w.text}@${sec(w.startMs)}-${sec(w.endMs)}`).join(' ')}` : '',
          silences.length ? `Silences ≥0.4s: ${silences.map((s) => `${sec(s.startMs)}–${sec(s.endMs)}`).join(', ')}` : 'No silence ≥0.4s in this window.',
        ]
          .filter(Boolean)
          .join('\n')
        if (ctx.modelVision !== false) timelineStash.set(toolCallId, { base64: image.toString('base64') })
        return text
      },
      toModelOutput: ({ toolCallId, output }) => {
        const stashed = timelineStash.get(toolCallId)
        timelineStash.delete(toolCallId)
        if (!stashed) return { type: 'text', value: String(output) }
        if (Buffer.byteLength(stashed.base64, 'base64') > MAX_MODEL_IMAGE_BYTES) {
          return { type: 'text', value: `${String(output)}\n[Image omitted: too large — use a shorter window or fewer frames.]` }
        }
        return {
          type: 'content',
          value: [
            { type: 'text', text: String(output) },
            { type: 'image-data', data: stashed.base64, mediaType: 'image/webp' },
          ],
        }
      },
    }),

    video_render: tool({
      description:
        'Renders an EDL (edit decision list) into a video in the edit/ folder next to the first source, and shows it to the user as a player. ' +
        'The code enforces the production rules: cut edges snapped OUT of words with a little air (needs video_transcribe first), 30 ms audio fades at every cut, ranges concatenated without a second re-encode, overlays time-shifted into their window, subtitles burned LAST, loudness normalized (default -14 LUFS, true peak -1 dBTP) and measured. ' +
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
        resolveSafePath(ctx, editDir)
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

    motion_preview: tool({
      description:
        'Opens an HTML motion composition in the Motion tab of the right panel, where the USER watches it live (play/pause, frame slider, a layer track showing when each element enters and leaves) — it does NOT render and writes no video. ' +
        'This is how motion work is done in Orbit: write the composition, open it here once, then keep EDITING the file — the tab reloads on every save and comes back to the same frame, so the user sees each change in real time. Do not render to show progress. ' +
        'The result tells you whether the composition loaded (format, duration) and lists its layers with the frames where each one enters and leaves — read it: a composition that did not load must be fixed before anything else. ' +
        'path: the entry .html (e.g. edit/animations/<slot>/index.html) or its folder (then index.html is assumed). The folder is what gets served, so the local dependencies (gsap.min.js, fonts, images) stay next to the entry. ' +
        'Size/duration are declared by the composition and only known once the page loads — this tool reports neither.',
      inputSchema: z.object({
        path: z.string().describe('Entry .html, or its folder (then index.html) — inside the working folder'),
      }),
      execute: async ({ path: p }) => {
        const target = resolveSafePath(ctx, p)
        return openMotionAndReport({
          target,
          root: ctx.directory,
          sessionId: scope.sessionId,
          label: rel(target),
          nextStep:
            'From here on, edit the composition file and the tab updates live — tell the user what you changed and let them watch. Render only if the user asks for the video file (they also have a Render button in the tab).',
          fixHint: 'fix the composition (edit the file; the tab reloads by itself) and call motion_preview again to confirm.',
        })
      },
    }),

    motion_frame: tool({
      description:
        'Looks at ONLY the instants you ask for in a motion composition: one offscreen window seeks each time (in the order you pass) and the result is a webp contact sheet with the time and the frame number printed in every cell — milliseconds, not seconds (no ffmpeg, no video). ' +
        'This is how you check the composition WHILE writing it: the entrance, the payoff, the hold at the end — a few moments, not the whole clip (that is what motion_render is for). ' +
        'times are in SECONDS from the start of the composition (converted to whole frames internally, at the composition\'s fps). 1–8 instants, inside the declared duration. ' +
        'path: the entry .html or its folder (then index.html is assumed), like motion_preview. Use it after motion_preview and BEFORE motion_render: the final render only runs once the user approved the composition.',
      inputSchema: z.object({
        path: z.string().describe('Entry .html, or its folder (then index.html) — inside the working folder'),
        times: z
          .array(z.number().positive())
          .min(1)
          .max(MAX_FRAME_TIMES)
          .describe('Seconds from the start, in the order you want them (the entrance, the payoff, the hold)'),
      }),
      execute: async ({ path: p, times }, { toolCallId, abortSignal }) => {
        const target = resolveSafePath(ctx, p)
        const result = await captureMotionFrames({
          target,
          times,
          root: ctx.directory,
          sessionId: scope.sessionId,
          signal: abortSignal,
        })
        // A folha fica sob edit/, nunca DENTRO da pasta da composição: aquela
        // pasta é observada para a recarga ao vivo do preview e um arquivo novo
        // ali recarregaria a aba justo enquanto o usuário olha.
        const sheetFile = resolveSafePath(ctx, path.join('edit', 'motion-frames', sheetFileName(result.name)))
        await fs.mkdir(path.dirname(sheetFile), { recursive: true })
        await fs.writeFile(sheetFile, result.image)
        const text = [
          `Frames of ${result.name} (${result.width}x${result.height} · ${result.fps} fps · ${result.durationInFrames} frames): ${result.cells
            .map((c) => frameLabel(c.timeMs, c.frame))
            .join(' · ')}.`,
          `Contact sheet: ${rel(sheetFile)}.`,
          result.failedFonts.length
            ? `Fonts failed to load (the text fell back to another font): ${[...new Set(result.failedFonts)].join(', ')}.`
            : '',
          'Look at the moments you will be judged on (entrance, payoff, hold), edit the composition and look again — motion_render only after the user approves.',
        ]
          .filter((line): line is string => Boolean(line))
          .join('\n')
        if (ctx.modelVision !== false) frameStash.set(toolCallId, { base64: result.image.toString('base64') })
        return text
      },
      toModelOutput: ({ toolCallId, output }) => {
        const stashed = frameStash.get(toolCallId)
        frameStash.delete(toolCallId)
        if (!stashed) return { type: 'text', value: String(output) }
        if (Buffer.byteLength(stashed.base64, 'base64') > MAX_MODEL_IMAGE_BYTES) {
          return { type: 'text', value: `${String(output)}\n[Image omitted: too large — ask for fewer instants.]` }
        }
        return {
          type: 'content',
          value: [
            { type: 'text', text: String(output) },
            { type: 'image-data', data: stashed.base64, mediaType: 'image/webp' },
          ],
        }
      },
    }),

    motion_render: tool({
      description:
        'Renders an HTML motion composition to a video inside the app (no Chrome download, no network) by capturing every frame at 30 fps through the composition\'s window.orbitMotion.seek(frame) — an integer frame per captured image, so the result is deterministic. ' +
        'Only when the user explicitly asks YOU for the video file (or you need the clip as an overlay in an EDL): the normal flow is live editing in the Motion tab, and the user renders from the tab\'s Render button. Never render to show progress or to check your work (motion_frame is the cheap look) and never post the result in the chat unless asked. ' +
        'The output must be OUTSIDE the composition folder (e.g. edit/renders/<slot>.mp4). ' +
        'Every frame must depend only on the frame number: setTimeout, Date.now() and requestAnimationFrame loops with their own clock freeze, a counter or Math.random() reused across frames breaks the parallel render. ' +
        'Declare size/fps/duration with <meta name="orbit-motion" content="width=1920,height=1080,fps=30,duration=5"> or window.orbitMotion = { durationInFrames, … }, or pass them here. ' +
        'transparent: true + a .mov (ProRes 4444) or .webm output gives an alpha overlay for the EDL. ' +
        'Only call it AFTER the user approved the composition in motion_preview — check the key moments with motion_frame first; rendering the whole clip is not how you find out what the piece looks like.',
      inputSchema: z.object({
        path: z.string().describe('HTML file in the working folder'),
        output: z.string().describe('Output file (relative), .mp4 / .mov / .webm'),
        duration: z.number().positive().max(180).optional(),
        width: z.number().int().positive().max(4096).optional(),
        height: z.number().int().positive().max(4096).optional(),
        fps: z.number().positive().max(60).optional(),
        transparent: z.boolean().optional(),
        audio: z
          .string()
          .optional()
          .describe(
            'Audio to carry with the video, in the working folder. Normally you do NOT pass it: declare the tracks of the piece in audio.json inside the composition folder — that is what the tab plays and the render mixes, at the declared instants (see the motion guide for the fields: start/end, gain, fades, duck, and the treatment — preset, eq, compress, automation, master). Pass this only for a one-off file from OUTSIDE the folder (audio_generate writes the file; pass its savePath here): it plays from the start of the piece. A single loose audio.mp3/audio.wav in the folder also counts, as one track. The capture takes no sound, so the tracks are mixed in a final pass and the video is NOT re-encoded; the composition sets the length and the render warns about any track that runs past the end.',
          ),
        show: z.boolean().optional().describe('Show it to the user as a player (default false — usually an ingredient of an edit)'),
      }),
      execute: async ({ path: p, output, show: showIt = false, ...spec }, { abortSignal }) => {
        const file = resolveSafePath(ctx, p)
        const out = resolveSafePath(ctx, output)
        // A pasta da composição é observada pelo preview: um vídeo gravado ali
        // dentro é ruído no projeto (e cada pedaço escrito era uma recarga).
        const folder = path.dirname(file)
        const relOut = path.relative(folder, out)
        if (!relOut.startsWith('..') && !path.isAbsolute(relOut)) {
          throw new Error(
            `write the render outside the composition folder (${rel(folder)}), e.g. ${rel(path.join(path.dirname(folder), '..', 'renders', `${path.basename(folder)}${path.extname(out) || '.mp4'}`))}`,
          )
        }
        await fs.mkdir(path.dirname(out), { recursive: true })
        // O caminho do áudio vem do modelo, relativo como qualquer outro: resolve
        // contra a pasta de trabalho (o render só abre caminho absoluto). Sem
        // áudio explícito, o render ainda procura o convencional na pasta da
        // composição — por isso `audio` é reescrito DEPOIS do spread.
        const audio = spec.audio ? resolveSafePath(ctx, spec.audio) : undefined
        const result = await renderMotion({
          file,
          output: out,
          signal: abortSignal,
          root: ctx.directory,
          sessionId: scope.sessionId,
          ...spec,
          audio,
        })
        // As métricas por quadro do render (contrato do motion.ts) vão na
        // resposta, compactas e em ms. Leitura tolerante: sem elas, sem linha.
        const metrics = (result as unknown as { metrics?: MotionTiming }).metrics
        const message = [
          `Rendered ${rel(out)} — ${result.duration}s, ${result.width}x${result.height} @ ${result.fps} fps (${result.frames} frames)${spec.transparent ? ', with alpha' : ''}.`,
          ...result.warnings.map((w) => `Warning: ${w}`),
          describeMetrics(metrics),
          'Check key moments with video_timeline before using it.',
        ]
          .filter((line): line is string => Boolean(line))
          .join('\n')
        return { message, ...(showIt ? await show(out, path.basename(out), result.duration * 1000) : {}) }
      },
    }),
  }

  tools.motion_asset = tool({
    description:
      'Copies an ATTACHED file (a video, photo, GIF or audio the user sent in the chat) into a folder of the working folder, so a composition can use it — or so a video can be cut/joined with the EDL tools, which only read the working folder. ' +
      'Call it only when you decide to USE the material; attaching does not copy it anywhere. ref: the vdo_… / aud_… / img_… reference from the attachment note. ' +
      'path: the composition folder (or its index.html) — or any folder in the working folder; it is created if missing. The result says the file name to put in the HTML and how to use it (timing attributes, crop, sound). ' +
      'The same ref twice gives the same file.',
    inputSchema: z.object({
      ref: z.string().describe('Reference from the attachment note: vdo_…, aud_… or img_…'),
      path: z.string().describe('Destination folder in the working folder, or the composition entry .html'),
      filename: z.string().optional().describe('Name for the copy (default: the original name, made safe)'),
    }),
    execute: async ({ ref, path: p, filename }) => {
      const target = resolveSafePath(ctx, p)
      const isFile = (await fs.stat(target).catch(() => null))?.isFile() ?? false
      const folder = isFile ? path.dirname(target) : target
      const imported = await importAttachmentInto(folder, ref, filename)
      return `${imported.report}\nFile: ${rel(imported.file)}`
    },
  })

  // Modo plano: olhar e ler sim, escrever não. Os dois renders saem porque
  // escrevem o vídeo na pasta de trabalho — e o motion_frame sai com eles: é
  // olhar, mas grava a folha de contato em edit/motion-frames.
  if (scope.readOnly) {
    delete tools.video_render
    delete tools.motion_render
    delete tools.motion_frame
    delete tools.motion_asset
  }

  // O preview abre uma ABA do painel — recurso único e visível, que não vai
  // para workers (mesma regra do browser do painel, em tools/index.ts): o
  // worker escreve a composição; quem mostra ao usuário é a sessão principal.
  // No modo plano ele FICA, ao contrário dos dois renders acima: não escreve
  // nada na pasta de trabalho (o único estado é o índice interno do registro,
  // em userData) nem renderiza — é o olhar, não o render.
  if (!scope.canShow) delete tools.motion_preview

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
