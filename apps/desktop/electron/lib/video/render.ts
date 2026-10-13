import fs from 'node:fs/promises'
import path from 'node:path'
import {
  buildAss,
  chunkWords,
  cutPointsMs,
  edgeFadeFilter,
  fitFilter,
  gradeFilter,
  outputSize,
  outputWords,
  snapRanges,
  subtitleDefaults,
  totalDurationMs,
  type Edl,
  type PlannedRange,
  type SnapNote,
  type TimedWord,
} from './edl'
import { probeMedia, runFfmpeg, type MediaProbe } from './ffmpeg'
import { readCachedTranscript, transcribeVideo } from './transcript'

/**
 * Executa um EDL já com caminhos resolvidos. As regras de produção estão na
 * ORDEM dos passos, não em instruções ao modelo:
 *
 *  1. cada trecho é extraído e reencodado sozinho (ajuste de quadro, grade,
 *     fades de 30 ms no áudio) — todos com os mesmos parâmetros;
 *  2. os trechos são concatenados com `-c copy` (sem segunda perda);
 *  3. um passo final aplica overlays (com o tempo deslocado para a janela
 *     deles), música e, POR ÚLTIMO, as legendas — senão um overlay as cobre —
 *     e normaliza a loudness;
 *  4. a saída é medida (ebur128): o agente não ouve, então relata número.
 */

export interface RenderOptions {
  editDir: string
  /** Nome do arquivo de saída dentro de editDir (final.mp4, preview.mp4…). */
  outName: string
  preview: boolean
  signal?: AbortSignal
  /** Idioma da fala, para transcrever quando a legenda pedir e não houver cache. */
  language?: string
}

export interface Loudness {
  integratedLufs: number | null
  truePeakDb: number | null
  lra: number | null
}

export interface RenderResult {
  output: string
  durationMs: number
  width: number
  height: number
  fps: number
  cutsMs: number[]
  ranges: PlannedRange[]
  snapNotes: SnapNote[]
  subtitlesFile?: string
  loudness?: Loudness
  warnings: string[]
}

const VIDEO_EXT_ALPHA_VP9 = /\.webm$/i
const IMAGE_EXT = /\.(png|jpe?g|webp|gif)$/i

function n(value: number): string {
  return Number(value.toFixed(3)).toString()
}

/** Lê o resumo do ebur128 no stderr (o último bloco "Summary"). */
export function parseEbur128(stderr: string): Loudness {
  const summary = stderr.slice(stderr.lastIndexOf('Summary:'))
  const pick = (re: RegExp) => {
    const m = re.exec(summary)
    return m ? Number(m[1]) : null
  }
  return {
    integratedLufs: pick(/I:\s+(-?[\d.]+)\s+LUFS/),
    truePeakDb: pick(/True peak:\s*[\r\n]+\s*Peak:\s+(-?[\d.]+|-inf)\s+dBFS/) ?? pick(/Peak:\s+(-?[\d.]+)\s+dBFS/),
    lra: pick(/LRA:\s+(-?[\d.]+)\s+LU/),
  }
}

export async function measureLoudness(file: string, signal?: AbortSignal): Promise<Loudness> {
  const { stderr } = await runFfmpeg(['-nostats', '-i', file, '-vn', '-af', 'ebur128=peak=true', '-f', 'null', '-'], { signal })
  return parseEbur128(stderr)
}

