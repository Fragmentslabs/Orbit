import { generateText } from 'ai'
import type { WorkerModelConfig } from '@shared/chat'
import { resolveModel } from './providers'

/**
 * Delegated vision: describes an image (data URL) with a vision model and
 * returns the text — the main model (without vision) receives the description in
 * place of the image, with no image cost in the main context.
 *
 * Failure of any kind → null (the caller decides the fallback; it never brings
 * the turn down). 60s timeout so as not to hold the tool call.
 */

const DESCRIBE_PROMPT = (language?: string, focus?: string) =>
  'Describe this image in detail and factually, in ' +
  (language ?? 'the user\'s language') +
  '. Include: layout and structure, UI elements and their state, all visible text (verbatim when short), colors/icons/visual details, and anything notable that could matter for the task at hand. Be precise and objective — do not speculate about what is not visible. Aim for a compact but complete description (200-600 words).' +
  (focus ? `\n\nThe user's message focuses on: "${focus}". Prioritize the details that answer it, but keep the overall description too.` : '')

export async function describeImage(opts: {
  model: WorkerModelConfig
  imageDataUrl: string
  language?: string
  /** Text of the user's message — the description prioritizes what they asked. */
  focus?: string
}): Promise<string | null> {
  try {
    const model = await resolveModel(opts.model.providerId, opts.model.modelId)
    const { text } = await generateText({
      model,
      messages: [
        {
          role: 'user',
          content: [
            // `file` part with mediaType: the `image` type was deprecated in the
            // ai-sdk. The mime comes from the data URL itself, which is how the image
            // arrives here.
            {
              type: 'file',
              data: opts.imageDataUrl,
              mediaType: /^data:(image\/[\w.+-]+)/.exec(opts.imageDataUrl)?.[1] ?? 'image/png',
            },
            { type: 'text', text: DESCRIBE_PROMPT(opts.language, opts.focus) },
          ],
        },
      ],
      abortSignal: AbortSignal.timeout(60_000),
    })
    const trimmed = text.trim()
    if (!trimmed) return null
    // Description compact enough not to bloat the main context
    return trimmed.length > 4000 ? trimmed.slice(0, 4000) : trimmed
  } catch (err) {
    console.error('[vision] describeImage failed:', err)
    return null
  }
}

/** Image attached to the current message, available to the describe_image tool. */
export interface TurnImage {
  url: string
  filename?: string
  /** Id of the placeholder TextPart in the user message — the description is persisted in it */
  partId?: string
  /** Has the first description already been persisted in the placeholder? (the following ones are appended) */
  persisted?: boolean
}

/**
 * Per-session registry of the in-progress turn's images (Vision mode): the
 * describe_image tool reads from here on demand and runChat clears it in the finally. One session
 * runs one turn at a time, so the key is the sessionId.
 */
const turnImages = new Map<string, TurnImage[]>()

export function registerTurnImages(sessionId: string, images: TurnImage[]): void {
  turnImages.set(sessionId, images)
}

export function getTurnImages(sessionId: string): TurnImage[] | undefined {
  return turnImages.get(sessionId)
}

export function clearTurnImages(sessionId: string): void {
  turnImages.delete(sessionId)
}
