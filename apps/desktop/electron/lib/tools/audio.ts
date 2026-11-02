import { tool } from 'ai'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import { getAppSettings } from '../app-settings'
import { saveAudio } from '../audio-store'
import type { TimedWord } from '../video/edl'
import { transcribeVideo } from '../video/transcript'
import { synthesizeToWav } from '../voice'
import { resolveWritePath, type ToolContext } from './context'

/**
 * Text to speech: an audio file of the requested text, in the configured voice.
 *
 * The inverse path (speech to text) does not live here: `transcribe` — in
 * tools/video.ts — is the ONLY transcription tool, for audio and video, with the
 * detail the caller asks for (text, sentences or word by word).
 *
 * No switch of its own: the tool only exists with "Text to speech" on in
 * Preferences → Voice — the decision is `buildToolSet`'s. When off, the prompt tells
 * the agent the feature is disabled and where to enable it (see prompts.ts).
 */

/** 0:42, 12:05, 1:02:09 — with hours only when the audio goes past one. */
export function clock(ms: number, withHours = false): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = String(total % 60).padStart(2, '0')
  return withHours || h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`
}

/** A caption line: at most this many words… */
const CUE_MAX_WORDS = 7
/** …and a pause this long between words always starts a new one. */
const CUE_PAUSE_MS = 350

/**
 * Words → caption lines with their real times: a line closes at a sentence/clause
 * end, at a pause, or when it gets long. The times come from the audio itself, so a
 * caption placed at `start` of the piece + these seconds lands on the voice. Pure.
 */
export function captionCues(words: TimedWord[]): { startMs: number; endMs: number; text: string }[] {
  const cues: { startMs: number; endMs: number; text: string }[] = []
  let current: TimedWord[] = []
  const close = () => {
    if (!current.length) return
    cues.push({ startMs: current[0].startMs, endMs: current[current.length - 1].endMs, text: current.map((w) => w.text.trim()).join(' ') })
    current = []
  }
  for (const word of words) {
    const last = current[current.length - 1]
    if (last && word.startMs - last.endMs >= CUE_PAUSE_MS) close()
    current.push(word)
    if (/[.!?;:,]$/.test(word.text.trim()) || current.length >= CUE_MAX_WORDS) close()
  }
  close()
  return cues
}

function secs(ms: number): string {
  return (ms / 1000).toFixed(2)
}

/**
 * Times of what was just spoken, measured on the generated audio by the local
 * dictation engine. Runs on a throwaway copy: the transcript cache lands next to the
 * file it reads, and the audio store is not the place for it.
 */
async function measureCues(wav: Buffer, lang: string | undefined): Promise<string> {
  if (!getAppSettings().voice.stt.enabled) {
    return 'Caption times unavailable: Speech to text is off (Settings → Voice). Do not estimate them — ask the user to enable it, or keep captions to whole scenes.'
  }
  const dir = path.join(os.tmpdir(), `orbit-tts-cues-${randomBytes(4).toString('hex')}`)
  try {
    await fs.mkdir(dir, { recursive: true })
    const file = path.join(dir, 'speech.wav')
    await fs.writeFile(file, wav)
    const { transcript } = await transcribeVideo(file, { language: lang, force: true })
    const cues = captionCues(transcript.words)
    if (!cues.length) return 'Caption times unavailable: the engine recognized no words in the generated audio.'
    return [
      'Caption lines with their real times in THIS audio (seconds from its start; add the second where the track starts in the piece):',
      ...cues.map((cue) => `[${secs(cue.startMs)}–${secs(cue.endMs)}] ${cue.text}`),
    ].join('\n')
  } catch (error) {
    return `Caption times unavailable: ${(error as Error).message}`
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

export function createAudioGenerateTool(sessionId: string, ctx: ToolContext | null) {
  return tool({
    description:
      'Creates an audio file of the given text being spoken (text-to-speech), with the voice configured in Settings → Voice. ' +
      'Use it when the user asks for an audio/voice version of something — a narration, a voice message, a pronunciation. ' +
      'The audio appears in your reply as a player and in the chat media; do not repeat the whole text after it, just say what it is. ' +
      'Write the text exactly as it should be SPOKEN: no Markdown, lists or URLs; numbers and symbols the way they are said. ' +
      'The result gives the exact duration — a narration for a video sets the length of its scene, not the other way around. ' +
      'Pass timings: true when the audio goes into a video or motion piece with captions/subtitles: it returns caption lines with their real start and end in the audio.',
    inputSchema: z.object({
      text: z.string().min(1).describe('What will be spoken, as plain spoken text'),
      title: z.string().optional().describe('Short title for the audio (shown on the player and in the chat media)'),
      voice: z
        .string()
        .regex(/^[FM][1-5]$/)
        .optional()
        .describe('F1–F5 (female) or M1–M5 (male). Omit to use the voice the user chose.'),
      speed: z.number().min(0.5).max(2).optional().describe('Speaking rate, 1 = natural. Omit unless asked.'),
      lang: z
        .string()
        .regex(/^[a-z]{2}$/)
        .optional()
        .describe(
          'Language of `text` as an ISO 639-1 code (pt, en, es, fr, de, it, ja, ko…) — the voice speaks with its accent. ' +
            'Set it to the language you wrote the text in (e.g. "en" when the user asked for the audio in English). ' +
            'Omit to detect it from the text.',
        ),
      timings: z
        .boolean()
        .optional()
        .describe('Also return caption lines with real start/end times measured on the audio (for captions in a video). Takes a few seconds.'),
      ...(ctx
        ? {
            savePath: z
              .string()
              .optional()
              .describe('Also write the .wav into the working folder at this path. Only when the user asked for the file in the project.'),
          }
        : {}),
    }),
    execute: async (input) => {
      const { text, title, voice, speed, lang, timings } = input
      const savePath = (input as { savePath?: string }).savePath
      // The language is that of the TEXT the agent wrote, not the fixed one from Preferences:
      // asking "generate in English" with the reading in Portuguese has to come out in English.
      const { wav, durationMs } = await synthesizeToWav(text, { voice, speed, lang: lang ?? 'auto' })
      const { url } = await saveAudio(wav, 'wav', { sessionId, name: title || undefined, source: 'chat' })
      let savedTo: string | null = null
      if (savePath && ctx) {
        const file = resolveWritePath(ctx, savePath.endsWith('.wav') ? savePath : `${savePath}.wav`)
        await fs.mkdir(path.dirname(file), { recursive: true })
        await fs.writeFile(file, wav)
        savedTo = file
      }
      const cues = timings ? await measureCues(wav, lang) : ''
      return {
        audioUrl: url,
        title: title ?? '',
        durationMs,
        message:
          `Audio generated (${clock(durationMs)} — exactly ${secs(durationMs)} s) and shown in your reply as a player; it is also in the chat media.` +
          (savedTo ? ` Saved to ${savedTo}.` : '') +
          (cues ? `\n${cues}` : ''),
      }
    },
  })
}
