import { tool, type ToolSet } from 'ai'
import { systemPreferences } from 'electron'
import { z } from 'zod'
import { describeImage } from '../vision'
import { captureScreenForOverlay, MAX_MODEL_IMAGE_BYTES } from '../overlay/capture'
import { readSelectedText } from '../overlay/selection'
import { readFrontWindowText } from '../overlay/turn-context'
import { endCallEverywhere, lastOverlaySelection } from '../overlay/window'

/**
 * Overlay tools (⇧⌘Space). The panel has no project in sight and the question
 * is usually about what is ON SCREEN ("translate this", "what does this error
 * say?") — without these tools the agent would answer in the dark, or ask the
 * person to copy and paste.
 *
 * Text comes first: the selection and the window's accessibility tree answer
 * most questions ("what does this error say", "summarise this page") in
 * milliseconds and a few hundred tokens. The screenshot — slow, and a vision
 * call on top when Vision mode is on — is for what text cannot carry.
 *
 * Images enter the context through `toModelOutput`, the same pattern as
 * Computer Use: the tool result is text (what stays in the history) and the
 * screenshot is only attached during the turn, never persisted.
 */

export interface OverlayToolOptions {
  /** Does the turn's model accept images? */
  modelVision: boolean
  /** Vision mode: describes the image with another model and sends only the text. */
  visionModel?: { providerId: string; modelId: string }
  /** Conversation the window reads are registered under (Computer Use's registry) */
  sessionId: string
}

const MAX_SELECTION_CHARS = 20_000

const stash = new Map<string, { base64: string; mediaType: string } | { text: string }>()

function toModelOutput({ toolCallId, output }: { toolCallId: string; output: unknown }) {
  const stashed = stash.get(toolCallId)
  stash.delete(toolCallId)
  if (!stashed) return { type: 'text' as const, value: String(output) }
  if ('text' in stashed) {
    return { type: 'text' as const, value: `${String(output)}\n\n[Screenshot description (vision model)]: ${stashed.text}` }
  }
  return {
    type: 'content' as const,
    value: [
      { type: 'text' as const, text: String(output) },
      { type: 'image-data' as const, data: stashed.base64, mediaType: stashed.mediaType },
    ],
  }
}

function screenRecording(): boolean {
  try {
    return systemPreferences.getMediaAccessStatus('screen') === 'granted'
  } catch {
    return false
  }
}

/**
 * `end_call` holds in ANY spoken conversation — overlay and the main window's
 * call mode. That is why it is created separately: whoever turns on call mode without the
 * overlay also gets the "bye, Orbit".
 */
export function createEndCallTool() {
  return tool({
    description:
      'End the conversation: hangs up the call and closes the panel. Call it when the conversation is over or the user says goodbye.',
    inputSchema: z.object({}),
    execute: async () => {
      endCallEverywhere('agent')
      return 'Call ended and the overlay is closing. Do not add anything else.'
    },
  })
}

