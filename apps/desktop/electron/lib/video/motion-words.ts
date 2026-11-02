import fsp from 'node:fs/promises'
import type { TimedWord } from './edl'

/**
 * The TIME OF EACH WORD of a voice (or a sung line) that goes into a composition.
 *
 * Caption lines are not enough to sync text to a voice: with only "[3.1–5.4] a phrase" the
 * agent divides the line by the length of its words, and the red lands on the wrong syllable.
 * The engine that measures the cues already knows every word's start and end, so they are
 * kept as a sidecar next to the audio — `nar.wav` → `nar.wav.words.json` — and the page reads
 * them with `orbitMotion.audio.words()` (motion-helpers.ts), already moved to the piece's clock.
 * Retiming the track in audio.json then moves the words with it; nothing is typed twice.
 */

export const WORDS_SUFFIX = '.words.json'

export interface WordsSidecar {
  version: 1
  words: TimedWord[]
}

export function wordsSidecarPath(audioFile: string): string {
  return `${audioFile}${WORDS_SUFFIX}`
}

export async function writeWordsSidecar(audioFile: string, words: TimedWord[]): Promise<void> {
  const body: WordsSidecar = {
    version: 1,
    words: words.map((w) => ({ text: w.text.trim(), startMs: Math.round(w.startMs), endMs: Math.round(w.endMs) })),
  }
  await fsp.writeFile(wordsSidecarPath(audioFile), JSON.stringify(body))
}

/** The words saved for an audio file, or null when there are none (or the file is not valid). */
export async function readWordsSidecar(audioFile: string): Promise<TimedWord[] | null> {
  try {
    const parsed = JSON.parse(await fsp.readFile(wordsSidecarPath(audioFile), 'utf8')) as Partial<WordsSidecar>
    if (!Array.isArray(parsed.words)) return null
    return parsed.words.filter((w) => w && typeof w.text === 'string' && Number.isFinite(w.startMs) && Number.isFinite(w.endMs))
  } catch {
    return null
  }
}

/** Copies the sidecar of `from` to sit next to `to`. False when `from` has none. */
export async function copyWordsSidecar(from: string, to: string): Promise<boolean> {
  try {
    await fsp.copyFile(wordsSidecarPath(from), wordsSidecarPath(to))
    return true
  } catch {
    return false
  }
}

// -------------------------------------------------- what was said vs what was written

const norm = (word: string): string =>
  word
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '')

const tokens = (text: string): string[] => text.split(/\s+/).map(norm).filter(Boolean)

export interface SpokenDiff {
  /** Written, but not heard (case: "PRIDE" read as another word). */
  missing: string[]
  /** Heard, but not written. */
  extra: string[]
}

/**
 * Words of the TEXT that the engine did not hear, and words it heard that are not in the text.
 * A multiset difference — order does not matter, a repeated word counts each time. It is a hint,
 * not a verdict: the recognizer is the one that can be wrong. Pure.
 */
export function spokenDiff(text: string, heard: TimedWord[]): SpokenDiff {
  const pool = new Map<string, number>()
  for (const w of heard.flatMap((h) => tokens(h.text))) pool.set(w, (pool.get(w) ?? 0) + 1)
  const missing: string[] = []
  for (const w of tokens(text)) {
    const left = pool.get(w) ?? 0
    if (left > 0) pool.set(w, left - 1)
    else missing.push(w)
  }
  const extra: string[] = []
  for (const [w, count] of pool) for (let i = 0; i < count; i++) extra.push(w)
  return { missing, extra }
}

/** A line for the agent when the voice did not say what was written; '' when it matches. */
export function describeSpokenDiff(diff: SpokenDiff): string {
  if (diff.missing.length === 0 && diff.extra.length === 0) return ''
  const list = (words: string[]) => [...new Set(words)].slice(0, 8).map((w) => `"${w}"`).join(', ')
  const parts = [
    diff.missing.length ? `written but not heard: ${list(diff.missing)}` : '',
    diff.extra.length ? `heard but not written: ${list(diff.extra)}` : '',
  ].filter(Boolean)
  return `Check the pronunciation — ${parts.join('; ')}. A name or an ALL-CAPS word is often read wrongly: write it as it should sound (lowercase, or spelled out) and generate that phrase again; the recognizer can also be the one that is wrong.`
}
