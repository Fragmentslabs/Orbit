/**
 * Pure helpers behind the composer's voice dictation: phase machine, microphone level
 * metering for the waveform, language mapping and cursor-aware transcript insertion.
 * No React / native imports so everything here is unit-testable.
 */

// ─── Phase machine ───────────────────────────────────────────────────────────

export type DictationPhase = 'idle' | 'starting' | 'recording' | 'transcribing'

export type DictationEvent =
  | { type: 'press' }
  | { type: 'started' }
  | { type: 'startFailed' }
  | { type: 'stop' }
  | { type: 'cancel' }
  | { type: 'finished' }

/**
 * `press` while idle starts, while recording stops (→ transcribing); while starting or
 * transcribing it is ignored. `cancel` drops the recording (or the pending transcript)
 * and always returns to idle.
 */
export function dictationReducer(phase: DictationPhase, event: DictationEvent): DictationPhase {
  switch (event.type) {
    case 'press':
      if (phase === 'idle') return 'starting'
      if (phase === 'recording') return 'transcribing'
      return phase
    case 'started':
      return phase === 'starting' ? 'recording' : phase
    case 'startFailed':
      return phase === 'starting' ? 'idle' : phase
    case 'stop':
      return phase === 'recording' ? 'transcribing' : phase
    case 'finished':
      return phase === 'transcribing' ? 'idle' : phase
    case 'cancel':
      return 'idle'
  }
}

// ─── Microphone level metering ───────────────────────────────────────────────

/**
 * Loudness of a PCM16 little-endian buffer, 0..1. RMS with a sqrt curve so ordinary speech
 * (RMS ≈ 0.02–0.15 of full scale) fills a useful part of the bar height.
 */
export function pcmLevel(bytes: Uint8Array): number {
  const samples = bytes.length >> 1
  if (samples === 0) return 0
  const view = new DataView(bytes.buffer, bytes.byteOffset, samples * 2)
  // Sub-sample long buffers: the wave refreshes ~15x/s, precision is irrelevant.
  const step = Math.max(1, Math.floor(samples / 512))
  let sum = 0
  let n = 0
  for (let i = 0; i < samples; i += step) {
    const v = view.getInt16(i * 2, true) / 32768
    sum += v * v
    n++
  }
  const rms = Math.sqrt(sum / n)
  return Math.min(1, Math.sqrt(rms) * 1.6)
}

/** Appends a level keeping at most `max` of the newest ones (mutates and returns). */
export function pushLevel(values: number[], level: number, max: number): number[] {
  values.push(level)
  if (values.length > max) values.splice(0, values.length - max)
  return values
}

/** Last `count` levels, oldest → newest, left-padded with 0 so the wave has fixed width. */
export function visibleLevels(values: readonly number[], count: number): number[] {
  const tail = values.slice(-count)
  return tail.length >= count ? tail : [...new Array<number>(count - tail.length).fill(0), ...tail]
}

/** Microphone metering counts as "unavailable" when no buffer arrived for this long. */
export const LEVEL_STALE_MS = 700

export function levelsStale(lastAt: number, now: number): boolean {
  return now - lastAt > LEVEL_STALE_MS
}

// ─── Language ────────────────────────────────────────────────────────────────

/** App language (`pt-BR`, `en`) → the short code the desktop engine expects (`pt`, `en`). */
export function voiceLanguage(appLanguage: string | undefined): string | undefined {
  const base = appLanguage?.trim().toLowerCase().split(/[-_]/)[0]
  return base ? base : undefined
}

// ─── Transcript insertion ────────────────────────────────────────────────────

export interface TextSelection {
  start: number
  end: number
}

/**
 * Inserts `transcript` into `text` replacing the selection (collapsed cursor = pure insert),
 * adding a single space on each side only where the neighbour is not already whitespace.
 * Anything typed around it is preserved. Returns the new text and where the cursor goes.
 * An out-of-range or missing selection appends at the end.
 */
export function insertTranscript(
  text: string,
  transcript: string,
  selection?: TextSelection | null,
): { text: string; cursor: number } {
  const add = transcript.trim()
  if (!add) return { text, cursor: selection ? clamp(selection.end, text.length) : text.length }
  const start = selection ? clamp(Math.min(selection.start, selection.end), text.length) : text.length
  const end = selection ? clamp(Math.max(selection.start, selection.end), text.length) : text.length
  const before = text.slice(0, start)
  const after = text.slice(end)
  const lead = before && !/\s$/.test(before) ? ' ' : ''
  const trail = after && !/^\s/.test(after) ? ' ' : ''
  const inserted = lead + add + trail
  return { text: before + inserted + after, cursor: before.length + lead.length + add.length + trail.length }
}

function clamp(n: number, max: number): number {
  return Math.max(0, Math.min(max, n))
}
