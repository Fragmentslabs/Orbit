/**
 * Conversion of an MCP tool result into the text that goes to the model.
 *
 * MCP returns a list of typed blocks (text, image, audio, resource…). The previous
 * version serialized with JSON.stringify everything that was not text — a Nodara
 * screenshot (PNG 1220×2712) entered the context as 3.3M characters of base64, the
 * provider refused the whole request for overflowing the window and the session wrote
 * the same megabytes to disk.
 *
 * An image is not text: it goes to the conversation's gallery and the model only gets
 * the orbit-media:// reference. Showing it to the user (show_image) and looking at it
 * (describe_image, Vision mode) become the agent's decisions, on demand — the same
 * contract as run_browser_script.
 *
 * Audio is the exception that goes the other way: it is stored in the chat's audio
 * collection (like audio_generate / ytdlp) and the result carries its `audioUrl`, so the
 * engine puts a player in the answer without the agent having to do anything.
 */

/** Ceiling for the text of a result (~25k tokens). A server that dumps a whole file
 *  cannot, on its own, fill the turn's window. */
export const MAX_MCP_TEXT_CHARS = 100_000

export interface SavedImage {
  url: string
  width?: number
  height?: number
  bytes: number
}

export interface SavedAudio {
  url: string
  bytes: number
}

/** Result of an MCP tool that returned audio: the engine renders `audioUrl` as a player. */
export interface McpAudioOutput {
  audioUrl: string
  title: string
  message: string
  /** marks the output as coming from an MCP server (the engine only trusts this one to make a player) */
  fromMcp: true
}

export interface McpResultScope {
  /** Stores an audio in the chat's audio collection; undefined/null = audio stays out, as before. */
  saveAudio?: (data: Buffer, mimeType: string) => Promise<SavedAudio | null>
  /** Stores the image in the gallery; null when it did not work (the model is warned). */
  saveImage: (data: Buffer, mimeType: string) => Promise<SavedImage | null>
  /** show_image is in this turn's toolset */
  canShow: boolean
  /** describe_image is in this turn's toolset (Vision mode) */
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

/** Embedded resource block: text gets in (with the general ceiling), binary does not. */
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

async function convert(result: unknown, scope: McpResultScope): Promise<{ text: string; audios: SavedAudio[] }> {
  const content = (result as { content?: unknown })?.content
  if (!Array.isArray(content)) return { text: capText(safeJson(result)), audios: [] }

  const parts: string[] = []
  const saved: SavedImage[] = []
  const audios: SavedAudio[] = []
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
        const data = typeof block.data === 'string' ? block.data : ''
        const audio =
          data && scope.saveAudio ? await scope.saveAudio(Buffer.from(data, 'base64'), mime).catch(() => null) : null
        if (audio) {
          audios.push(audio)
          parts.push(`[Audio saved: ${audio.url} (${kb(audio.bytes)}) — shown to the user as a player in your reply]`)
        } else {
          parts.push(`[Audio omitted (${mime})]`)
        }
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
  // The guidance comes after the ceiling: a giant text before it cannot cut exactly the
  // line that says how to see the image.
  if (saved.length > 0) return { text: `${text}\n${imageGuidance(scope)}`, audios }
  return { text: text || '(no return)', audios }
}

/** The text that goes to the model (audio, if any, is only mentioned in it). */
export async function mcpResultToText(result: unknown, scope: McpResultScope): Promise<string> {
  return (await convert(result, scope)).text
}

/**
 * What the tool returns to the engine: the text, or — when the server returned audio and it
 * was stored — an object with `audioUrl` (the first one), so the answer gets a player.
 */
export async function mcpResultToOutput(
  result: unknown,
  scope: McpResultScope,
  title: string,
): Promise<string | McpAudioOutput> {
  const { text, audios } = await convert(result, scope)
  if (audios.length === 0) return text
  return { audioUrl: audios[0].url, title, message: text, fromMcp: true }
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
