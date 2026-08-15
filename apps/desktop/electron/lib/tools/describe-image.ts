import { tool } from 'ai'
import { z } from 'zod'
import type { SendMessageInput } from '@shared/chat'
import { describeImage, getTurnImages } from '../vision'

/**
 * Modo Visão (agent-driven): o agente decide quando e como ver as imagens
 * anexadas à mensagem atual — descrição geral (sem focus) ou perguntas
 * específicas com o contexto da conversa embutido no focus. A imagem nunca
 * entra no contexto do modelo principal; o registry vive apenas durante o
 * turno (limpo no finally do runChat). A descrição retornada é persistida no
 * histórico pelo chat-engine (hook do tool-result), então turnos futuros a
 * veem como texto.
 */
export function createDescribeImageTool(input: SendMessageInput) {
  return tool({
    description:
      'Describes an image the user attached to the CURRENT message, using the configured vision model (Vision mode). The image itself never enters your context — this tool is the only way to see it, so call it whenever an attached image is relevant to the task; you can call it multiple times with different focus questions.\n' +
      'ref: the #N of the image, shown in the "[Imagem anexada ... ref #N]" placeholder in the user message.\n' +
      'focus: what you need to know about the image (layout, colors, texts, specific elements, state...). The vision model sees ONLY the image and this focus — never the conversation. So when the task depends on earlier context (instructions, preferences, what was built so far), COMPLEMENT the focus with the necessary context so the description answers the real question instead of being generic. Omit focus when a general description is enough.',
    inputSchema: z.object({
      ref: z
        .number()
        .int()
        .min(1)
        .describe('Number of the image in the current user message (from the "ref #N" placeholder); 1 = first image'),
      focus: z
        .string()
        .optional()
        .describe('What you need to know about the image. The vision model does not see the conversation — include relevant context here when the answer depends on it. Omit for a general description.'),
    }),
    execute: async ({ ref, focus }) => {
      const image = getTurnImages(input.sessionId)?.[ref - 1]
      if (!image) {
        throw new Error(
          `A imagem #${ref} não está disponível: as imagens anexadas só podem ser descritas no turno em que foram enviadas. ` +
            'Se precisar dela, peça ao usuário para reenviar a imagem.',
        )
      }
      const desc = await describeImage({
        model: input.visionModel!,
        imageDataUrl: image.url,
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
