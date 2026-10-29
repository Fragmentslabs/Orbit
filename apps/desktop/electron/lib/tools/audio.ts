import { tool } from 'ai'
import fs from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { saveAudio } from '../audio-store'
import { synthesizeToWav } from '../voice'
import { resolveWritePath, type ToolContext } from './context'

/**
 * Texto em fala: um arquivo de áudio do texto pedido, na voz configurada.
 *
 * O caminho inverso (fala em texto) não mora aqui: `transcribe` — em
 * tools/video.ts — é a ÚNICA tool de transcrição, para áudio e vídeo, com o
 * detalhe que o chamador pedir (texto, frases ou palavra por palavra).
 *
 * Sem interruptor próprio: a tool só existe com "Texto em fala" ligado em
 * Preferências → Voz — quem decide é `buildToolSet`. Desligada, o prompt diz
 * ao agente que o recurso está desativado e onde ativar (ver prompts.ts).
 */

/** 0:42, 12:05, 1:02:09 — com hora só quando o áudio passa de uma. */
export function clock(ms: number, withHours = false): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = String(total % 60).padStart(2, '0')
  return withHours || h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`
}

export function createAudioGenerateTool(sessionId: string, ctx: ToolContext | null) {
  return tool({
    description:
      'Creates an audio file of the given text being spoken (text-to-speech), with the voice configured in Settings → Voice. ' +
      'Use it when the user asks for an audio/voice version of something — a narration, a voice message, a pronunciation. ' +
      'The audio appears in your reply as a player and in the chat media; do not repeat the whole text after it, just say what it is. ' +
      'Write the text exactly as it should be SPOKEN: no Markdown, lists or URLs; numbers and symbols the way they are said.',
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
      const { text, title, voice, speed, lang } = input
      const savePath = (input as { savePath?: string }).savePath
      // O idioma é o do TEXTO que o agente escreveu, não o fixo das preferências:
      // pedir "gere em inglês" com a leitura em português tem que sair em inglês.
      const { wav, durationMs } = await synthesizeToWav(text, { voice, speed, lang: lang ?? 'auto' })
      const { url } = await saveAudio(wav, 'wav', { sessionId, name: title || undefined, source: 'chat' })
      let savedTo: string | null = null
      if (savePath && ctx) {
        const file = resolveWritePath(ctx, savePath.endsWith('.wav') ? savePath : `${savePath}.wav`)
        await fs.mkdir(path.dirname(file), { recursive: true })
        await fs.writeFile(file, wav)
        savedTo = file
      }
      return {
        audioUrl: url,
        title: title ?? '',
        durationMs,
        message:
          `Audio generated (${clock(durationMs)}) and shown in your reply as a player; it is also in the chat media.` +
          (savedTo ? ` Saved to ${savedTo}.` : ''),
      }
    },
  })
}
