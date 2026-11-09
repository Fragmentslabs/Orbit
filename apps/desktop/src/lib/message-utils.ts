import { parseMessageReply } from "@shared/chat"
import { isEngineText, lastTextRunStart } from "@shared/chat-text"
import { arrangeForView } from "@shared/chat-view"
import type { ChatMessage, FilePart, MessagePart, ToolPart } from "@shared/chat"

/**
 * Real path, on disk, of each attachment whose content must NOT cross the
 * renderer memory (videos). Registered when the file is added to the
 * input — it is the only time the `File` still exists — and consumed in the
 * conversion to data URL right below.
 */
const attachmentPaths = new Map<string, string>()

/** A video is too heavy to become a data URL: it goes through a path when there is one. */
export function isLargeMediaType(mediaType: string | undefined, filename?: string): boolean {
  return !!mediaType?.startsWith("video/") || /\.(mp4|m4v|mov|webm|mkv|avi)$/i.test(filename ?? "")
}

/** The largest video still accepted WITHOUT a path (pasted from the clipboard). */
export const MAX_PASTED_VIDEO_BYTES = 150 * 1024 * 1024

/** `/home/a b/c.mp4` → `file:///home/a%20b/c.mp4` (and `C:\x\y.mp4` → `file:///C:/x/y.mp4`). */
export function pathToFileUrl(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/")
  const withRoot = normalized.startsWith("/") ? normalized : `/${normalized}`
  return `file://${encodeURI(withRoot).replace(/[?#]/g, (c) => (c === "?" ? "%3F" : "%23"))}`
}

/** Stores the path of a file on disk for its blob URL (see above). */
export function rememberAttachmentPath(blobUrl: string, filePath: string): void {
  if (filePath) attachmentPaths.set(blobUrl, filePath)
}

/** Converts the input attachments' blob URLs into stable data URLs. The input
 * works with blob URLs (URL.createObjectURL) and REVOKES them when clearing — the queue
 * and the scheduling keep the message to send later, so they need the
 * data URL (a revoked blob URL becomes a dead attachment). The immediate send also uses
 * this path (PromptInput's handleSubmit), for the same reason: clear() runs
 * before submit. Videos from a file take another path: they become a `file://`
 * for main to copy from disk, instead of gigabytes of base64 in the renderer. */
export async function blobUrlsToDataUrls<T extends { url?: string; mediaType?: string; filename?: string }>(
  files: T[],
): Promise<T[]> {
  return Promise.all(
    files.map(async (item) => {
      if (!item.url?.startsWith("blob:")) return item
      const diskPath = attachmentPaths.get(item.url)
      if (diskPath && isLargeMediaType(item.mediaType, item.filename)) {
        attachmentPaths.delete(item.url)
        return { ...item, url: pathToFileUrl(diskPath) }
      }
      try {
        const blob = await (await fetch(item.url)).blob()
        const dataUrl = await new Promise<string | null>((resolve) => {
          const reader = new FileReader()
          reader.onloadend = () => resolve(reader.result as string)
          reader.onerror = () => resolve(null)
          reader.readAsDataURL(blob)
        })
        return { ...item, url: dataUrl ?? item.url }
      } catch {
        return item
      }
    }),
  )
}

/** Tools that touch the web — they feed chain-of-thought and sources. */
export const WEB_TOOLS = new Set(["websearch", "webfetch", "browser_open", "browser_links"])

// `isEngineText`/`lastTextRunStart` live in shared (@shared/chat-text): main
// (native notification preview) and the renderer (bubble, spoken summary) need
// the SAME notion of "final answer" — and the banner already diverged from it, announcing
// the turn's narration. Re-exported so the consumers here do not have to change.
export { isEngineText, lastTextRunStart }
// The summary arrangement lives in shared (@shared/chat-view): the phone reads the
// same turn with the same rule (its only view mode), so the two sides cannot drift.
export { arrangeForView }

export interface WebSource {
  url: string
  title: string
}

/** Full text of the message (all text parts, including what was
 * extracted from attachments). Used when the consumer needs the real content —
 * e.g.: resend on a retry, since the retry does not re-attach the original file. */
