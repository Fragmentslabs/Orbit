import sharp from 'sharp'
import { probeMedia, runFfmpeg, type MediaProbe } from './ffmpeg'

/**
 * What the agent reads (and what the bubble shows) about an attached video.
 *
 * The note is deliberately short: name, reference and one line of metadata. The
 * video itself does not enter the context — the agent decides, from what the
 * request needs, whether it is worth transcribing, looking at a stretch or
 * bringing the file into a piece. A 30-minute testimony costs the same ~80 words
 * as a 3-second clip.
 */

/** One line with what `ffprobe` says about the file; empty when probing was not possible. */
export function describeVideoFacts(probe: MediaProbe | null): string {
  if (!probe) return 'Could not read the file (it may be corrupt or an unsupported codec).'
  const v = probe.video[0]
  const a = probe.audio[0]
  const parts = [
    `${(probe.durationMs / 1000).toFixed(1)} s`,
    v ? `${probe.display?.width ?? v.width}x${probe.display?.height ?? v.height} @ ${Math.round(v.fps * 100) / 100} fps` : 'no video stream',
    a ? `audio ${a.channels}ch` : 'NO audio',
    `${(probe.sizeBytes / 1e6).toFixed(1)} MB`,
  ]
  return parts.join(', ')
}

/** The attachment note, in English like the other notes the agent receives. */
export function videoAttachmentNote(input: {
  filename: string
  id: string
  file: string
  probe: MediaProbe | null
  /** The attachment was refused (too large, unreadable): the note says why. */
  problem?: string
}): string {
  const head = `[Video attached: ${input.filename || 'unnamed'} — ref ${input.id}]`
  if (input.problem) return `${head}\n(${input.problem})`
  const hasSound = (input.probe?.audio.length ?? 0) > 0
  return [
    head,
    `File: ${input.file} (in this app's attachments)`,
    describeVideoFacts(input.probe),
    '(Attachment, not a user message. It is NOT watched and NOT transcribed: only this description is in your context. ' +
      `Read it when the request needs it, using ref "${input.id}": video_probe for the details, ` +
      (hasSound ? 'transcribe for what is SAID, ' : '') +
      'video_timeline to look at a short window. ' +
      'To use it INSIDE a piece (a clip in a motion composition, its sound, a cut) call motion_asset with this ref — do that only if the request is about using this video.)',
  ].join('\n')
}

/** Probes the file without ever failing: `null` when ffprobe cannot read it. */
export async function probeVideoAttachment(file: string): Promise<MediaProbe | null> {
  try {
    return await probeMedia(file)
  } catch {
    return null
  }
}

/**
 * A frame of the video as a PNG image (up to 480 px wide): it is the item's cover
 * in the gallery. Not frame 0, which is usually black: a little further in, not
 * past the middle. `undefined` when ffmpeg cannot read the file.
 */
export async function videoPosterPng(file: string, durationMs: number): Promise<Buffer | undefined> {
  try {
    const at = Math.min(1, durationMs / 1000 / 2)
    const { stdout } = await runFfmpeg(
      ['-v', 'error', '-ss', at.toFixed(2), '-i', file, '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', 'pipe:1'],
      {},
    )
    if (!stdout.length) return undefined
    return await sharp(stdout).resize({ width: 480, withoutEnlargement: true }).png().toBuffer()
  } catch {
    return undefined
  }
}

/** The cover as a small thumbnail (WebP, up to 320 px) for the chat bubble, as a data URL. */
export async function posterDataUrl(png: Buffer): Promise<string | undefined> {
  try {
    const out = await sharp(png).resize({ width: 320, height: 320, fit: 'inside', withoutEnlargement: true }).webp({ quality: 70 }).toBuffer()
    return `data:image/webp;base64,${out.toString('base64')}`
  } catch {
    return undefined
  }
}

/**
 * The reference of a stored image or GIF, so the agent can use them as
 * material (motion_asset). One line: the image itself follows the usual path
 * (native vision, or describe_image in Vision mode). Empty when the image was
 * not stored.
 */
export function imageRefLine(mediaUrl: string | undefined, filename: string, mime: string): string {
  const id = mediaUrl ? mediaUrl.replace(/^orbit-media:\/\//, '') : ''
  if (!id) return ''
  const kind = mime === 'image/gif' || /\.gif$/i.test(filename) ? 'GIF (animated)' : 'Image'
  return `[${kind} file: ${filename || 'unnamed'} — ref ${id}] (to place it in a motion piece call motion_asset, or in a design canvas design_asset, with this ref; otherwise ignore this line.)`
}