export function createOverlayTools(options: OverlayToolOptions): ToolSet {
  return {
    see_window_text: tool({
      description:
        'Read the window the user is in (the app in front, behind the Orbit panel) as TEXT: every label, message, field value and button of its accessibility tree, no image. This is the first way to look — an error message, a dialog, a form, the visible text of a page or document. Fast and cheap. If it comes back nearly empty (some apps and browsers expose no text), then use see_screen.',
      inputSchema: z.object({}),
      execute: async () => {
        const read = await readFrontWindowText(options.sessionId)
        if (!('text' in read)) return `${read.unavailable} Use see_screen to look at it instead.`
        return read.poor ? `This window exposes almost no text (only its frame) — use see_screen to look at it.\n${read.text}` : read.text
      },
    }),

    see_screen: tool({
      description:
        'Look at the screen the user is on right now as an IMAGE (the display under the mouse pointer; the Orbit overlay itself is left out of the shot). Use it only when the answer depends on how something LOOKS — a photo, a chart, colors, layout, an app whose window has no readable text (see_window_text came back empty). For words on screen (an error, a page, a dialog) see_window_text is faster and cheaper. Each call costs an image, so never call it on turns that do not need the screen. It goes through Vision mode (a vision model describes the shot); when Vision mode is off and the panel model can see images, the screenshot is attached to you instead. If neither is available it returns no image at all — then say you cannot see, never guess.',
      inputSchema: z.object({}),
      execute: async (_args, { toolCallId }) => {
        const shot = await captureScreenForOverlay().catch(() => null)
        if (!shot) {
          return screenRecording()
            ? 'Could not capture the screen (the display returned no image). Ask the user what is on it.'
            : 'Screen Recording permission is not granted to Orbit, so the screen is unavailable. Tell the user to enable it in System Settings → Privacy & Security → Screen Recording.'
        }
        const header = `Screen ${shot.width}×${shot.height} px (${shot.display}).`
        // Vision mode FIRST: it is the default path because it works with any
        // main model and is the only one that sees when the panel model is
        // text-only. The raw image only goes to the model when it has vision.
        if (options.visionModel) {
          const described = await describeImage({
            model: options.visionModel,
            imageDataUrl: `data:${shot.mediaType};base64,${shot.data.toString('base64')}`,
          }).catch(() => null)
          if (described) {
            stash.set(toolCallId, { text: described })
            return `${header}\nA vision model looked at the screen and its description is attached. Answer from that description only; if it says something was unreadable, say so.`
          }
          // Description failed: if the panel model can see, the image is still worth it.
          if (!options.modelVision) {
            return `${header}\nNO screenshot and NO description arrived: you cannot see the screen this turn. Tell the user in one line that the vision model failed, instead of guessing.`
          }
        }
        if (!options.modelVision) {
          return `${header}\nNO screenshot was attached: the panel's model cannot see images and Vision mode has no vision model selected. You cannot see the screen this turn. Tell the user in one line to turn on Vision mode and pick a vision model in Settings → Overlay, and do not guess.`
        }
        if (shot.data.length > MAX_MODEL_IMAGE_BYTES) {
          return `${header}\nNO screenshot was attached (${Math.round(shot.data.length / 1024)}KB exceeds the ${MAX_MODEL_IMAGE_BYTES / 1000}KB limit): you cannot see the screen this turn. Say so in one line instead of guessing.`
        }
        stash.set(toolCallId, { base64: shot.data.toString('base64'), mediaType: shot.mediaType })
        return `${header}\nA screenshot is attached in the user message right after this result. Describe ONLY what is visible in it — if it is missing or unreadable, say so.`
      },
      toModelOutput,
    }),

    see_selection: tool({
      description:
        'Read the text the user has selected in the app that is in front (translation, a paragraph, an error message). Reads it without changing the clipboard when the app answers through accessibility, and only falls back to a silent Cmd+C when it must. Use it whenever the request says "this", "it" or "translate that" and a selection may be the subject.',
      inputSchema: z.object({}),
      execute: async () => {
        const selection = await readSelectedText({ allowClipboard: true }).catch(() => null)
        if (selection) {
          const text = selection.text.slice(0, MAX_SELECTION_CHARS)
          const where = selection.app ? ` in ${selection.app}` : ''
          return `Selection${where} (${text.length} chars):\n\n${text}`
        }
        // The panel was opened in text mode: the focus came to Orbit, and an app
        // that only delivers the selection through the clipboard is no longer reachable. The
        // read made at opening (recent) counts.
        const cached = lastOverlaySelection()
        if (cached && Date.now() - cached.at < 120_000) {
          const text = cached.text.slice(0, MAX_SELECTION_CHARS)
          const where = cached.app ? ` in ${cached.app}` : ''
          return `Selection${where} (${text.length} chars, read when the panel opened):\n\n${text}`
        }
        return 'There is no readable selection right now (or Orbit is missing the Accessibility permission for that app). Ask the user to select the text again, or what they mean. Do not call this tool twice in a row.'
      },
    }),
  }
}
