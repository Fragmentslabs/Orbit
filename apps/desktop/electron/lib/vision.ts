import { generateText } from 'ai'
import type { WorkerModelConfig } from '@shared/chat'
import { resolveModel } from './providers'

/**
 * Visão delegada: descreve uma imagem (data URL) com um modelo de visão e
 * devolve o texto — o modelo principal (sem visão) recebe a descrição no
 * lugar da imagem, sem custo de imagem no contexto principal.
 *
 * Falha de qualquer tipo → null (o chamador decide o fallback; nunca derruba
 * o turno). Timeout de 60s para não segurar o tool call.
 */

const DESCRIBE_PROMPT = (language?: string, focus?: string) =>
  'Describe this image in detail and factually, in ' +
  (language ?? 'the user\'s language') +
  '. Include: layout and structure, UI elements and their state, all visible text (verbatim when short), colors/icons/visual details, and anything notable that could matter for the task at hand. Be precise and objective — do not speculate about what is not visible. Aim for a compact but complete description (200-600 words).' +
  (focus ? `\n\nThe user\'s message focuses on: "${focus}". Prioritize the details that answer it, but keep the overall description too.` : '')

export async function describeImage(opts: {
  model: WorkerModelConfig
  imageDataUrl: string
  language?: string
  /** Texto da mensagem do usuário — a descrição prioriza o que ele perguntou. */
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
            { type: 'image', image: opts.imageDataUrl },
            { type: 'text', text: DESCRIBE_PROMPT(opts.language, opts.focus) },
          ],
        },
      ],
      abortSignal: AbortSignal.timeout(60_000),
    })
    const trimmed = text.trim()
    if (!trimmed) return null
    // Descrição compacta o suficiente para não inchar o contexto principal
    return trimmed.length > 4000 ? trimmed.slice(0, 4000) : trimmed
  } catch (err) {
    console.error('[vision] describeImage falhou:', err)
    return null
  }
}
