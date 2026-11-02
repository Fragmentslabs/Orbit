import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { resolveAttachmentRef, type AttachmentKind, type ResolvedAttachment } from '../attachment-ref'
import { describeVideoFacts } from './attachment-note'
import { probeMedia } from './ffmpeg'
import { copyWordsSidecar, readWordsSidecar, WORDS_SUFFIX } from './motion-words'

/**
 * Bringing an ATTACHMENT from the chat into a piece: the video the user sent,
 * the photo, the GIF, the audio. It is the bridge between "the agent has a reference" and "the
 * file sits next to index.html, where the piece sees it".
 *
 * The agent only calls this when it decides to USE the material — attaching copies nothing
 * into any piece. And the reference is the only input: the source path never
 * comes from the agent, only from the attachment the reference names.
 */

/** Safe name for a file inside the piece's folder (no separators, no spaces). */
export function assetFileName(wanted: string | undefined, original: string, fallbackExt: string): string {
  const source = path.basename((wanted?.trim() || original || '').replace(/\\/g, '/'))
  const ext = (path.extname(source) || path.extname(original) || fallbackExt).toLowerCase()
  const stem = path
    .basename(source, path.extname(source))
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 48)
  return `${stem || 'asset'}${ext}`
}

/** A name that does not step on another file in the folder; the same content reuses the name. */
async function freeName(folder: string, name: string, size: number): Promise<{ name: string; reuse: boolean }> {
  const ext = path.extname(name)
  const stem = path.basename(name, ext)
  for (let i = 1; i < 100; i++) {
    const candidate = i === 1 ? name : `${stem}-${i}${ext}`
    const existing = await fsp.stat(path.join(folder, candidate)).catch(() => null)
    if (!existing) return { name: candidate, reuse: false }
    if (existing.isFile() && existing.size === size) return { name: candidate, reuse: true }
  }
  throw new Error(`too many files named ${name} in the folder`)
}

export interface ImportedAsset {
  /** `file`: not media (a script, a font) — it came from the working folder. */
  kind: AttachmentKind | 'file'
  /** File name inside the folder — it is what goes into the HTML `src`. */
  name: string
  file: string
  /** The text the agent reads: what was copied, and how to use it in the piece. */
  report: string
}

/** How to use each type inside a composition, in a few lines. */
function usage(kind: AttachmentKind, name: string, isGif: boolean, hasSound: boolean): string {
  if (kind === 'video') {
    return (
      `Use: <video src="${name}"></video> — style it with CSS (position, size, object-fit, object-view-box to crop). ` +
      'Timing in seconds on the piece: data-start (when it begins), data-in (where in the file), data-end (when it stops). ' +
      (hasSound
        ? 'Its sound is MIXED into the render unless you add the muted attribute (or data-audio="false"); lower it with data-gain="-6" under a narration.'
        : 'It has no audio stream, so there is no sound to manage.')
    )
  }
  if (kind === 'audio') {
    return `Use: declare it in audio.json next to index.html — { "tracks": [{ "file": "${name}", "start": 0 }] } (add it to the existing tracks if the manifest already exists; fields: start/end, gain, fadeIn/fadeOut, duck, preset, eq…).`
  }
  return isGif
    ? `Use: <img src="${name}"> — the GIF is decoded into frames, so it is deterministic. data-start (seconds on the piece) sets when it starts, data-loop="false" holds the last frame.`
    : `Use: <img src="${name}"> — style it with CSS; object-view-box crops it.`
}

/**
 * Copies the attachment of the reference into `folder` and returns the report. Idempotent: the
 * same attachment twice gives the same file, without duplicating. `usageNote` swaps the
 * usage line (design_asset talks about artboard; in here it is piece language).
 */
export async function importAttachmentInto(
  folder: string,
  ref: string,
  wantedName?: string,
  opts: { usageNote?: string | ((kind: AttachmentKind, name: string) => string) } = {},
): Promise<ImportedAsset> {
  const resolved: ResolvedAttachment | null = await resolveAttachmentRef(ref)
  if (!resolved) {
    throw new Error(
      `attachment not found: ${ref}. Use the ref from the attachment note (vdo_…, aud_… or img_…) — it must belong to this app's attachments.`,
    )
  }
  return importSourceInto(folder, resolved, wantedName, opts)
}

const VIDEO_EXT = /\.(mp4|mov|webm|m4v|mkv)$/i
const AUDIO_EXT = /\.(mp3|wav|m4a|aac|ogg|oga|opus|flac)$/i
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|avif)$/i

