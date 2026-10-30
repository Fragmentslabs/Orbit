/**
 * Document citation in the answer: `#orbit-source/<docId>/p<page>L<line>`.
 *
 * The generator/reader pair lives in two processes — main builds the address
 * (document-pages.ts) and the renderer interprets it here. Separated from the component
 * so it can be tested without React, because breaking this contract is
 * silent: an address that does not match becomes a common link, which opens nothing and
 * warns nothing.
 */

import { parseMemoryHref } from "@shared/memory-citation"

export const SOURCE_HREF = /^#orbit-source\/([a-z]+\d+)\/p(\d+)(?:L(\d+)(?:-(\d+))?)?$/i

export interface SourceRef {
  docId: string
  page: number
  fromLine?: number
  toLine?: number
}

export function parseSourceHref(href: string): SourceRef | null {
  const match = SOURCE_HREF.exec(href.trim())
  if (!match) return null
  return {
    docId: match[1],
    page: Number(match[2]),
    fromLine: match[3] ? Number(match[3]) : undefined,
    toLine: match[4] ? Number(match[4]) : undefined,
  }
}

/**
 * Converts the citation in the old format (`orbit-source://…`) to the current one.
 *
 * The old format was a scheme of its own, and the answer's markdown goes through
 * rehype-sanitize + rehype-harden: the sanitizer strips the href of every
 * protocol outside http/https/mailto/tel, and harden then marks the link without
 * an address as "[blocked]". That is what used to show up in the conversation.
 *
 * The answers already saved keep the text as it was written, so changing the
 * format only fixes the next ones — this rewrite, done at
 * render time, is what gives the click back to the old messages without rewriting the
 * history on disk.
 */
export function rescueLegacyCitations(markdown: string): string {
  return markdown.includes('](orbit-source://')
    ? markdown.replaceAll('](orbit-source://', '](#orbit-source/')
    : markdown
}

/**
 * Memory citation in the answer: `#orbit-memory/mem_xxx`.
 *
 * Same idea as the document citation, with a difference in reach: the memory
 * belongs to the PROJECT (or the user), not to an attached file — so there is no
 * page or line to point at, only the record. The one that resolves the id into text,
 * type and links is the renderer store.
 */
export { MEMORY_HREF, parseMemoryHref, splitMemoryIds } from "@shared/memory-citation"
export type { MemoryIdPart } from "@shared/memory-citation"

/** Link text that is only a number: [1], 1, [23]. */
const CITATION_TEXT = /^\[?\d{1,3}\]?$/
const WEB_HREF = /^https?:\/\//i

export type MarkdownLinkKind =
  | { kind: "source"; source: SourceRef }
  | { kind: "broken-source" }
  | { kind: "memory"; memoryId: string }
  | { kind: "broken-memory" }
  | { kind: "web-citation" }
  | { kind: "link" }

/**
 * What a link in the assistant's Markdown IS, decided in a single place.
 *
 * It lives here, and not inside the component, because it was THIS decision that took
 * down a whole conversation: every link whose text was a number went to the web
 * citation card, which builds a URL from the href. In a code analysis
 * the model wrote "[1](#orbit-source/src?/p1)" — a document citation
 * with an invented id — and the `new URL` of that href threw during rendering.
 *
 * - source: valid document citation, opens the source in the panel;
 * - broken-source: has the shape of a document citation but does not point
 *   anywhere — becomes text, because as a link it would be a dead click;
 * - memory: valid memory citation, becomes a chip with a summary card;
 * - broken-memory: same case as broken-source, for `#orbit-memory/`;
 * - web-citation: a number pointing to the web, gets the card;
 * - link: everything else, including "[1](src/app.ts)" and "[2](#section)".
 */
export function classifyMarkdownLink(href: string | undefined, text: string): MarkdownLinkKind {
  if (!href) return { kind: "link" }
  const source = parseSourceHref(href)
  if (source) return { kind: "source", source }
  if (href.startsWith("#orbit-source/")) return { kind: "broken-source" }
  const memoryId = parseMemoryHref(href)
  if (memoryId) return { kind: "memory", memoryId }
  if (href.startsWith("#orbit-memory/")) return { kind: "broken-memory" }
  if (CITATION_TEXT.test(text.trim()) && WEB_HREF.test(href)) return { kind: "web-citation" }
  return { kind: "link" }
}

/**
 * Stretches that must NOT be rewritten by linkify: code block, inline code,
 * link/image already built and loose memory href. Without this, a
 * `mem_xxx` cited inside a code block would become a chip in the middle of the code — and
 * a `#orbit-memory/mem_xxx` already written out in full would come out duplicated.
 */
const PROTECTED_SPAN = /```[\s\S]*?```|`[^`\n]*`|!?\[[^\]]*\]\([^)]*\)|<https?:\/\/[^>\s]+>|#orbit-memory\/mem_[a-z0-9]+/gi

/**
 * Memory id loose in the text — what the model writes when it forgets the
 * format. The optional `#` exists because the tools' output lists the memories
 * as `#mem_xxx`: without consuming it, the chip would be born with an orphan "#" in front.
 * The previous character enters the match so it does not match in the middle of another word.
 */
const BARE_MEMORY_ID = /(^|[^\w#])#?(mem_[a-z0-9]{6,})\b/gi

/**
 * Converts memory ids written raw into links for the chip.
 *
 * The model sometimes cites by id ("saved in mem_abc123") instead of the link
 * format. Rewriting here makes the conversation work without depending on the model
 * remembering the syntax — and fixes the answers already saved for free, which
 * keep the text as it was written. An unknown id breaks nothing: the chip
 * falls into the "not found" state instead of becoming a dead click.
 */
export function linkifyMemoryIds(markdown: string): string {
  if (!/mem_[a-z0-9]{6,}/i.test(markdown)) return markdown
  let out = ""
  let last = 0
  for (const match of markdown.matchAll(PROTECTED_SPAN)) {
    const start = match.index ?? 0
    out += linkifyBareIds(markdown.slice(last, start)) + match[0]
    last = start + match[0].length
  }
  return out + linkifyBareIds(markdown.slice(last))
}

function linkifyBareIds(text: string): string {
  return text.replace(BARE_MEMORY_ID, (_match, before: string, id: string) => `${before}[${id}](#orbit-memory/${id})`)
}
