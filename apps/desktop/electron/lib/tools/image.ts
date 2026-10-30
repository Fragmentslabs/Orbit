import { tool } from 'ai'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'

import { editImage, imageInfo, type ImageEdit } from '../image-ops'
import { deleteMedia, getMediaEntry, listMedia, mediaIdFromUrl, readMedia, saveMedia } from '../media'
import { resolveSafePath, resolveWritePath, type ToolContext } from './context'
import type { DocumentToolScope } from './document'

/**
 * Bridge with chat-engine.
 *
 * `turnMediaUrls` is the live list (it grows on every show_image/image_edit/svg_*)
 * of the images inserted in THIS response. `removeImageParts` takes the corresponding
 * ImagePart out of the conversation — from the message in progress and from the history already
 * written —, otherwise the deleted image would stay broken in the chat.
 *
 * `noteDerived` records that one image was born from another. That is how the
 * runtime does the cleanup at the end of the turn WITHOUT depending on the model
 * remembering to ask: whatever only served as a step toward the next image was a draft.
 */
export interface ImageToolHooks {
  turnMediaUrls: Set<string>
  removeImageParts: (mediaUrls: string[]) => void
  noteDerived: (childUrl: string, parentUrl: string | null, keep: boolean) => void
}

/**
 * Image editing without a generation model.
 *
 * Resizing, cropping, compressing, adjusting tone and removing the background are pixel
 * work, not invention — and treating them as generation would cost a lot, take long
 * and return a SIMILAR image instead of the same one. Here the photo that goes in is the
 * one that comes out, only at the requested size and in the requested way.
 *
 * The output is always a NEW file in the gallery, by the same rule as pdf_ops and
 * docx_edit: the user attached an image, they did not authorize overwriting it.
 * Writing to the working folder only with `savePath`, and only when they ask.
 */

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'tiff', 'heic'])

