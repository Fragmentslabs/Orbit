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
import { describeSpokenDiff, spokenDiff, writeWordsSidecar } from '../video/motion-words'
import { synthesizeToWav } from '../voice'
import { encodeWavPcm16 } from '../voice/audio'
import { describeSfx, SFX_KINDS, synthesizeSfx } from '../video/sfx'
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
 * file it reads, and the audio store is not the place for it. `words` is what the engine
 * heard word by word (the sidecar a composition reads); `message` is what the agent reads.
 */
async function measureCues(wav: Buffer, lang: string | undefined, written: string): Promise<{ message: string; words: TimedWord[] }> {
  const none = (message: string) => ({ message, words: [] as TimedWord[] })
  if (!getAppSettings().voice.stt.enabled) {
    return none('Caption times unavailable: Speech to text is off (Settings → Voice). Do not estimate them — ask the user to enable it, or keep captions to whole scenes.')
  }
  const dir = path.join(os.tmpdir(), `orbit-tts-cues-${randomBytes(4).toString('hex')}`)
  try {
    await fs.mkdir(dir, { recursive: true })
    const file = path.join(dir, 'speech.wav')
    await fs.writeFile(file, wav)
    const { transcript } = await transcribeVideo(file, { language: lang, force: true })
    const cues = captionCues(transcript.words)
    if (!cues.length) return none('Caption times unavailable: the engine recognized no words in the generated audio.')
    const diff = describeSpokenDiff(spokenDiff(written, transcript.words))
    return {
      words: transcript.words,
      message: [
        'Caption lines with their real times in THIS audio (seconds from its start; add the second where the track starts in the piece):',
        ...cues.map((cue) => `[${secs(cue.startMs)}–${secs(cue.endMs)}] ${cue.text}`),
        `The time of EVERY word (${transcript.words.length}) is saved with the audio: once it goes into a composition with motion_asset it is read there with orbitMotion.audio.words() / lines() / find() — do not type these times into the HTML or divide a line by the length of its words.`,
        diff,
      ]
        .filter(Boolean)
        .join('\n'),
    }
  } catch (error) {
    return none(`Caption times unavailable: ${(error as Error).message}`)
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
      'Pass timings: true when the audio goes into a video or motion piece with captions/subtitles: it returns caption lines with their real start and end in the audio, saves the time of every word for the composition, and warns when the voice did not say what you wrote (a name or an ALL-CAPS word read wrongly: write it as it should sound).',
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
      const { url, path: audioFile } = await saveAudio(wav, 'wav', { sessionId, name: title || undefined, source: 'chat' })
      let savedTo: string | null = null
      if (savePath && ctx) {
        const file = resolveWritePath(ctx, savePath.endsWith('.wav') ? savePath : `${savePath}.wav`)
        await fs.mkdir(path.dirname(file), { recursive: true })
        await fs.writeFile(file, wav)
        savedTo = file
      }
      const measured = timings ? await measureCues(wav, lang, text) : null
      if (measured?.words.length) await writeWordsSidecar(audioFile, measured.words).catch(() => {})
      const cues = measured?.message ?? ''
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

/**
 * Sound effects made from scratch (video/sfx.ts): whoosh, hit, pop, bell, riser, glitch, tick.
 * No switch: it is local, deterministic and needs no model, so it exists in both modes. The result
 * is an audio the chat plays AND a ref (aud_…) that motion_asset brings into a composition.
 */
export function createSfxGenerateTool(sessionId: string, ctx: ToolContext | null) {
  return tool({
    description:
      'Creates a short SOUND EFFECT from scratch (synthesised, no licence to credit, the same request always gives the same sound): ' +
      'whoosh (a transition sweep), hit (an impact), pop (a small UI/letter pop), bell (a ding), riser (the swell before an impact), glitch (a digital stutter), tick (a tiny click). ' +
      'Use it for a motion piece or an edit that needs a sound tied to something visible; the user\'s own file always wins over this. ' +
      'A whoosh or a riser swells TOWARD its peak: the result says how many seconds before the moment it must land to start the track. ' +
      'It sounds like a clean library effect, not a recording: if the user wants something cinematic, ask for their file. ' +
      'Then motion_asset({ name, ref }) brings it into the composition and audio.json places it (a few dB under the music, never on every transition).',
    inputSchema: z.object({
      kind: z.enum(SFX_KINDS).describe('whoosh | hit | pop | bell | riser | glitch | tick'),
      duration: z.number().positive().optional().describe('Seconds. Defaults per kind (whoosh 0.7, hit 0.8, pop 0.14, bell 1.8, riser 1.5, glitch 0.4, tick 0.03); clamped to a sensible range.'),
      pitch: z.number().min(30).max(4000).optional().describe('Hz of the body: hit (default 90), pop (520), bell (880 = A5). Ignored by the noise kinds.'),
      direction: z.enum(['up', 'down']).optional().describe('whoosh only: "up" sweeps dark to bright (default), "down" bright to dark. A riser always rises.'),
      seed: z.number().int().optional().describe('Another take of the noise (whoosh, hit click, glitch). Default 1.'),
      peakDb: z.number().min(-24).max(-0.5).optional().describe('Peak of the file in dBFS (default -3). The level in the piece is set with gain in audio.json.'),
      title: z.string().optional().describe('Short title for the media list (default: the kind)'),
      ...(ctx
        ? { savePath: z.string().optional().describe('Also write the .wav into the working folder at this path. Only when the user asked for the file in the project.') }
        : {}),
    }),
    execute: async (input) => {
      const { title, ...request } = input
      const savePath = (input as { savePath?: string }).savePath
      try {
        const sfx = synthesizeSfx(request)
        const wav = encodeWavPcm16(sfx.samples, sfx.rate)
        const { id, url } = await saveAudio(wav, 'wav', { sessionId, name: title || sfx.params.kind, source: 'chat' })
        let savedTo: string | null = null
        if (savePath && ctx) {
          const file = resolveWritePath(ctx, savePath.endsWith('.wav') ? savePath : `${savePath}.wav`)
          await fs.mkdir(path.dirname(file), { recursive: true })
          await fs.writeFile(file, wav)
          savedTo = file
        }
        return {
          audioUrl: url,
          title: title ?? sfx.params.kind,
          durationMs: Math.round(sfx.durationSec * 1000),
          ref: id,
          message: describeSfx(sfx, { ref: id }) + (savedTo ? `\nSaved to ${savedTo}.` : ''),
        }
      } catch (error) {
        return { message: `sfx_generate: ${(error as Error).message}` }
      }
    },
  })
}
