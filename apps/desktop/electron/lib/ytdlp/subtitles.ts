/**
 * Subtitles as TEXT: the cheap path of transcription.
 *
 * When the site already delivers subtitles (YouTube delivers them for almost
 * everything, manual or automatic), it makes no sense to download the whole audio and
 * run it through the dictation engine — the subtitle comes out in seconds and is more
 * faithful, because it comes from where the site itself recognized the speech. But
 * site subtitles are not clean text:
 *
 *  - YouTube's automatic `.vtt` is a scrolling WINDOW, with the same line repeated
 *    across several consecutive chunks (without deduplicating, the text comes out
 *    stuttering);
 *  - tags come along (`<c>`, `<00:00:01.000>`), HTML entities and position markup.
 *
 * This module solves that and returns chunks with timing — the same format the local
 * transcription uses — so that the running text and the list with timestamps come out
 * of the SAME reading.
 */

export interface SubtitleCue {
  startMs: number
  endMs: number
  text: string
}

export type SubtitleFormat = 'json3' | 'vtt' | 'srt' | 'unknown'

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  '#39': "'",
}

export function decodeEntities(text: string): string {
  return text.replace(/&(#?\w+);/g, (whole, name: string) => {
    if (name.startsWith('#x') || name.startsWith('#X')) {
      const code = Number.parseInt(name.slice(2), 16)
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole
    }
    if (name.startsWith('#')) {
      const code = Number(name.slice(1))
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole
    }
    return ENTITIES[name] ?? whole
  })
}

/** A subtitle line without markup: tags, ASS position, entities and spaces. */
export function cleanCueLine(line: string): string {
  return decodeEntities(
    line
      .replace(/<[^>]*>/g, '')
      .replace(/\{\\[^}]*\}/g, '')
      .replace(/\\N/gi, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim()
}

export function subtitleFormatOf(file: string, content = ''): SubtitleFormat {
  const ext = file.toLowerCase().split('.').pop() ?? ''
  if (ext === 'json3' || ext === 'json') return 'json3'
  if (ext === 'vtt') return 'vtt'
  if (ext === 'srt' || ext === 'srv') return 'srt'
  const head = content.slice(0, 4000)
  if (/^\s*\{/.test(head)) return 'json3'
  if (/^WEBVTT/m.test(head)) return 'vtt'
  if (head.includes('-->')) return 'srt'
  return 'unknown'
}

/** `00:01:02.345`, `01:02,345`, `62.3s`… all in ms. */
export function parseTimestamp(value: string): number | null {
  const text = value.trim()
  const timed = /(?:(\d{1,3}):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/.exec(text)
  if (timed) {
    const h = timed[1] ? Number(timed[1]) : 0
    const m = Number(timed[2])
    const s = Number(timed[3])
    const ms = Number((timed[4] + '00').slice(0, 3))
    return ((h * 60 + m) * 60 + s) * 1000 + ms
  }
  const bare = /^(\d+(?:[.,]\d+)?)\s*s?$/.exec(text)
  if (bare) return Math.round(Number(bare[1].replace(',', '.')) * 1000)
  return null
}

function parseTimedText(content: string): SubtitleCue[] {
  const cues: SubtitleCue[] = []
  // Blocks separated by a blank line; the WEBVTT header and the style
  // blocks (STYLE/NOTE) drop out for having no `-->`.
  for (const block of content.split(/\n{2,}/)) {
    const lines = block.split('\n')
    const arrow = lines.findIndex((line) => line.includes('-->'))
    if (arrow < 0) continue
    const [left, right] = lines[arrow].split('-->')
    const startMs = parseTimestamp(left ?? '')
    if (startMs === null) continue
    // The right side may carry a position after the time ("00:02.000 align:start").
    const endMs = parseTimestamp(right ?? '') ?? startMs
    const body = lines
      .slice(arrow + 1)
      .map(cleanCueLine)
      .filter(Boolean)
    if (!body.length) continue
    cues.push({ startMs, endMs: Math.max(endMs, startMs), text: body.join('\n') })
  }
  return cues
}

interface Json3Event {
  tStartMs?: number
  dDurationMs?: number
  segs?: { utf8?: string }[]
}

function parseJson3(content: string): SubtitleCue[] {
  let data: { events?: Json3Event[] }
  try {
    data = JSON.parse(content) as { events?: Json3Event[] }
  } catch {
    return []
  }
  const cues: SubtitleCue[] = []
  for (const event of data.events ?? []) {
    const raw = (event.segs ?? []).map((seg) => seg.utf8 ?? '').join('')
    // json3 marks a line break with an event that is only "\n".
    const text = cleanCueLine(raw)
    if (!text) continue
    const startMs = Math.max(0, Math.round(event.tStartMs ?? 0))
    cues.push({ startMs, endMs: startMs + Math.max(0, Math.round(event.dDurationMs ?? 0)), text })
  }
  return cues
}

export function parseSubtitleFile(content: string, file = ''): SubtitleCue[] {
  const clean = content.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  const format = subtitleFormatOf(file, clean)
  if (format === 'json3') return parseJson3(clean)
  if (format === 'vtt' || format === 'srt') return parseTimedText(clean)
  return []
}

/**
 * The lines of a chunk that have not appeared in the previous ones — this is what
 * undoes the scrolling window of the automatic `.vtt` (the same sentence in 3
 * consecutive chunks becomes a single sentence).
 */
function freshLines(cue: SubtitleCue, recent: string[]): string[] {
  return cue.text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !recent.includes(line))
}

/** Running text, with a new paragraph where the speech rests (pause ≥ 1.5 s). */
export function cueText(cues: SubtitleCue[]): string {
  const paragraphs: string[] = []
  let lines: string[] = []
  let recent: string[] = []
  let lastEnd = 0
  const flush = () => {
    if (lines.length) paragraphs.push(lines.join(' '))
    lines = []
    recent = []
  }
  for (const cue of cues) {
    const fresh = freshLines(cue, recent)
    if (!fresh.length) {
      lastEnd = Math.max(lastEnd, cue.endMs)
      continue
    }
    if (lastEnd && cue.startMs - lastEnd > 1500) flush()
    lines.push(...fresh)
    recent = [...recent, ...fresh].slice(-4)
    lastEnd = Math.max(lastEnd, cue.endMs)
  }
  flush()
  return paragraphs.join('\n\n')
}

/** 0:42 / 1:02:09 — the same format as the app's other transcripts. */
export function clockText(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = String(total % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`
}

/** One `[m:ss] text` line per chunk (without repeating the inherited line). */
export function timestampedCues(cues: SubtitleCue[]): string {
  const out: string[] = []
  let recent: string[] = []
  for (const cue of cues) {
    const fresh = freshLines(cue, recent)
    if (!fresh.length) continue
    out.push(`[${clockText(cue.startMs)}] ${fresh.join(' ')}`)
    recent = [...recent, ...fresh].slice(-4)
  }
  return out.join('\n')
}

/**
 * Which language to use among the ones the site offers: first the requested ones
 * (exact code, then the family — `pt` finds `pt-BR`), then any. Returning the REAL
 * language matters: the report has to say in which language the text came out.
 */
export function matchLanguage(available: string[], requested: string[]): string | null {
  if (!available.length) return null
  const lower = available.map((lang) => lang.toLowerCase())
  for (const want of requested) {
    const target = want.trim().toLowerCase()
    if (!target) continue
    const exact = lower.indexOf(target)
    if (exact >= 0) return available[exact]
    const family = lower.findIndex((lang) => lang.startsWith(`${target}-`) || lang.startsWith(target))
    if (family >= 0) return available[family]
  }
  return available[0]
}