/**
 * Copies a file from the WORKING FOLDER (code mode) into the piece: the
 * project's photo, the footage, a local library (gsap.min.js), a
 * font. The path already comes resolved and authorized by the caller; the type comes from the
 * extension, and what is not media goes in as an ordinary file.
 */
export async function importFileInto(
  folder: string,
  file: string,
  wantedName?: string,
  opts: { usageNote?: string | ((kind: AttachmentKind, name: string) => string) } = {},
): Promise<ImportedAsset> {
  const stat = await fsp.stat(file).catch(() => null)
  if (!stat?.isFile()) throw new Error(`not a file: ${file}`)
  const kind: AttachmentKind | 'file' = VIDEO_EXT.test(file) ? 'video' : AUDIO_EXT.test(file) ? 'audio' : IMAGE_EXT.test(file) ? 'image' : 'file'
  if (kind === 'file') {
    const name = assetFileName(wantedName, path.basename(file), path.extname(file))
    await fsp.mkdir(folder, { recursive: true })
    const { name: free, reuse } = await freeName(folder, name, stat.size)
    const target = path.join(folder, free)
    if (!reuse) await fsp.copyFile(file, target, fs.constants.COPYFILE_FICLONE)
    return {
      kind: 'file',
      name: free,
      file: target,
      report: `${reuse ? 'Already in the folder' : 'Copied'}: "${path.basename(file)}" → ${free}. Reference it by RELATIVE path (e.g. <script src="${free}"></script>, url("${free}")).`,
    }
  }
  return importSourceInto(folder, { kind, id: path.basename(file), file, name: path.basename(file) }, wantedName, opts)
}

async function importSourceInto(
  folder: string,
  resolved: ResolvedAttachment,
  wantedName: string | undefined,
  opts: { usageNote?: string | ((kind: AttachmentKind, name: string) => string) },
): Promise<ImportedAsset> {
  const stat = await fsp.stat(resolved.file)
  const fallbackExt = path.extname(resolved.file) || ''
  const wanted = assetFileName(wantedName, resolved.name, fallbackExt)
  await fsp.mkdir(folder, { recursive: true })
  const { name, reuse } = await freeName(folder, wanted, stat.size)
  const target = path.join(folder, name)
  if (!reuse) await fsp.copyFile(resolved.file, target, fs.constants.COPYFILE_FICLONE)

  let facts = ''
  let hasSound = false
  if (resolved.kind === 'video' || resolved.kind === 'audio') {
    try {
      const probe = await probeMedia(target)
      hasSound = probe.audio.length > 0
      facts = describeVideoFacts(probe)
    } catch {
      facts = 'could not read the file'
    }
  }
  // A voice generated with timings carries the time of each word: it travels with the audio.
  let wordsNote = ''
  if (resolved.kind === 'audio') {
    const has = (await copyWordsSidecar(resolved.file, target)) || (await readWordsSidecar(target)) !== null
    wordsNote = has
      ? `Word times: ${name}${WORDS_SUFFIX} sits next to it — once the track is in audio.json, orbitMotion.audio.words() / lines() / find() give every word on the PIECE clock (see video_guide("motion"), "Text in sync with the voice"). Do not type the times into the HTML.`
      : `No word times for this audio. Text that follows it (karaoke, lyrics, captions per word) needs them: call motion_asset again with words: true (needs Speech to text on) — do not estimate them.`
  }
  const isGif = resolved.kind === 'image' && path.extname(name).toLowerCase() === '.gif'
  const label = isGif ? 'GIF' : resolved.kind
  return {
    kind: resolved.kind,
    name,
    file: target,
    report: [
      `${reuse ? 'Already in the folder' : 'Copied'}: ${label} "${resolved.name}" → ${name}${facts ? ` (${facts})` : ''}.`,
      typeof opts.usageNote === 'function' ? opts.usageNote(resolved.kind, name) : (opts.usageNote ?? usage(resolved.kind, name, isGif, hasSound)),
      wordsNote,
      // The license usually requires the credit next to the image: it travels with it into the piece.
      resolved.credit
        ? `CREDIT REQUIRED by the license (${resolved.credit.license}) — show it in the piece (a caption, or a credits card at the end): ${resolved.credit.attribution}`
        : '',
    ]
      .filter(Boolean)
      .join('\n'),
  }
}