export function messageText(message: ChatMessage): string {
  return message.parts
    .filter((p): p is Extract<MessagePart, { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join("\n")
}

/** Only what the person typed — skips the text parts with source "attachment"
 * (text extracted from PDF/spreadsheet/DOCX/skill). Use it to display the
 * user bubble, copy the message or preview in the nav: the extracted content already
 * appears as an attachment chip, there is no need to pollute the bubble with the whole
 * text of the file — the model still receives everything via messageText/partText. */
export function visibleMessageText(message: ChatMessage): string {
  return message.parts
    .filter((p): p is Extract<MessagePart, { type: "text" }> => p.type === "text" && p.source !== "attachment")
    .map((p) => p.text)
    .join("\n")
}

/** Only the message body: without the quoted message of the reply, which the bubble
 *  draws highlighted. For previews (message navigator), where the quoted
 *  excerpt would only push the person's text out of place. */
export function messageBody(message: ChatMessage): string {
  return parseMessageReply(visibleMessageText(message)).body
}

/**
 * Text that READING OUT LOUD speaks: the final answer of the message, and only it
 * (assistant only, model prose only, last text block only — without the orbit-ui JSON
 * or the diagram code).
 *
 * The rule now lives in shared (`@shared/chat-text`): the phone reads the same
 * answer through `/api/voice/speak`, and two copies would diverge. Re-exported
 * from here because the whole desktop UI already imports from this module.
 */
export { speakableText } from "@shared/chat-text"

/** Composer attachment as the converter needs to see it — the least common denominator between
 *  PromptInputFile, QueueAttachment and what comes back from a revert. */
export interface AttachmentLike {
  mediaType?: string
  filename?: string
  url?: string
  mediaId?: string
  sourceId?: string
}

/** Converts PromptInput attachments (FileUIPart, url already a data URL) into FileParts.
 *  `mediaId` marks the attachment that is a gallery reference — in that case `url` is
 *  only the preview and main copies nothing (see FilePart.mediaId). `sourceId` is the
 *  same for a conversation SOURCE: empty `url` and the content already stored. */
export function toFileParts(files: AttachmentLike[]): FilePart[] {
  return files
    .filter((f): f is AttachmentLike => Boolean(f.url) || Boolean(f.mediaId) || Boolean(f.sourceId))
    .map((f) => ({
      id: `file_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
      type: "file" as const,
      mime: f.mediaType ?? "application/octet-stream",
      filename: f.filename,
      url: f.url ?? "",
      ...(f.mediaId ? { mediaId: f.mediaId } : {}),
      ...(f.sourceId ? { sourceId: f.sourceId } : {}),
    }))
}

export function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "")
  } catch {
    return url
  }
}

/** Extracts Title/URL pairs from the websearch textual output (Exa format). */
export function parseSearchResults(output: string): WebSource[] {
  const sources: WebSource[] = []
  let title: string | null = null
  for (const line of output.split("\n")) {
    const trimmed = line.trim()
    if (trimmed.startsWith("Title:")) {
      title = trimmed.slice("Title:".length).trim()
    } else if (trimmed.startsWith("URL:")) {
      const url = trimmed.slice("URL:".length).trim()
      if (url.startsWith("http")) sources.push({ url, title: title ?? hostnameOf(url) })
      title = null
    }
  }
  return sources
}

function sourceOfToolPart(part: ToolPart): WebSource[] {
  if (part.state !== "done") return []
  switch (part.tool) {
    case "websearch":
      return part.output ? parseSearchResults(part.output) : []
    case "webfetch":
    case "browser_open": {
      const url = typeof part.input?.url === "string" ? part.input.url : undefined
      if (!url) return []
      // browser_open returns "# Title\nURL: ..." on the first line
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
    if (part.type !== "tool") continue
    for (const source of sourceOfToolPart(part)) {
      if (!seen.has(source.url)) seen.set(source.url, source)
    }
  }
  return [...seen.values()]
}

export interface TestSummary {
  passed: number
  failed: number
  skipped: number
  total: number
  duration?: number
}

const TEST_COMMAND = /\b(vitest|jest|pytest|mocha|playwright test|go test|cargo test|phpunit|rspec)\b|\bnpm (?:test|t)\b|\b(?:pnpm|yarn|bun) test\b/

export function isTestCommand(command: string): boolean {
  return TEST_COMMAND.test(command)
}

function parseDurationMs(output: string): number | undefined {
  const jest = output.match(/Time:\s+([\d.]+)\s*s/)
  if (jest) return Math.round(parseFloat(jest[1]) * 1000)
  const pytest = output.match(/in\s+([\d.]+)s\b/)
  if (pytest) return Math.round(parseFloat(pytest[1]) * 1000)
  const vitest = output.match(/Duration\s+([\d.]+)s/)
  if (vitest) return Math.round(parseFloat(vitest[1]) * 1000)
  return undefined
}

/** Extracts the test run summary from jest/vitest/pytest output. */
export function parseTestSummary(output: string): TestSummary | null {
  const duration = parseDurationMs(output)

  // Jest: "Tests:       1 failed, 2 skipped, 5 passed, 8 total"
  const jest = output.match(
    /Tests:\s+(?:(\d+)\s+failed,\s*)?(?:(\d+)\s+skipped,\s*)?(?:(\d+)\s+todo,\s*)?(?:(\d+)\s+passed,\s*)?(\d+)\s+total/,
  )
  if (jest) {
    const failed = Number(jest[1] ?? 0)
    const skipped = Number(jest[2] ?? 0) + Number(jest[3] ?? 0)
    const passed = Number(jest[4] ?? 0)
    return { passed, failed, skipped, total: Number(jest[5]), duration }
  }

  // Vitest: "Tests  1 failed | 5 passed | 1 skipped (7)"
  const vitest = output.match(/Tests\s+((?:\d+\s+\w+(?:\s*\|\s*)?)+)\((\d+)\)/)
  if (vitest) {
    const counts: Record<string, number> = {}
    for (const piece of vitest[1].split("|")) {
      const m = piece.trim().match(/(\d+)\s+(\w+)/)
      if (m) counts[m[2]] = Number(m[1])
    }
    return {
      passed: counts.passed ?? 0,
      failed: counts.failed ?? 0,
      skipped: counts.skipped ?? 0,
      total: Number(vitest[2]),
      duration,
    }
  }

  // Pytest: "2 failed, 3 passed, 1 skipped in 0.52s"
  const pytest = output.match(/(?:(\d+)\s+failed[,\s]+)?(\d+)\s+passed(?:[,\s]+(\d+)\s+skipped)?\s+in\s+[\d.]+s/)
  if (pytest) {
    const failed = Number(pytest[1] ?? 0)
    const passed = Number(pytest[2])
    const skipped = Number(pytest[3] ?? 0)
    return { passed, failed, skipped, total: passed + failed + skipped, duration }
  }

  return null
}
