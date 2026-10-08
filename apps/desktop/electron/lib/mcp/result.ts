/**
 * Conversão do resultado de uma tool MCP no texto que vai ao modelo.
 *
 * O MCP devolve uma lista de blocos tipados (text, image, audio, resource…).
 * A versão anterior serializava com JSON.stringify tudo o que não fosse texto —
 * um screenshot do Nodara (PNG 1220×2712) entrava no contexto como 3,3M
 * caracteres de base64, o provedor recusava o request inteiro por estouro de
 * janela e a sessão gravava os mesmos megabytes em disco.
 *
 * Imagem não é texto: vai para a galeria da conversa e o modelo recebe só a
 * referência orbit-media://. Mostrar ao usuário (show_image) e olhar
 * (describe_image, modo Visão) viram decisões do agente, sob demanda — o mesmo
 * contrato do run_browser_script.
 */

/** Teto do texto de um resultado (~25k tokens). Um servidor que despeja um
 *  dump inteiro não pode, sozinho, ocupar a janela do turno. */
export const MAX_MCP_TEXT_CHARS = 100_000

export interface SavedImage {
  url: string
  width?: number
  height?: number
  bytes: number
}

export interface McpResultScope {
  /** Grava a imagem na galeria; null quando não deu (o modelo é avisado). */
  saveImage: (data: Buffer, mimeType: string) => Promise<SavedImage | null>
  /** show_image está no toolset deste turno */
  canShow: boolean
  /** describe_image está no toolset deste turno (modo Visão) */
  canDescribe: boolean
}

type Block = Record<string, unknown>

function kb(bytes: number): string {
  return `${Math.max(1, Math.round(bytes / 1024))}KB`
}

function imageGuidance(scope: McpResultScope): string {
  const lines = ['The image(s) were saved to this chat\'s gallery and are NOT in your context.']
  if (scope.canShow) lines.push('To show one to the user: show_image({ media: "<orbit-media url>" }).')
  if (scope.canDescribe) {
    lines.push(
      'To look at one: describe_image({ ref: "<orbit-media url>", focus: "<what you need to know>" }) — only when the task actually depends on what is on it.',
    )
  } else {
    lines.push(
      'You cannot see images in this conversation. When you need what is on screen, prefer a tool that returns it as text or structure (e.g. a UI/accessibility tree) if this server offers one.',
    )
  }
  return lines.join('\n')
}

/** Bloco de recurso embutido: texto entra (com o teto geral), binário não. */
function resourceText(block: Block): string {
  const resource = block.resource as Block | undefined
  const uri = typeof resource?.uri === 'string' ? resource.uri : 'resource'
  if (typeof resource?.text === 'string') return resource.text
  if (typeof resource?.blob === 'string') {
    const mime = typeof resource.mimeType === 'string' ? resource.mimeType : 'binary'
    return `[Binary resource omitted: ${uri} (${mime}, ~${kb((resource.blob.length * 3) / 4)})]`
  }
  return `[Resource: ${uri}]`
}

export async function mcpResultToText(result: unknown, scope: McpResultScope): Promise<string> {
  const content = (result as { content?: unknown })?.content
  if (!Array.isArray(content)) return capText(safeJson(result))

  const parts: string[] = []
  const saved: SavedImage[] = []
  for (const raw of content) {
    if (!raw || typeof raw !== 'object') continue
    const block = raw as Block
    switch (block.type) {
      case 'text':
        if (typeof block.text === 'string') parts.push(block.text)
        break
      case 'image': {
        const mime = typeof block.mimeType === 'string' ? block.mimeType : 'image/png'
        const data = typeof block.data === 'string' ? block.data : ''
        const image = data ? await scope.saveImage(Buffer.from(data, 'base64'), mime).catch(() => null) : null
        if (image) {
          saved.push(image)
          const size = image.width && image.height ? `${image.width}×${image.height}, ` : ''
          parts.push(`[Image saved: ${image.url} (${size}${kb(image.bytes)})]`)
        } else {
          parts.push(`[Image omitted (${mime}, ~${kb((data.length * 3) / 4)}): it could not be saved to the gallery]`)
        }
        break
      }
      case 'audio': {
        const mime = typeof block.mimeType === 'string' ? block.mimeType : 'audio'
        parts.push(`[Audio omitted (${mime})]`)
        break
      }
      case 'resource':
        parts.push(resourceText(block))
        break
      case 'resource_link':
        parts.push(`[Resource link: ${typeof block.uri === 'string' ? block.uri : '?'}${typeof block.name === 'string' ? ` (${block.name})` : ''}]`)
        break
      default:
        parts.push(safeJson(block))
    }
  }

  const text = capText(parts.join('\n'))
  // A orientação vem depois do teto: um texto gigante antes dela não pode
  // cortar justamente a linha que diz como ver a imagem.
  if (saved.length > 0) return `${text}\n${imageGuidance(scope)}`
  return text || '(sem retorno)'
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

function capText(text: string): string {
  if (text.length <= MAX_MCP_TEXT_CHARS) return text
  const cut = text.length - MAX_MCP_TEXT_CHARS
  return `${text.slice(0, MAX_MCP_TEXT_CHARS)}\n[… output truncated: ${cut} more chars. Ask the tool for a narrower result if you need the rest.]`
}