export function createImageTools(scope: DocumentToolScope, ctx: ToolContext | null, hooks?: ImageToolHooks) {
  /**
   * Resolves the image by gallery or by a path in the working folder.
   *
   * The gallery one covers what the user attached (every image attachment is
   * registered there) and what the agent itself produced before — including the output
   * of this tool, which is how two edits get chained.
   */
  const load = async (ref: string): Promise<{ bytes: Buffer; name: string; id?: string } | string> => {
    const mediaId = mediaIdFromUrl(ref)
    if (mediaId) {
      const entry = await getMediaEntry(mediaId)
      if (entry) {
        const file = await readMedia(mediaId)
        if (!file) return `Image ${ref} is in the registry but its file is gone from disk.`
        return { bytes: file.buffer, name: entry.name || mediaId, id: mediaId }
      }
      if (ref.startsWith('orbit-media://')) return `Image not found in the gallery: ${ref}`
    }
    if (!ctx) {
      return `Image not found: ${ref}. In chat the reference is the orbit-media:// URL of a gallery image.`
    }
    const ext = path.extname(ref).slice(1).toLowerCase()
    if (!IMAGE_EXTENSIONS.has(ext)) {
      return `Does not look like an image: ${ref} (accepted: ${[...IMAGE_EXTENSIONS].join(', ')}).`
    }
    try {
      return { bytes: await fsp.readFile(resolveSafePath(ctx, ref)), name: path.basename(ref) }
    } catch (err) {
      return `Could not open ${ref}: ${(err as Error).message}`
    }
  }

  const bytesLabel = (bytes: number) =>
    bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)}KB` : `${(bytes / (1024 * 1024)).toFixed(1)}MB`

  return {
    image_list: tool({
      description:
        'Lists the images of this conversation with their orbit-media:// references, newest first — what the user attached and what was produced here. This is how you get the reference for an image the user sent: seeing an image in the conversation does NOT give you its reference, and image_info/image_edit need one. An attached photo is in this list even when you can already see it.',
      inputSchema: z.object({
        limit: z.number().int().min(1).max(50).optional().describe('How many to list (default 10)'),
      }),
      execute: async ({ limit }) => {
        const entries = await listMedia({ sessionId: scope.sessionId, kind: 'image' })
        if (entries.length === 0) {
          return 'No images in this conversation yet. The user needs to attach one, or it needs to be produced here.'
        }
        const recent = entries
          .sort((a, b) => b.createdAt - a.createdAt)
          .slice(0, limit ?? 10)
          .map((entry) => {
            const size = entry.width && entry.height ? `${entry.width}x${entry.height}, ` : ''
            const origin = entry.source === 'user' ? 'attached by the user' : 'produced here'
            return `orbit-media://${entry.id} — ${entry.name || 'unnamed'} (${size}${bytesLabel(
              entry.size,
            )}, ${origin})`
          })
        return `${recent.length} image(s):\n${recent.join('\n')}`
      },
    }),

    image_info: tool({
      description:
        'Reads an image WITHOUT editing it: format, dimensions, file size, whether it has transparency, and the dominant colour. Call it before image_edit when the numbers matter — to crop you need the real dimensions. Do NOT feed the dominant colour into removeBackground: it is a binned approximation, and that tool reads the real background off the image border itself. ref: an orbit-media:// URL (attachments and generated images are all in the gallery) or, in code mode, a path in the working folder.',
      inputSchema: z.object({
        ref: z.string().describe('orbit-media:// URL, or a path in the working folder'),
      }),
      execute: async ({ ref }) => {
        const src = await load(ref)
        if (typeof src === 'string') return src
        try {
          const info = await imageInfo(src.bytes)
          return `${src.name}: ${info.format} ${info.width}x${info.height}, ${bytesLabel(
            info.sizeBytes,
          )}, ${info.hasAlpha ? 'with transparency' : 'no transparency'}, dominant colour ${
            info.dominant
          } (approximate).`
        } catch (err) {
          return `Could not read ${src.name}: ${(err as Error).message}`
        }
      },
    }),

    image_edit: tool({
      description:
        'Edits an existing image by pixel processing — no generation model involved, so the photo that goes in is the same one that comes out, only resized/adjusted. Combine as many operations as you need in ONE call; they are applied in a fixed order: EXIF orientation, crop, trim, rotate/flip, background removal, resize, colour, flatten, encode.\n' +
        'Use it for: resizing, cropping, compressing to a size limit (maxBytes), converting format, adjusting brightness/saturation/hue/contrast, greyscale, blur/sharpen, removing a background, and WRITING TEXT on the image (captions, labels, watermarks) — text is drawn last, so it stays sharp and keeps its colour whatever else you did to the photo.\n' +
        'removeBackground spreads from the EDGES of the image, so it only clears background CONNECTED to the border — a white shirt inside the subject survives a white wall being removed. It compares COLOUR rather than brightness, so a lit backdrop that shades from one side to the other still keys cleanly. Both the background colour and the tolerance are MEASURED FROM THE IMAGE: omit them on the first attempt, and correct only if the reported result is wrong — guessing a tolerance is how the subject gets eaten. It handles a flat or nearly flat background (product shot, studio portrait, logo, screenshot); it does NOT separate hair from a busy scene, which needs a segmentation model. The result reports how much was cleared and the threshold used: a very low percentage means it failed, not that the image had little background.\n' +
        'The result is ALWAYS a new image in the gallery, shown in your reply — the original is never overwritten. Pass savePath only when the user asked for the file to be written into the working folder.',
      inputSchema: z.object({
        ref: z.string().describe('orbit-media:// URL, or a path in the working folder'),
        resize: z
          .object({
            width: z.number().int().positive().optional(),
            height: z.number().int().positive().optional(),
            fit: z.enum(['cover', 'contain', 'fill', 'inside', 'outside']).optional()
              .describe('inside (default) fits within the box keeping proportions; cover fills and crops'),
            enlarge: z.boolean().optional().describe('Allow growing past the original size (off by default)'),
            background: z.string().optional().describe('Fill colour when contain leaves gaps, e.g. "#ffffff"'),
          })
          .optional(),
        crop: z
          .object({
            left: z.number().int().min(0),
            top: z.number().int().min(0),
            width: z.number().int().positive(),
            height: z.number().int().positive(),
          })
          .optional()
          .describe('Rectangle in pixels of the image as displayed — call image_info first for the real size'),
        trim: z
          .object({ threshold: z.number().min(0).max(255).optional() })
          .optional()
          .describe('Cuts the uniform border around the image (scan margin, screenshot bar)'),
        rotate: z.number().optional().describe('Degrees, clockwise'),
        flip: z.boolean().optional().describe('Mirror vertically'),
        flop: z.boolean().optional().describe('Mirror horizontally'),
        removeBackground: z
          .object({
            color: z.string().optional()
              .describe('Background colour. OMIT IT: the colour is read from the image border, which is more accurate than a guess. Pass one only when the border is not the background.'),
            tolerance: z.number().min(0).max(100).optional()
              .describe('OMIT IT on the first attempt: measured from the image itself, which is the only place the right value exists. Pass 0-100 only to correct a reported result — higher to clear leftover background, lower if the subject was eaten.'),
            despill: z.boolean().optional()
              .describe('Removes the background colour left clinging to the subject edge. On by default; turn it off only if it is washing out a subject that is genuinely the background colour.'),
            feather: z.number().min(0).max(20).optional()
              .describe('Softens the cut edge, in pixels. 0 (default) is a hard cut; 1-2 looks better on a photo.'),
          })
          .optional(),
        grayscale: z.boolean().optional(),
        negate: z.boolean().optional(),
        brightness: z.number().positive().optional().describe('1 = unchanged, 1.2 = 20% brighter'),
        saturation: z.number().min(0).optional().describe('1 = unchanged, 0 = greyscale, >1 = more vivid'),
        hue: z.number().optional().describe('Colour wheel rotation, in degrees'),
        contrast: z.number().positive().optional().describe('1 = unchanged, applied around mid grey'),
        gamma: z.number().min(1).max(3).optional(),
        normalize: z.boolean().optional().describe('Stretches the histogram — rescues a washed-out photo'),
        blur: z.number().min(0.3).max(100).optional(),
        sharpen: z.boolean().optional(),
        tint: z.string().optional().describe('Tints the image with this colour, e.g. "#1e40af"'),
        flatten: z.string().optional().describe('Flattens transparency onto this colour (required for JPEG)'),
        text: z
          .array(
            z.object({
              content: z.string().describe('The text. Use \\n for a deliberate line break; long text wraps on its own.'),
              position: z
                .enum(['top-left', 'top', 'top-right', 'left', 'center', 'right', 'bottom-left', 'bottom', 'bottom-right'])
                .optional()
                .describe('Where to anchor it (default bottom). Prefer this over x/y — it needs no knowledge of the dimensions.'),
              x: z.number().int().min(0).optional().describe('Exact position in pixels; overrides position'),
              y: z.number().int().min(0).optional(),
              size: z.number().int().min(8).optional()
                .describe('Font height in pixels. Omit it: the default scales with the image, which keeps the same visual weight on a thumbnail and on a poster.'),
              color: z.string().optional().describe('Fill colour, default white'),
              outline: z.string().nullable().optional()
                .describe('Outline colour, dark by default. It is what keeps the text readable over a photo that goes from bright sky to shadow inside one word — pass null only over a flat background.'),
              background: z.string().optional().describe('Band behind the text, for a very busy photo'),
              backgroundOpacity: z.number().min(0).max(1).optional(),
              font: z.string().optional().describe('Font family; falls back to the system sans if absent'),
              align: z.enum(['left', 'center', 'right']).optional(),
              maxWidth: z.number().int().positive().optional()
                .describe('Width in pixels before wrapping; default 90% of the image'),
              opacity: z.number().min(0).max(1).optional().describe('Use ~0.5 for a watermark'),
            }),
          )
          .optional()
          .describe('Text written over the image — captions, labels, watermarks. Several entries land in one pass, which is how you label more than one spot.'),
        format: z.enum(['png', 'jpeg', 'webp']).optional(),
        quality: z.number().int().min(1).max(100).optional().describe('1-100, ignored for PNG'),
        maxBytes: z.number().int().positive().optional()
          .describe('Byte ceiling: lowers quality and then dimensions until it fits'),
        savePath: z.string().optional()
          .describe('Relative path in the working folder to ALSO write the file to — only when the user asked'),
        alt: z.string().optional().describe('Short caption shown under the image in the chat'),
        keep: z
          .boolean()
          .optional()
          .describe(
            'Marks this result as one the user is meant to end up with, not a try. When a reply ends, two kinds of image are discarded: one you edited again (a rung on the ladder), and an earlier attempt at the same thing — two results from the SAME source image in one reply, where only the last survives. That second rule is what keeps a gallery clean when you look at a result and redo it with a different threshold. Pass keep=true on EACH image that must survive anyway: variants for the user to choose from, or a before/after they asked to compare. Without it, redoing an edit costs the user nothing; with it wrongly set, they get a gallery full of attempts.',
          ),
      }),
      execute: async ({ ref, savePath, alt, keep, ...edit }) => {
        const src = await load(ref)
        if (typeof src === 'string') return src

        const requested = Object.entries(edit).filter(([, value]) => value !== undefined)
        if (requested.length === 0) {
          return 'No operation requested — provide at least one (resize, crop, removeBackground, format…).'
        }

        let result
        try {
          result = await editImage(src.bytes, edit as ImageEdit)
        } catch (err) {
          return `Could not edit ${src.name}: ${(err as Error).message}`
        }

        const base = src.name.replace(/\.[^.]+$/, '')
        // An image fetched from the web carries its credit: cropping or writing over it
        // is an adaptation, and the license (CC BY, CC BY-SA) still requires the author.
        const parentCredit = src.id ? (await getMediaEntry(src.id))?.credit : undefined
        const mediaUrl = await saveMedia(result.bytes, result.format === 'jpeg' ? 'jpg' : result.format, {
          source: 'chat',
          sessionId: scope.sessionId,
          name: `${base} (editada)`,
          parentId: src.id,
          ...(parentCredit ? { credit: parentCredit } : {}),
        })
        // Provenance: it is what lets the runtime discard the steps at the end
        // of the turn and the gallery stack the versions instead of scattering them.
        hooks?.noteDerived(mediaUrl, src.id ? `orbit-media://${src.id}` : null, keep === true)

        let savedTo: string | null = null
        if (savePath && ctx) {
          try {
            const target = resolveWritePath(ctx, savePath)
            await fsp.mkdir(path.dirname(target), { recursive: true })
            await fsp.writeFile(target, result.bytes)
            savedTo = savePath
          } catch (err) {
            savedTo = `failed (${(err as Error).message})`
          }
        }

        const notes: string[] = [
          `${result.format} ${result.width}x${result.height}, ${bytesLabel(result.bytes.length)}`,
        ]
        if (result.backgroundRemoved !== undefined) {
          const percent = Math.round(result.backgroundRemoved * 100)
          // The threshold used goes along because it is the starting point for the correction:
          // without it, adjusting the tolerance would be guessing again from scratch.
          const threshold =
            result.backgroundLimit === undefined
              ? ''
              : ` (threshold ${result.backgroundLimit.toFixed(0)} of 100)`
          notes.push(
            `background ${result.backgroundColor} removed from ${percent}% of the image${threshold}${
              percent < 5
                ? ' — almost nothing was removed: check the background colour or raise the tolerance'
                : percent > 97
                  ? ' — almost everything was removed: the tolerance probably ate the subject'
                  : ''
            }`,
          )
        }
        if (result.compression) notes.push(`compression: ${result.compression}`)
        if (savedTo) notes.push(`saved to ${savedTo}`)

        // Same format as show_image: chat-engine turns this into an
        // ImagePart, so the user SEES the result instead of reading about it.
        return {
          mediaUrl,
          alt: alt ?? '',
          message: `${src.name} → ${notes.join(' · ')}. The image is in the reply; the original was not changed.`,
        }
      },
    }),

    image_delete: tool({
      description:
        'Deletes image(s) from the gallery AND from the conversation, including images produced in EARLIER replies of this chat — the cleanup the user asks for when the gallery filled up with steps ("apaga essas imagens antigas"). What it refuses is what the user ATTACHED: their own photo is never yours to delete. It also refuses images belonging to another chat. Steps of a chain you edit again in the same reply are discarded automatically when the reply ends, so the usual reason to call this is a retroactive clean-up, not routine tidying.',
      inputSchema: z.object({
        refs: z
          .array(z.string())
          .min(1)
          .describe('orbit-media:// URLs to delete — use image_list to get them'),
      }),
      execute: async ({ refs }) => {
        const removed: string[] = []
        const notes: string[] = []
        for (const ref of refs) {
          const id = mediaIdFromUrl(ref)
          const entry = id ? await getMediaEntry(id) : null
          if (!id || !entry) {
            notes.push(`${ref}: not found in the gallery`)
            continue
          }
          // The protection lives in the ORIGIN, not in the turn: the user's attachment belongs to them
          // at any moment, and an image the agent produced is still
          // theirs three turns later. Tying the cleanup to the current turn
          // was what made it impossible to tidy up the mess already made.
          if (entry.source === 'user') {
            notes.push(`${ref}: user attachment — cannot be deleted`)
            continue
          }
          if (entry.sessionId && entry.sessionId !== scope.sessionId) {
            notes.push(`${ref}: belongs to another conversation`)
            continue
          }
          if (await deleteMedia(id)) {
            removed.push(ref)
            notes.push(`${ref}: deleted`)
          } else {
            notes.push(`${ref}: failed to delete`)
          }
        }
        if (removed.length > 0) hooks?.removeImageParts(removed)
        return notes.join('\n')
      },
    }),
  }
}
