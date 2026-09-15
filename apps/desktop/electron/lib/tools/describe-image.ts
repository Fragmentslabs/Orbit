import { tool } from 'ai'
import { z } from 'zod'
import type { SendMessageInput } from '@shared/chat'
import { describeImage, getTurnImages } from '../vision'
import { mediaIdFromUrl, readMedia } from '../media'

/**
 * Modo Visão (agent-driven): o agente decide quando e como olhar uma imagem —
 * descrição geral (sem focus) ou perguntas específicas com o contexto da
 * conversa embutido no focus. A imagem nunca entra no contexto do modelo
 * principal.
 *
 * Alcança o anexo do turno (registry efêmero, limpo no finally do runChat) e
 * qualquer imagem da galeria. A segunda origem é o que torna possível olhar
 * ANTES de editar: sem ela, o agente só enxergaria a foto na mensagem em que
 * ela chegou, e um "agora escreve na jaqueta" no turno seguinte seria feito no
 * escuro.
 *
 * A descrição de um anexo do turno é persistida no histórico pelo chat-engine
 * (hook do tool-result), então turnos futuros a veem como texto.
 */
/**
 * A imagem pedida, como data URL — do turno ou da galeria.
 *
 * O `ref` numérico e a URL orbit-media:// convivem porque cobrem momentos
 * diferentes: o número é o anexo que chegou AGORA (e que não fica guardado em
 * lugar nenhum depois do turno), a URL é tudo o mais. Devolver null em vez de
 * lançar deixa a mensagem de erro no chamador, que sabe qual das duas formas
 * foi tentada.
 */
async function resolveImage(sessionId: string, ref: number | string): Promise<string | null> {
  if (typeof ref === 'number') {
    return getTurnImages(sessionId)?.[ref - 1]?.url ?? null
  }
  // Um número em forma de texto continua sendo o anexo do turno: o modelo
  // erra essa forma com frequência, e recusar seria pedantismo.
  if (/^\d+$/.test(ref.trim())) {
    return getTurnImages(sessionId)?.[Number(ref.trim()) - 1]?.url ?? null
  }
  const id = mediaIdFromUrl(ref)
  if (!id) return null
  const file = await readMedia(id)
  return file ? `data:${file.contentType};base64,${file.buffer.toString('base64')}` : null
}

export function createDescribeImageTool(input: SendMessageInput) {
  return tool({
    description:
      'Describes an image using the configured vision model (Vision mode). The image itself never enters your context — this tool is the only way to see it, so call it whenever an image is relevant to the task; you can call it multiple times with different focus questions.\n' +
      'ref: either the #N of an image attached to the CURRENT message (from the "[Imagem anexada ... ref #N]" placeholder), or an orbit-media:// URL from image_list — which is how you look at an image from an earlier turn, or at the result of an edit you just made.\n' +
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
      // Duas origens, porque o anexo do turno some no fim dele: a imagem que
      // acabou de chegar vive no registry, e qualquer outra — a de um turno
      // anterior, ou o resultado de uma edição — vive na galeria. Sem a
      // segunda, olhar antes de editar só funcionaria na primeira mensagem.
      const image = await resolveImage(input.sessionId, ref)
      if (!image) {
        throw new Error(
          typeof ref === 'number'
            ? `A imagem #${ref} não está disponível: esse número vale só para as imagens anexadas ao turno atual. ` +
              'Use image_list para pegar a URL orbit-media:// da imagem que você quer ver.'
            : `Imagem não encontrada: ${ref}. Use image_list para ver as referências desta conversa.`,
        )
      }
      const desc = await describeImage({
        model: input.visionModel!,
        imageDataUrl: image,
        language: input.language,
        focus: focus ?? input.text,
      })
      if (!desc) {
        throw new Error('O modelo de visão configurado falhou ao descrever a imagem — tente novamente ou informe o usuário.')
      }
      return desc
    },
  })
}
