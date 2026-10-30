import { app } from 'electron'
import { tool } from 'ai'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { saveAudio } from '../audio-store'
import { addVideoToGallery } from '../video/video-gallery'
import { registerVideo } from '../video/store'
import { looksLikeAttachmentRef, resolveAttachmentRef } from '../attachment-ref'
import { compressMedia, type CompressReport } from '../media-compress/compress'
import {
  AUDIO_CONTAINERS,
  VIDEO_CONTAINERS,
  defaultContainer,
  type MediaContainer,
} from '../media-compress/plan'
import { probeMedia } from '../video/ffmpeg'
import { resolveSafePath, type ToolContext } from './context'
import { recordToolWrite } from '../session/write-journal'

/**
 * Video and audio compression for the agent.
 *
 * What the tool delivers is not "an ffmpeg on steroids": it is the answer to a
 * user request ("fit in 25 MB", "make it 720p for WhatsApp") with the
 * file MEASURED once ready. The model states the target; the code decides codec,
 * bitrate, tracks, redoes the encode if it overshoots and reports the before/after.
 *
 * Image does not come in here on purpose: `image_edit` with `maxBytes` already does the
 * same work in a self-measuring way, and two doors for the same thing only
 * confuse the choice.
 *
 * The source is the same as the other media tools — a path in the working
 * folder (code mode) or the `vdo_…`/`aud_…` reference of an attachment. The
 * result is NEVER the source: in code it goes to `media/` next to the file
 * (or to `outputPath`, when the user asks), in the chat it lives in Orbit's
 * storage and appears in the gallery.
 */

