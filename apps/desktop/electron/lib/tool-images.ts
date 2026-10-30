import type { ModelMessage } from 'ai'

/**
 * Images returned by a tool do not reach the model in every provider.
 *
 * The `openai-compatible` adapter — the path of any gateway — assembles the
 * tool message with `JSON.stringify` of the output: an image in the result becomes
 * base64 inside a string, which the model reads as text and nobody sees.
 * That is how `see_screen` "sent" the screen and the model answered that it was not
 * receiving an image. The same holds for any tool that returns an image
 * (`panel_screenshot`, `pdf_view_page`, video frames…).
 *
 * Way out: the image leaves the tool's result and becomes a USER message right
 * after it — every adapter converts a user image into `image_url`, which is
 * real vision. The result stays as text, pointing to where the image is.
 */
export const HOISTED_IMAGE_NOTE =
  '[The image this tool captured is attached in the user message right after it.]'

export interface HoistResult {
  /** The original list when nothing changed; a new one when there was an image. */
  messages: ModelMessage[]
  images: number
}

interface PendingImage {
  data: string
  mediaType: string
}

/**
 * Moves the images from tool results into a user message.
 *
 * Idempotent: after the first pass the result is already text (without
 * `image-data`), so calling again adds no message at all.
 */
export function hoistToolImages(messages: ModelMessage[]): HoistResult {
  const images: PendingImage[] = []
  let changed = false

  const next = messages.map((message) => {
    if (message.role !== 'tool') return message
    let touched = false
    const content = message.content.map((part) => {
      if (part.type !== 'tool-result') return part
      const output = part.output
      if (output.type !== 'content') return part
      const imageParts = output.value.filter(
        (value): value is { type: 'image-data'; data: string; mediaType: string } =>
          value.type === 'image-data',
      )
      if (imageParts.length === 0) return part

      touched = true
      for (const image of imageParts) images.push({ data: image.data, mediaType: image.mediaType })
      const text = output.value
        .filter((value): value is { type: 'text'; text: string } => value.type === 'text')
        .map((value) => value.text)
        .join('\n')
      return {
        ...part,
        output: {
          type: 'text' as const,
          value: text ? `${text}\n${HOISTED_IMAGE_NOTE}` : HOISTED_IMAGE_NOTE,
        },
      }
    })
    if (!touched) return message
    changed = true
    return { ...message, content }
  })

  if (!changed) return { messages, images: 0 }

  return {
    messages: [
      ...next,
      {
        role: 'user',
        content: [
          { type: 'text', text: '[Image captured by the tool in the previous message]' },
          ...images.map((image) => ({ type: 'file' as const, data: image.data, mediaType: image.mediaType })),
        ],
      },
    ],
    images: images.length,
  }
}
