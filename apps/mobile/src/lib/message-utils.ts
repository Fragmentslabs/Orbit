/**
 * Message utilities — port of apps/desktop/src/lib/message-utils.ts
 * (subset used by the companion conversation components).
 */
import type { ChatMessage, MessagePart, ToolPart } from '@orbit/shared'

/** Tools that touch the web — feed chain-of-thought and sources. */
export const WEB_TOOLS = new Set(['websearch', 'webfetch', 'browser_open', 'browser_links'])

export interface WebSource {
  url: string
  title: string
}

export function messageText(message: ChatMessage): string {
  return message.parts
    .filter((p): p is Extract<MessagePart, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('\n')
}

/** Only what the person typed — omits text parts with source "attachment"
 *  (text extracted from PDF/spreadsheet/DOCX/skill by the desktop). Mirrors
 *  apps/desktop/src/lib/message-utils.ts. */
export function visibleMessageText(message: ChatMessage): string {
  return message.parts
    .filter((p): p is Extract<MessagePart, { type: 'text' }> => p.type === 'text' && p.source !== 'attachment')
    .map((p) => p.text)
    .join('\n')
}

export function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

/** Extracts Title/URL pairs from the textual output of the websearch (Exa format). */
export function parseSearchResults(output: string): WebSource[] {
  const sources: WebSource[] = []
  let title: string | null = null
  for (const line of output.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.startsWith('Title:')) {
      title = trimmed.slice('Title:'.length).trim()
    } else if (trimmed.startsWith('URL:')) {
      const url = trimmed.slice('URL:'.length).trim()
      if (url.startsWith('http')) sources.push({ url, title: title ?? hostnameOf(url) })
      title = null
    }
  }
  return sources
}

function sourceOfToolPart(part: ToolPart): WebSource[] {
  if (part.state !== 'done') return []
  switch (part.tool) {
    case 'websearch':
      return part.output ? parseSearchResults(part.output) : []
    case 'webfetch':
    case 'browser_open': {
      const url = typeof part.input?.url === 'string' ? part.input.url : undefined
      if (!url) return []
      const heading = part.output?.match(/^#\s+(.+)$/m)?.[1]?.trim()
      return [{ url, title: heading || hostnameOf(url) }]
    }
    default:
      return []
  }
}

/** Sources consulted in the message (deduplicated by URL, in order of use). */
export function extractSources(message: ChatMessage): WebSource[] {
  const seen = new Map<string, WebSource>()
  for (const part of message.parts) {
    if (part.type !== 'tool') continue
    for (const source of sourceOfToolPart(part)) {
      if (!seen.has(source.url)) seen.set(source.url, source)
    }
  }
  return [...seen.values()]
}
