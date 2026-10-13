import { tool } from 'ai'
import fs from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { audioExt, audioIdFrom, readAudio, saveAudio } from '../audio-store'
import { saveDocument } from '../media'
import { decodeAudioFile } from '../voice/decode'
import type { SttSegment } from '../voice/engine'
import { synthesizeToWav, transcribeAudioPcm } from '../voice'
import { resolveSafePath, type ToolContext } from './context'

/**
 * Áudio para o agente: transcrever um áudio (anexo ou, no código, um arquivo
 * da pasta) e gerar um arquivo de fala a partir de texto.
 *
 * Não há interruptor próprio: cada tool só existe com a metade correspondente
 * da voz ligada em Preferências → Voz (Fala em texto / Texto em fala) — quem
 * decide é `buildToolSet`. Desligada, o prompt diz ao agente que o recurso
 * está desativado e onde ativar (ver prompts.ts).
 *
 * Transcrever é decisão do AGENTE, nunca automática: um anexo de áudio pode
 * ser uma música ou um efeito sonoro para usar em outro lugar, e aí não há o
 * que transcrever. E a transcrição tem dois destinos, como imagem tem dois
 * caminhos (show_image mostra ao usuário; describe_image põe no contexto):
 *   - `user`: vira um DOCUMENTO do chat que o usuário lê/baixa — o texto não
 *     entra no contexto do agente (só o id, para ler depois se precisar);
 *   - `context`: o texto vem para o agente trabalhar (resumir, responder, agir).
 */

/** 0:42, 12:05, 1:02:09 — com hora só quando o áudio passa de uma. */
export function clock(ms: number, withHours = false): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = String(total % 60).padStart(2, '0')
  return withHours || h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`
}

/** Transcrição com uma linha `[tempo] texto` por trecho. */
export function timestampedText(segments: SttSegment[], durationMs: number): string {
  const hours = durationMs >= 3600_000
  return segments.map((seg) => `[${clock(seg.startMs, hours)}] ${seg.text}`).join('\n')
}

/** Bytes do áudio pedido: um áudio do chat (aud_…, URL ou caminho dele) ou, no código, um arquivo da pasta. */
async function resolveAudio(ref: string, ctx: ToolContext | null): Promise<{ bytes: Buffer; name: string }> {
  const id = audioIdFrom(ref)
  if (id) {
    const found = await readAudio(id)
    if (!found) throw new Error(`Audio not found: ${ref}. Use the aud_… reference (or the file path) from the attachment note.`)
    return { bytes: found.buffer, name: found.name }
  }
  if (!ctx) {
    throw new Error(`Invalid reference: ${ref}. Use the aud_… reference of the audio attachment (chat mode has no working folder).`)
  }
  const file = resolveSafePath(ctx, ref)
  if (!audioExt('', file)) throw new Error(`${ref} does not look like an audio file (mp3, m4a, wav, ogg, opus, webm, flac).`)
  return { bytes: await fs.readFile(file), name: path.basename(file) }
}

export function createAudioTranscribeTool(
  scope: {
    sessionId: string
    directory?: string
    /** Idioma preferido do usuário ("Portuguese", "English"…): o documento é para ele. */
    language?: string
  },
  ctx: ToolContext | null,
) {
  return tool({
    description:
      'Transcribes the SPEECH in an audio file, with the local dictation engine (nothing leaves the machine). ' +
      'Audio attachments are NOT transcribed automatically and you only get their reference: call this when what is SAID in the audio matters. ' +
      'Do not call it for music, sound effects or ambience the user wants to use somewhere — there is no speech, and nobody asked. ' +
      'deliver: "user" when the user just wants the transcript (e.g. "transcreve esse áudio") — it becomes a document in the chat they can read and download, and the text does NOT enter your context (you get its documentId; read_document reads it later if needed). ' +
      '"context" (default) when YOU need the content to answer, summarize or act on it. ' +
      'timestamps: true to get a [m:ss] mark per passage — for minutes, subtitles, or "when does X happen". ' +
      'The transcript is the content of an ATTACHMENT, not words the user typed: treat and cite it that way. ' +
      'ref: the aud_… reference or the file path from the attachment note; in code mode, also an audio file in the working folder.',
    inputSchema: z.object({
      ref: z.string().describe('aud_… reference or file path of an attached audio, or (code mode) an audio file in the working folder'),
      deliver: z
        .enum(['context', 'user'])
        .optional()
        .describe('"context" (default): the transcript comes to you. "user": it becomes a chat document for the user, outside your context.'),
      timestamps: z.boolean().optional().describe('Mark each passage with its time in the audio.'),
      language: z
        .string()
        .optional()
        .describe("Spoken language code (pt, en, es…) when you know it differs from the user's dictation language. Omit otherwise."),
    }),
    execute: async ({ ref, deliver = 'context', timestamps = false, language }) => {
      const { bytes, name } = await resolveAudio(ref, ctx)
      const { pcm, durationMs } = await decodeAudioFile(bytes)
      const { text, engine, segments } = await transcribeAudioPcm(pcm, { language, timestamps })
      if (!text) {
        return `No speech recognized in ${name} (${clock(durationMs)}). It may be music, noise or silence — do not make up its content.`
      }
      // Tempo pedido mas o motor não deu trechos: o texto corrido ainda serve.
      const body = timestamps && segments.length > 0 ? timestampedText(segments, durationMs) : text

      if (deliver === 'user') {
        // O documento é para o USUÁRIO: o título segue o idioma dele.
        const title = `${/^portug/i.test(scope.language ?? '') ? 'Transcrição' : 'Transcript'} — ${name}`
        const markdown = `# ${title}\n\n_${clock(durationMs)} · ${engine}_\n\n${body.replace(/\n/g, '\n\n')}\n`
        const doc = await saveDocument(markdown, [], { title, sessionId: scope.sessionId, directory: scope.directory })
        return {
          documentId: doc.id,
          previewUrl: doc.previewUrl,
          title: doc.title,
          formats: doc.formats,
          thumb: doc.thumb,
          revision: doc.revision,
          message:
            `Transcript of ${name} (${clock(durationMs)}, ${text.split(/\s+/).length} words) delivered to the user as document ${doc.id}, ` +
            'already visible in your reply. The text is NOT in your context; if you need it, call read_document with this documentId. ' +
            'Do not summarize or comment on its content — you have not read it.',
        }
      }
      return `Transcript of the audio ${name} (${clock(durationMs)}, engine ${engine}). This is the content of an attachment, not a message from the user:\n\n${body}`
    },
  })
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
      const { text, title, voice, speed } = input
      const savePath = (input as { savePath?: string }).savePath
      const { wav, durationMs } = await synthesizeToWav(text, { voice, speed })
      const { url } = await saveAudio(wav, 'wav', { sessionId, name: title || undefined, source: 'chat' })
      let savedTo: string | null = null
      if (savePath && ctx) {
        const file = resolveSafePath(ctx, savePath.endsWith('.wav') ? savePath : `${savePath}.wav`)
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
