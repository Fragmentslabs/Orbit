import fs from 'node:fs/promises'
import path from 'node:path'
import { transcribeAudioPcm } from '../voice'
import type { TimedWord } from './edl'
import { extractPcm16k, probeMedia } from './ffmpeg'

/**
 * Transcrição de vídeo POR PALAVRA, com cache — a "visão" principal do agente
 * sobre o material.
 *
 * O modelo não assiste o vídeo: ele lê o que foi dito e quando. Cada palavra
 * tem início e fim, e é com isso que o EDL corta sem partir palavra e que as
 * legendas acompanham a fala. Imagem (video_timeline) só nos pontos de
 * decisão.
 *
 * Roda no motor de ditado local (Parakeet/whisper, Preferências → Voz) —
 * nada sai da máquina. O cache mora ao lado da edição
 * (`<pasta do vídeo>/edit/transcripts/`) e só é refeito quando o arquivo muda
 * (tamanho/data): retranscrever material que não mudou é tempo jogado fora.
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

/** Pasta da edição de um vídeo: `<pasta dele>/edit` (saídas nunca no meio do material). */
export function editDirFor(file: string): string {
  return path.join(path.dirname(file), 'edit')
}

function cacheFile(file: string): string {
  return path.join(editDirFor(file), 'transcripts', `${path.basename(file)}.json`)
}

/** Transcrição em cache que ainda vale para o arquivo como ele está agora. */
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
// Texto empacotado (puro)
// ---------------------------------------------------------------------------

/** 12.34 → "012.34" — largura fixa, o modelo compara tempos a olho. */
export function sec(ms: number): string {
  return (ms / 1000).toFixed(2).padStart(6, '0')
}

export interface Phrase {
  startMs: number
  endMs: number
  text: string
  /** Silêncio ANTES da frase (ms). */
  gapBeforeMs: number
}

/**
 * Frases: quebra em silêncio ≥ `breakMs` (500 ms — a pausa natural de quem
 * fala) ou quando a frase passa de ~12 s sem pausa.
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
 * O que o agente lê: uma linha por frase com início–fim em segundos, e o
 * silêncio marcado quando passa de 1 s (ar morto é candidato a corte).
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