const SAFE_SESSION = /^[A-Za-z0-9_-]{1,80}$/
const MEDIA_EXTENSIONS = new Set(['mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'oga', 'opus', 'wma', 'aiff', 'aif', 'webm', 'mp4', 'mov', 'mkv'])

function chatCompressDir(sessionId: string): string {
  if (!SAFE_SESSION.test(sessionId)) throw new Error(`invalid session id: ${sessionId}`)
  return path.join(app.getPath('userData'), 'orbit-data', 'media-compress', sessionId)
}

/** "812 KB", "24.3 MB" — the number the user recognizes. */
export function readableBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 KB'
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function readableDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const m = Math.floor(total / 60)
  const s = String(total % 60).padStart(2, '0')
  return `${m}:${s}`
}

function containerOf(value: string | undefined): MediaContainer | null {
  if (!value) return null
  const clean = value.toLowerCase().replace(/^\./, '') as MediaContainer
  return [...VIDEO_CONTAINERS, ...AUDIO_CONTAINERS].includes(clean) ? clean : null
}

/** A short, concrete report: the model passes this on, it does not invent numbers. */
export function describeReport(report: CompressReport, label: string, savedTo: string | null): string {
  const { before, after, plan } = report
  if (report.skipped) {
    return (
      `${label} is ${readableBytes(before.sizeBytes)}, already within the requested limit — nothing was re-encoded. ` +
      'Only call it again with force: true (or a smaller target) if the user really wants a new encode.'
    )
  }
  const delta = before.sizeBytes > 0 ? Math.round((1 - after.sizeBytes / before.sizeBytes) * 100) : 0
  const res: string[] = []
  const beforeDims = before.display ? `${before.display.width}x${before.display.height}` : null
  const afterDims = after.display ? `${after.display.width}x${after.display.height}` : null
  if (beforeDims || afterDims) res.push(`${beforeDims ?? '?'} → ${afterDims ?? '?'}`)

  const videoStream = `${plan.videoCodec} ${plan.crf !== null ? `crf ${plan.crf}` : `${plan.bitrate} kbps`}`
  const audioStream = plan.stripAudio ? 'no audio' : `${plan.audioCodec} ${plan.audioBitrate} kbps`
  const output = plan.kind === 'video' ? `video ${plan.container} · ${videoStream} · ${audioStream}` : `audio ${plan.container} · ${plan.audioCodec} ${plan.audioBitrate} kbps`

  const lines = [
    `Compressed ${label}: ${readableBytes(before.sizeBytes)} → ${readableBytes(after.sizeBytes)} (${delta >= 0 ? '−' : '+'}${Math.abs(delta)}%)` +
      `${res.length ? `, ${res.join(', ')}` : ''}, ${readableDuration(before.durationMs)} → ${readableDuration(after.durationMs)}, ` +
      `${report.attempts} encode(s) in ${(report.encodeMs / 1000).toFixed(1)} s.`,
    `Output: ${output}.`,
  ]
  if (savedTo) lines.push(`File: ${savedTo}.`)
  if (report.notes.length) lines.push(`Notes: ${report.notes.join('; ')}.`)
  if (!report.withinTarget) {
    lines.push('The byte target was NOT met — say so plainly and offer to lower the resolution or the duration.')
  }
  return lines.join('\n')
}

export function createMediaTools(
  scope: { sessionId: string; canShow: boolean },
  ctx: ToolContext | null,
) {
  /**
   * Source: a chat attachment (`vdo_…`, `aud_…`) or, in code, a file from the
   * working folder. Image is refused with the right path — `image_edit`.
   */
  const resolveInput = async (ref: string): Promise<{ file: string; label: string; attachment: boolean }> => {
    const clean = ref.trim()
    if (looksLikeAttachmentRef(clean)) {
      if (/^img_/i.test(clean)) {
        throw new Error(`${clean} is an image — compress images with image_edit (maxBytes), not media_compress`)
      }
      const attachment = await resolveAttachmentRef(clean)
      if (!attachment) throw new Error(`attachment not found: ${clean} — use the ref from the attachment note`)
      if (attachment.kind === 'image') {
        throw new Error(`${clean} is an image — compress images with image_edit (maxBytes), not media_compress`)
      }
      return { file: attachment.file, label: attachment.name || attachment.id, attachment: true }
    }
    if (!ctx) {
      throw new Error(
        `Invalid reference: ${clean}. In chat the source is the vdo_…/aud_… reference of an attachment (there is no working folder).`,
      )
    }
    const file = resolveSafePath(ctx, clean)
    const ext = path.extname(file).slice(1).toLowerCase()
    if (!MEDIA_EXTENSIONS.has(ext)) {
      throw new Error(`${clean} does not look like an audio or video file (${[...MEDIA_EXTENSIONS].join(', ')})`)
    }
    return { file, label: clean, attachment: false }
  }

  return {
    media_compress: tool({
      description:
        'Compresses or converts an audio or video file to a size or quality target, then MEASURES the result (never trusts the encoder). ' +
        'Use it for "get it under 25 MB", "compress this video", "convert to mp3", "extract the audio", "in 720p" — in any language. ' +
        'Targets, in order of precedence: maxBytes (a hard ceiling — the tool computes the bitrate, encodes, measures and retries up to 3 times if it overshoots), ' +
        'bitrate (kbps), or quality (1-100, CRF-like; 75 is a good default when nothing is specified). height/fps only ever downscale. ' +
        'Do NOT use it for images: image_edit with maxBytes already compresses, resizes and converts them. ' +
        'The source is never modified: in code mode the result goes to media/ next to the file (or outputPath), in chat it goes to the gallery and appears in your reply. ' +
        'The result reports before/after size, resolution, duration, encoder settings and any caveat (10-bit source, target below what is possible) — relay those numbers as they are.',
      inputSchema: z.object({
        ref: z
          .string()
          .describe('vdo_…/aud_… reference of an attachment, or (code mode) a path in the working folder'),
        maxBytes: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Hard ceiling for the output in bytes (e.g. 25 * 1024 * 1024 for 25 MB).'),
        quality: z
          .number()
          .min(1)
          .max(100)
          .optional()
          .describe('1-100, CRF-like — 100 keeps almost everything, 50 is visibly softer, 25 is rough. Default 75.'),
        bitrate: z.number().positive().optional().describe('Target bitrate in kbps for the main stream (video in a video container, audio otherwise).'),
        height: z.number().int().positive().optional().describe('Output height in pixels (720, 1080…). Never upscales.'),
        fps: z.number().positive().optional().describe('Output fps. Never upscales the frame rate.'),
        format: z
          .enum(['mp4', 'mov', 'webm', 'mkv', 'm4a', 'mp3', 'opus', 'ogg'])
          .optional()
          .describe('Output container. An audio container on a video extracts the audio. Default: keeps the source family.'),
        codec: z
          .enum(['h264', 'hevc', 'av1', 'vp9', 'aac', 'mp3', 'opus'])
          .optional()
          .describe('Override the container default. h264 is the most compatible; hevc/av1 are smaller at the same quality but slower to encode.'),
        stripAudio: z.boolean().optional().describe('Drop the audio track (video only).'),
        audioBitrate: z.number().positive().optional().describe('Audio bitrate in kbps when the audio is kept.'),
        preset: z
          .enum(['fast', 'balanced', 'slow'])
          .optional()
          .describe('Encoder speed vs. quality trade-off. Default balanced.'),
        force: z.boolean().optional().describe('Re-encode even when the file already fits the target.'),
        ...(ctx
          ? {
              outputPath: z
                .string()
                .optional()
                .describe('Where to write the result, relative to the working folder. Default: media/<name>-compressed.<ext> next to the source.'),
            }
          : {}),
      }),
      execute: async (input, { abortSignal }) => {
        const { file, label, attachment } = await resolveInput(input.ref)

        const outputPath = (input as { outputPath?: string }).outputPath
        // The container decides the file's EXTENSION, so it has to exist before
        // the encode. With no format requested, it follows the source's family — the same
        // `defaultContainer` the plan would use, with one extra ffprobe.
        const probe = await probeMedia(file)
        const container: MediaContainer =
          containerOf(input.format) ??
          (outputPath ? containerOf(path.extname(outputPath)) : null) ??
          defaultContainer(probe, probe.video.length ? 'video' : 'audio')

        const base = path.basename(file, path.extname(file)).replace(/[^\w.-]+/g, '-').slice(0, 60) || 'media'
        let output: string
        if (outputPath && ctx) {
          const wanted = resolveSafePath(ctx, outputPath)
          const wantedExt = path.extname(wanted).slice(1).toLowerCase()
          output = wantedExt === container ? wanted : `${wanted.slice(0, wanted.length - (wantedExt ? wantedExt.length + 1 : 0))}.${container}`
        } else if (ctx) {
          // Next to the file when it is in the project; in the working folder
          // when the source is an attachment (which lives in the app's storage).
          const folder = attachment ? ctx.directory : path.dirname(file)
          output = path.join(folder, 'media', `${base}-compressed.${container}`)
        } else {
          output = path.join(chatCompressDir(scope.sessionId), `${base}-${randomBytes(3).toString('hex')}.${container}`)
        }
        // In code the result lands in the working folder: it is a write of the turn.
        if (ctx) recordToolWrite(output)

        const report = await compressMedia({
          file,
          output,
          target: {
            maxBytes: input.maxBytes,
            quality: input.quality,
            bitrate: input.bitrate,
            height: input.height,
            fps: input.fps,
          },
          format: container,
          codec: input.codec,
          stripAudio: input.stripAudio,
          audioBitrate: input.audioBitrate,
          preset: input.preset,
          force: input.force,
          signal: abortSignal,
        })

        if (report.skipped) {
          return describeReport(report, label, null)
        }

        // Path as the user sees it: relative to the working folder in code.
        const shown = ctx ? path.relative(ctx.directory, report.output) || report.output : report.output

        const title = path.basename(report.output)
        const durationMs = report.after.durationMs

        if (report.kind === 'video') {
          if (!scope.canShow) return describeReport(report, label, shown)
          if (ctx) {
            // In code the file belongs to the user and stays where it is: it is only registered
            // to play in the response (as video_render does).
            const { url } = await registerVideo(report.output, scope.sessionId)
            return {
              videoUrl: url,
              title,
              durationMs,
              path: report.output,
              message: describeReport(report, label, shown),
            }
          }
          const { entry } = await addVideoToGallery({
            file: report.output,
            name: title,
            sessionId: scope.sessionId,
            source: 'chat',
          })
          return {
            videoUrl: entry.videoUrl,
            title,
            durationMs,
            path: report.output,
            message: describeReport(report, label, 'the chat media (visible in your reply)'),
          }
        }

        if (!scope.canShow) return describeReport(report, label, shown)
        // Audio: in the chat the compact copy goes to the collection (it is the one that appears
        // in the gallery and in the player); in code the project file is enough.
        if (ctx) return describeReport(report, label, shown)
        const bytes = await fs.readFile(report.output)
        const ext = path.extname(report.output).slice(1).toLowerCase()
        const saved = await saveAudio(bytes, ext, { sessionId: scope.sessionId, name: title, source: 'chat' })
        await fs.rm(report.output, { force: true })
        return {
          audioUrl: saved.url,
          title,
          durationMs,
          message: describeReport(report, label, 'the chat media (visible in your reply)'),
        }
      },
    }),
  }
}
