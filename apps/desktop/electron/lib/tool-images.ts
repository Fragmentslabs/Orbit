import type { ModelMessage } from 'ai'

/**
 * Imagens devolvidas por uma tool não chegam ao modelo em todo provedor.
 *
 * O adaptador `openai-compatible` — o caminho de qualquer gateway — monta a
 * mensagem de tool com `JSON.stringify` do output: uma imagem no resultado vira
 * base64 dentro de uma string, que o modelo lê como texto e ninguém enxerga.
 * Foi assim que o `see_screen` "mandou" a tela e o modelo respondeu que não
 * recebia imagem. O mesmo vale para qualquer tool que devolva imagem
 * (`panel_screenshot`, `pdf_view_page`, frames de vídeo…).
 *
 * Saída: a imagem sai do resultado da tool e vira uma mensagem de USUÁRIO logo
 * depois dele — todo adaptador converte imagem de usuário em `image_url`, que é
 * visão de verdade. O resultado fica em texto, apontando onde a imagem está.
 */
export const HOISTED_IMAGE_NOTE =
  '[The image this tool captured is attached in the user message right after it.]'

export interface HoistResult {
  /** A lista original quando nada mudou; uma nova quando havia imagem. */
  messages: ModelMessage[]
  images: number
}

interface PendingImage {
  data: string
  mediaType: string
}

/**
 * Move as imagens de resultados de tool para uma mensagem de usuário.
 *
 * Idempotente: depois da primeira passada o resultado já é texto (sem
 * `image-data`), então chamar de novo não acrescenta mensagem nenhuma.
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