export async function renderEdl(edl: Edl, opts: RenderOptions): Promise<RenderResult> {
  const warnings: string[] = []
  const signal = opts.signal

  // Sondagem e transcrições (cache) das fontes usadas.
  const used = [...new Set(edl.ranges.map((r) => r.source))]
  for (const id of used) if (!edl.sources[id]) throw new Error(`range uses source "${id}", which is not in sources`)
  const probes: Record<string, MediaProbe> = {}
  const words: Record<string, TimedWord[] | undefined> = {}
  const wantsGeneratedSubs = Boolean(edl.subtitles && !edl.subtitles.file)
  for (const id of used) {
    const file = edl.sources[id]
    probes[id] = await probeMedia(file)
    if (!probes[id].video.length) throw new Error(`source "${id}" (${path.basename(file)}) has no video stream`)
    let transcript = await readCachedTranscript(file)
    if (!transcript && wantsGeneratedSubs && probes[id].audio.length) {
      transcript = (await transcribeVideo(file, { language: opts.language, signal })).transcript
    }
    words[id] = transcript?.words
  }
  if (edl.snap !== false && used.some((id) => !words[id])) {
    warnings.push(
      `no transcript for ${used.filter((id) => !words[id]).join(', ')}: those cuts were NOT snapped to word boundaries (run video_transcribe first)`,
    )
  }

  const durations = Object.fromEntries(used.map((id) => [id, probes[id].durationMs]))
  for (const [i, r] of edl.ranges.entries()) {
    if (r.end <= r.start) throw new Error(`range ${i}: end (${r.end}) must be after start (${r.start})`)
    if (r.start * 1000 >= durations[r.source]) {
      throw new Error(`range ${i}: start ${r.start}s is past the end of "${r.source}" (${(durations[r.source] / 1000).toFixed(2)}s)`)
    }
  }
  const { ranges, notes } = snapRanges(edl.ranges, words, { padMs: edl.padMs, snap: edl.snap, durationsMs: durations })
  if (!ranges.length) throw new Error('no range left after validation (all shorter than 40 ms?)')
  const totalMs = totalDurationMs(ranges)

  const first = probes[ranges[0].source]
  const { width, height } = outputSize(edl, first.display, opts.preview)
  let fps = edl.output?.fps ?? (Math.round(first.video[0].fps) || 30)
  if (opts.preview) fps = Math.min(fps, 30)
  const fit = edl.output?.fit ?? 'contain'
  const x264 = opts.preview ? ['-preset', 'veryfast', '-crf', '26'] : ['-preset', 'medium', '-crf', '18']

  await fs.mkdir(opts.editDir, { recursive: true })
  const work = await fs.mkdtemp(path.join(opts.editDir, '.render-'))
  try {
    // 1. Trechos.
    const segs: string[] = []
    for (const [i, r] of ranges.entries()) {
      const probe = probes[r.source]
      const durS = (r.endMs - r.startMs) / 1000
      const grade = gradeFilter(r.grade ?? edl.grade)
      const vf = [fitFilter(width, height, fps, fit), grade].filter(Boolean).join(',')
      const hasAudio = probe.audio.length > 0
      const seg = `seg_${String(i).padStart(3, '0')}.mp4`
      await runFfmpeg(
        [
          '-v', 'error',
          '-ss', n(r.startMs / 1000),
          '-t', n(durS),
          '-i', edl.sources[r.source],
          // Fonte sem áudio: silêncio do mesmo tamanho, senão o concat desalinha.
          ...(hasAudio ? [] : ['-f', 'lavfi', '-t', n(durS), '-i', 'anullsrc=r=48000:cl=stereo']),
          '-filter_complex',
          `[0:v]${vf}[v];[${hasAudio ? '0:a' : '1:a'}]${edgeFadeFilter(r.endMs - r.startMs, r.volumeDb)}[a]`,
          '-map', '[v]',
          '-map', '[a]',
          '-c:v', 'libx264', ...x264, '-pix_fmt', 'yuv420p', '-r', String(fps),
          '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
          '-video_track_timescale', '90000',
          seg,
        ],
        { cwd: work, signal },
      )
      segs.push(seg)
    }

    // 2. Concat sem reencode.
    await fs.writeFile(path.join(work, 'list.txt'), segs.map((s) => `file '${s}'`).join('\n'))
    await runFfmpeg(['-v', 'error', '-f', 'concat', '-safe', '0', '-i', 'list.txt', '-c', 'copy', 'joined.mp4'], { cwd: work, signal })

    // 3. Passo final: overlays → legendas (por último) no vídeo; música e loudness no áudio.
    const inputs: string[] = ['-i', 'joined.mp4']
    const graph: string[] = []
    let video = '[0:v]'
    let videoFiltered = false
    let nextInput = 1
    for (const [k, ov] of (edl.overlays ?? []).entries()) {
      const isImage = IMAGE_EXT.test(ov.file)
      if (ov.start * 1000 >= totalMs) {
        warnings.push(`overlay ${k} (${path.basename(ov.file)}) starts at ${ov.start}s, after the end of the cut (${(totalMs / 1000).toFixed(2)}s) — skipped`)
        continue
      }
      let dur = ov.duration
      if (!dur) {
        if (isImage) throw new Error(`overlay ${k}: images need a duration`)
        dur = (await probeMedia(ov.file)).durationMs / 1000
      }
      if (isImage) inputs.push('-loop', '1', '-framerate', String(fps), '-t', n(dur), '-i', ov.file)
      else if (VIDEO_EXT_ALPHA_VP9.test(ov.file)) inputs.push('-c:v', 'libvpx-vp9', '-i', ov.file)
      else inputs.push('-i', ov.file)
      const idx = nextInput++
      const scale = ov.width ? `scale=${ov.width}:-2,` : ''
      graph.push(`[${idx}:v]${scale}format=yuva420p,setpts=PTS-STARTPTS+${n(ov.start)}/TB[ov${k}]`)
      const x = ov.x ?? 0
      const y = ov.y ?? 0
      graph.push(
        `${video}[ov${k}]overlay=x=${x}:y=${y}:enable='between(t,${n(ov.start)},${n(ov.start + dur)})':eof_action=pass[v${k}]`,
      )
      video = `[v${k}]`
      videoFiltered = true
    }

    let subtitlesFile: string | undefined
    if (edl.subtitles) {
      const cfg = edl.subtitles
      let assName: string
      if (cfg.file) {
        assName = `subs${path.extname(cfg.file).toLowerCase()}`
        await fs.copyFile(cfg.file, path.join(work, assName))
      } else {
        const defaults = subtitleDefaults(cfg.style, height)
        const kept = outputWords(ranges, words)
        if (!kept.length) warnings.push('subtitles requested, but no transcribed words fall inside the cut — none burned')
        const cues = chunkWords(kept, cfg.wordsPerChunk ?? defaults.wordsPerChunk, cfg.uppercase ?? defaults.uppercase)
        assName = 'subs.ass'
        const ass = buildAss(cues, cfg, { width, height })
        await fs.writeFile(path.join(work, assName), ass)
        subtitlesFile = path.join(opts.editDir, `${path.parse(opts.outName).name}.ass`)
        await fs.writeFile(subtitlesFile, ass)
      }
      // Caminho relativo + cwd = pasta de trabalho: o filtro subtitles não
      // precisa de escape de "C:\" no Windows.
      graph.push(`${video}subtitles=filename=${assName}[vsub]`)
      video = '[vsub]'
      videoFiltered = true
    }

    let audio = '[0:a]'
    let audioFiltered = false
    if (edl.music) {
      const m = edl.music
      inputs.push('-i', m.file)
      const idx = nextInput++
      const totalS = totalMs / 1000
      const fadeOut = m.fadeOut ?? 1.5
      graph.push(
        `[${idx}:a]atrim=start=${n(m.start ?? 0)},asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,` +
          `volume=${m.volumeDb ?? -18}dB,apad,atrim=0:${n(totalS)},` +
          `afade=t=in:st=0:d=${n(m.fadeIn ?? 0.5)},afade=t=out:st=${n(Math.max(0, totalS - fadeOut))}:d=${n(fadeOut)}[mus]`,
      )
      if (m.duck !== false) {
        graph.push('[0:a]asplit=2[voice][sc]')
        graph.push('[mus][sc]sidechaincompress=threshold=0.02:ratio=10:attack=15:release=350[duck]')
        graph.push('[voice][duck]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[amix]')
      } else {
        graph.push('[0:a][mus]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[amix]')
      }
      audio = '[amix]'
      audioFiltered = true
    }
    if (edl.loudness !== false) {
      const target = (edl.loudness && edl.loudness.target) ?? -14
      graph.push(`${audio}loudnorm=I=${target}:TP=-1.0:LRA=11,aresample=48000[aout]`)
      audio = '[aout]'
      audioFiltered = true
    }

    const output = path.join(opts.editDir, opts.outName)
    if (!videoFiltered && !audioFiltered) {
      await fs.copyFile(path.join(work, 'joined.mp4'), output)
    } else {
      await runFfmpeg(
        [
          '-v', 'error',
          ...inputs,
          '-filter_complex', graph.join(';'),
          ...(videoFiltered ? ['-map', video, '-c:v', 'libx264', ...x264, '-pix_fmt', 'yuv420p', '-r', String(fps)] : ['-map', '0:v', '-c:v', 'copy']),
          ...(audioFiltered ? ['-map', audio, '-c:a', 'aac', '-b:a', '192k', '-ar', '48000'] : ['-map', '0:a', '-c:a', 'copy']),
          '-t', n(totalMs / 1000),
          '-movflags', '+faststart',
          output,
        ],
        { cwd: work, signal },
      )
    }

    // 4. Medida (o agente relata número, não "soa bem").
    let loudness: Loudness | undefined
    try {
      loudness = await measureLoudness(output, signal)
    } catch (err) {
      warnings.push(`loudness measurement failed: ${err instanceof Error ? err.message : String(err)}`)
    }

    return {
      output,
      durationMs: totalMs,
      width,
      height,
      fps,
      cutsMs: cutPointsMs(ranges),
      ranges,
      snapNotes: notes,
      subtitlesFile,
      loudness,
      warnings,
    }
  } finally {
    await fs.rm(work, { recursive: true, force: true }).catch(() => {})
  }
}
