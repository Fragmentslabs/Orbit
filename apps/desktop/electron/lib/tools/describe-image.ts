import { tool } from 'ai'
import sharp from 'sharp'
import { z } from 'zod'
import type { SendMessageInput } from '@shared/chat'
import { describeImage, getTurnImages } from '../vision'
import { mediaIdFromUrl, readMedia } from '../media'

/**
 * Vision mode (agent-driven): the agent decides when and how to look at an image —
 * a general description (no focus) or specific questions with the conversation's
 * context embedded in the focus. The image never enters the main model's
 * context.
 *
 * It reaches the turn's attachment (ephemeral registry, cleaned in runChat's finally) and
 * any image in the gallery. The second source is what makes it possible to look
 * BEFORE editing: without it, the agent would only see the photo in the message in which
 * it arrived, and a "now write on the jacket" in the next turn would be done in
 * the dark.
 *
 * The description of a turn attachment is persisted in the history by chat-engine
 * (tool-result hook), so future turns see it as text.
 */
/**
 * The requested image, as a data URL — from the turn or from the gallery.
 *
 * The numeric `ref` and the orbit-media:// URL coexist because they cover different
 * moments: the number is the attachment that arrived NOW (and that is not kept
 * anywhere after the turn), the URL is everything else. Returning null instead of
 * throwing leaves the error message to the caller, which knows which of the two forms
 * was tried.
 */
async function resolveImage(sessionId: string, ref: number | string): Promise<string | null> {
  if (typeof ref === 'number') {
    return getTurnImages(sessionId)?.[ref - 1]?.url ?? null
  }
  // A number in text form is still the turn's attachment: the model
  // gets this form wrong often, and refusing would be pedantry.
  if (/^\d+$/.test(ref.trim())) {
    return getTurnImages(sessionId)?.[Number(ref.trim()) - 1]?.url ?? null
  }
  const id = mediaIdFromUrl(ref)
  if (!id) return null
  const file = await readMedia(id)
  if (!file) return null

  // SVG is text, not an image, and no vision model accepts it: sending it
  // raw returns a provider error instead of a description. Rasterizing is what
  // allows LOOKING at a vector — and it is a frequent request, because checking whether a
  // path came out good is precisely a visual question.
  if (file.contentType === 'image/svg+xml') {
    const png = await sharp(file.buffer)
      .resize({ width: 1024, withoutEnlargement: false })
      .png()
      .toBuffer()
    return `data:image/png;base64,${png.toString('base64')}`
  }
  return `data:${file.contentType};base64,${file.buffer.toString('base64')}`
}

export function createDescribeImageTool(input: SendMessageInput) {
  return tool({
    description:
      'Describes an image using the configured vision model (Vision mode). The image itself never enters your context — this tool is the only way to see it, so call it whenever an image is relevant to the task; you can call it multiple times with different focus questions.\n' +
      'ref: either the #N of an image attached to the CURRENT message (from the "[Image attached ... ref #N]" placeholder), or an orbit-media:// URL from image_list — which is how you look at an image from an earlier turn, or at the result of an edit you just made.\n' +
      'focus: what you need to know about the image (layout, colors, texts, specific elements, state...). The vision model sees ONLY the image and this focus — never the conversation. So when the task depends on earlier context (instructions, preferences, what was built so far), COMPLEMENT the focus with the necessary context so the description answers the real question instead of being generic. Omit focus when a general description is enough.',
    inputSchema: z.object({
      ref: z
        .union([z.number().int().min(1), z.string()])
        .describe('The #N of an image in the current message (1 = first), or an orbit-media:// URL from image_list'),
      focus: z
        .string()
        .optional()
        .describe('What you need to know about the image. The vision model does not see the conversation — include relevant context here when the answer depends on it. Omit for a general description.'),
    }),
    execute: async ({ ref, focus }) => {
      // Two sources, because the turn's attachment disappears at its end: the image that
      // just arrived lives in the registry, and any other — from a previous
      // turn, or the result of an edit — lives in the gallery. Without the
      // second, looking before editing would only work in the first message.
      const image = await resolveImage(input.sessionId, ref)
      if (!image) {
        throw new Error(
          typeof ref === 'number'
            ? `Image #${ref} is not available: that number only applies to images attached in the current turn. ` +
              'Use image_list to get the orbit-media:// URL of the image you want to see.'
            : `Image not found: ${ref}. Use image_list to see the references in this conversation.`,
        )
      }
      const desc = await describeImage({
        model: input.visionModel!,
        imageDataUrl: image,
        language: input.language,
        focus: focus ?? input.text,
      })
      if (!desc) {
        throw new Error('The configured vision model failed to describe the image — try again or tell the user.')
      }
      return desc
    },
  })
}
