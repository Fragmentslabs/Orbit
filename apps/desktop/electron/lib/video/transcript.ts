import fs from 'node:fs/promises'
import path from 'node:path'
import { transcribeAudioPcm } from '../voice'
import type { TimedWord } from './edl'
import { extractPcm16k, probeMedia } from './ffmpeg'

/**
 * Video transcription WORD BY WORD, with cache — the agent's main "vision"
 * over the material.
 *
 * The model does not watch the video: it reads what was said and when. Each word
 * has a start and an end, and it is with that that the EDL cuts without splitting a word and that the
 * subtitles follow the speech. Image (video_timeline) only at the decision
 * points.
 *
 * It runs on the local dictation engine (Parakeet/whisper, Preferences → Voice) —
 * nothing leaves the machine. The cache lives next to the edit
 * (`<video folder>/edit/transcripts/`) and is only redone when the file changes
 * (size/date): re-transcribing material that did not change is wasted time.
 */

export interface VideoTranscript {
  version: 1
  file: string
  size: number
  mtimeMs: number
  engine: string
  durationMs: number
  words: TimedWord[]
}

/**
 * A video's edit folder: `<its folder>/edit` (outputs never in the middle of the
 * material). A file that is ALREADY inside an `edit/` folder uses that folder
 * — without `edit/edit/`, which was where an audio in edit/audio/ used to land.
 */
export function editDirFor(file: string): string {
  const dir = path.dirname(file)
  return path.basename(dir) === 'edit' ? dir : path.join(dir, 'edit')
}

function cacheFile(file: string): string {
  return path.join(editDirFor(file), 'transcripts', `${path.basename(file)}.json`)
}

/** Cached transcription that is still valid for the file as it is now. */
export async function readCachedTranscript(file: string): Promise<VideoTranscript | null> {
  try {
    const [raw, stat] = await Promise.all([fs.readFile(cacheFile(file), 'utf8'), fs.stat(file)])
    const cached = JSON.parse(raw) as VideoTranscript
    if (cached.version !== 1 || cached.size !== stat.size || Math.round(cached.mtimeMs) !== Math.round(stat.mtimeMs)) return null
    return cached
  } catch {
    return null
  }
}

export async function transcribeVideo(
  file: string,
  opts: { language?: string; force?: boolean; signal?: AbortSignal } = {},
): Promise<{ transcript: VideoTranscript; cached: boolean }> {
  if (!opts.force) {
    const cached = await readCachedTranscript(file)
    if (cached) return { transcript: cached, cached: true }
  }
  const stat = await fs.stat(file)
  const probe = await probeMedia(file)
  if (!probe.audio.length) {
    throw new Error(`${path.basename(file)} has no audio track — nothing to transcribe`)
  }
  const pcm = await extractPcm16k(file, { signal: opts.signal })
  const { engine, segments } = await transcribeAudioPcm(pcm, { language: opts.language, timestamps: 'words' })
  const words = segments.flatMap((seg) => seg.words ?? [])
  const transcript: VideoTranscript = {
    version: 1,
    file,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    engine,
    durationMs: probe.durationMs,
    words,
  }
  await fs.mkdir(path.dirname(cacheFile(file)), { recursive: true })
  await fs.writeFile(cacheFile(file), JSON.stringify(transcript))
  return { transcript, cached: false }
}

// ---------------------------------------------------------------------------
// Packed text (plain)
// ---------------------------------------------------------------------------

/** 12.34 → "012.34" — fixed width, the model compares times by eye. */
export function sec(ms: number): string {
  return (ms / 1000).toFixed(2).padStart(6, '0')
}

export interface Phrase {
  startMs: number
  endMs: number
  text: string
  /** Silence BEFORE the phrase (ms). */
  gapBeforeMs: number
}

/**
 * Phrases: break at a silence ≥ `breakMs` (500 ms — the natural pause of someone
 * speaking) or when the phrase goes past ~12 s without a pause.
 */
export function phrasesOf(words: TimedWord[], breakMs = 500, maxMs = 12_000): Phrase[] {
  const phrases: Phrase[] = []
  let current: TimedWord[] = []
  let gapBefore = words[0]?.startMs ?? 0
  const flush = (nextGap: number) => {
    if (!current.length) return
    phrases.push({
      startMs: current[0].startMs,
      endMs: current[current.length - 1].endMs,
      text: current.map((w) => w.text).join(' ').replace(/\s+([,.!?;:])/g, '$1'),
      gapBeforeMs: gapBefore,
    })
    gapBefore = nextGap
    current = []
  }
  for (const w of words) {
    const last = current[current.length - 1]
    const gap = last ? w.startMs - last.endMs : 0
    if (last && (gap >= breakMs || w.endMs - current[0].startMs > maxMs)) flush(gap)
    current.push(w)
  }
  flush(0)
  return phrases
}

/**
 * What the agent reads: one line per phrase with start–end in seconds, and the
 * silence marked when it goes past 1 s (dead air is a cut candidate).
 */
export function packTranscript(entries: { id: string; file: string; transcript: VideoTranscript }[]): string {
  const out: string[] = [
    '# Transcripts (word-timed, local engine)',
    '',
    'Lines: [start–end] in SOURCE seconds. "· silence Ns ·" marks dead air ≥ 1 s. Cut on silences ≥ 0.4 s; never inside a word.',
    '',
  ]
  for (const { id, file, transcript } of entries) {
    out.push(`## ${id} — ${path.basename(file)} (${sec(transcript.durationMs)} s, ${transcript.words.length} words)`)
    const phrases = phrasesOf(transcript.words)
    if (!phrases.length) out.push('(no speech recognized)')
    for (const p of phrases) {
      if (p.gapBeforeMs >= 1000) out.push(`· silence ${(p.gapBeforeMs / 1000).toFixed(1)}s ·`)
      out.push(`[${sec(p.startMs)}–${sec(p.endMs)}] ${p.text}`)
    }
    const tail = transcript.durationMs - (transcript.words[transcript.words.length - 1]?.endMs ?? 0)
    if (phrases.length && tail >= 1000) out.push(`· silence ${(tail / 1000).toFixed(1)}s (to the end) ·`)
    out.push('')
  }
  return out.join('\n')
}

/** Running text, without time: reading and summary — it is no good for cutting. */
export function plainText(transcript: VideoTranscript): string {
  return transcript.words
    .map((w) => w.text)
    .join(' ')
    .replace(/\s+([,.!?;:])/g, '$1')
}

/**
 * Word by word with start–end in source seconds (`word@012.34-012.78`).
 * It is from here that EXACT subtitle cues come: dividing a clip's duration by
 * the number of characters is a guess, and the guess is what desynchronizes subtitles.
 */
export function wordsText(entries: { id: string; file: string; transcript: VideoTranscript }[]): string {
  const out: string[] = [
    '# Words (start–end in SOURCE seconds)',
    '',
    'Use these times for subtitle/cue boundaries — one cue starts where the previous word ends.',
    '',
  ]
  for (const { id, file, transcript } of entries) {
    out.push(`## ${id} — ${path.basename(file)} (${sec(transcript.durationMs)} s, ${transcript.words.length} words)`)
    let line = ''
    for (const w of transcript.words) {
      const token = `${w.text}@${sec(w.startMs)}-${sec(w.endMs)}`
      if (line && line.length + token.length + 1 > 110) {
        out.push(line)
        line = ''
      }
      line = line ? `${line} ${token}` : token
    }
    if (line) out.push(line)
    out.push('')
  }
  return out.join('\n')
}
