import { tool, type ToolSet } from 'ai'
import { systemPreferences } from 'electron'
import { z } from 'zod'
import { describeImage } from '../vision'
import { captureScreenForOverlay, MAX_MODEL_IMAGE_BYTES } from '../overlay/capture'
import { readSelectedText } from '../overlay/selection'
import { endCallEverywhere, lastOverlaySelection } from '../overlay/window'

/**
 * Tools do overlay (⇧⌘espaço). O painel não tem o projeto à vista e a pergunta
 * costuma ser sobre o que está NA TELA ("traduz isso", "o que diz esse erro?")
 * — sem estas duas tools o agente responderia no escuro, ou pediria para a
 * pessoa copiar e colar.
 *
 * As imagens entram no contexto pelo `toModelOutput`, no mesmo padrão do
 * Computer Use: o resultado da tool é texto (o que fica no histórico) e o
 * screenshot só é anexado no turno, nunca persistido.
 */

export interface OverlayToolOptions {
  /** O modelo do turno aceita imagem? */
  modelVision: boolean
  /** Modo Visão: descreve a imagem com outro modelo e manda só o texto. */
  visionModel?: { providerId: string; modelId: string }
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
 * `end_call` vale em QUALQUER conversa falada — overlay e o modo chamada da
 * janela principal. Por isso é criada à parte: quem liga o modo chamada sem o
 * overlay também ganha o "tchau, Orbit".
 */
export function createEndCallTool() {
  return tool({
    description:
      'End the spoken conversation and dismiss the overlay. Call it when the user clearly signs off or says it was nothing — "tchau", "não era nada", "era só isso", "pode fechar", "thanks, bye" — or asks to stop. Say ONE short goodbye first (it is spoken), then call this tool IN THE SAME TURN. Writing the goodbye alone ends nothing: without this call the microphone keeps listening and the panel stays on screen. Do not use it when the user merely pauses or asks something else.',
    inputSchema: z.object({}),
    execute: async () => {
      endCallEverywhere('agent')
      return 'Call ended and the overlay is closing. Do not add anything else.'
    },
  })
}

export function createOverlayTools(options: OverlayToolOptions): ToolSet {
  return {
    see_screen: tool({
      description:
        'Look at the screen the user is on right now (the display under the mouse pointer; the Orbit overlay itself is left out of the shot). Use it when the answer depends on what is visible — an error, a page, a document, a photo. Each call costs an image, so do not call it on turns that do not need the screen. It goes through Vision mode (a vision model describes the shot); when Vision mode is off and the panel model can see images, the screenshot is attached to you instead. If neither is available it returns no image at all — then say you cannot see, never guess.',
      inputSchema: z.object({}),
      execute: async (_args, { toolCallId }) => {
        const shot = await captureScreenForOverlay().catch(() => null)
        if (!shot) {
          return screenRecording()
            ? 'Could not capture the screen (the display returned no image). Ask the user what is on it.'
            : 'Screen Recording permission is not granted to Orbit, so the screen is unavailable. Tell the user to enable it in System Settings → Privacy & Security → Screen Recording.'
        }
        const header = `Screen ${shot.width}×${shot.height} px (${shot.display}).`
        // Modo Visão PRIMEIRO: é o caminho padrão porque funciona com qualquer
        // modelo principal e é o único que enxerga quando o modelo do painel é
        // só de texto. A imagem crua só vai ao modelo quando ele tem visão.
        if (options.visionModel) {
          const described = await describeImage({
            model: options.visionModel,
            imageDataUrl: `data:${shot.mediaType};base64,${shot.data.toString('base64')}`,
          }).catch(() => null)
          if (described) {
            stash.set(toolCallId, { text: described })
            return `${header}\nA vision model looked at the screen and its description is attached. Answer from that description only; if it says something was unreadable, say so.`
          }
          // Descrição falhou: se o modelo do painel enxerga, ainda vale a imagem.
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
        // O painel foi aberto em modo texto: o foco veio para o Orbit, e um app
        // que só entrega a seleção pelo clipboard não é mais alcançável. Vale a
        // leitura feita na abertura (recente).
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
