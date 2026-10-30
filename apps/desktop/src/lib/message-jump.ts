/**
 * Jump to a message in the chat.
 *
 * The chat list only mounts the last messages (window — see ChatMessages in
 * chat-view.tsx), so an old message may not exist in the DOM. Whoever wants to
 * scroll to it (search, message navigator, media gallery) asks here:
 * each mounted list registers a "revealer" that extends its own window up to
 * the message, and only then is the element looked up.
 */

/** Returns true when the list has the message (and has already asked to show it). */
type Revealer = (messageId: string) => boolean

const revealers = new Set<Revealer>()

export function registerMessageRevealer(revealer: Revealer): () => void {
  revealers.add(revealer)
  return () => {
    revealers.delete(revealer)
  }
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()))
}

function findMessageElement(messageId: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-msg-id="${CSS.escape(messageId)}"]`)
}

/** Frames spent waiting for the element (~2s): covers the chat that is still
 *  loading the history, as after switching session from the gallery. */
const MAX_FRAMES = 120

/**
 * Ensures the message is mounted and returns its element (null if it did not appear).
 * The revealers are consulted on every frame until one of them recognizes the
 * message — the right list may not even have mounted yet.
 */
export async function revealMessage(messageId: string): Promise<HTMLElement | null> {
  let owned = false
  for (let frame = 0; frame < MAX_FRAMES; frame += 1) {
    if (!owned) {
      for (const reveal of revealers) {
        if (reveal(messageId)) owned = true
      }
    }
    const el = findMessageElement(messageId)
    if (el) {
      // The element just came in: wait for the layout of what came in with
      // it above, otherwise the scroll aims at a position that is still going to change.
      await nextFrame()
      return el
    }
    await nextFrame()
  }
  return null
}

export interface ScrollToMessageOptions {
  /** Blinks a ring on the message. The chat search turns it off: there the highlight is the
   *  search term itself (see highlightTextIn). */
  flash?: boolean
}

/** Scrolls to the message (centered) and, by default, blinks a ring on it. */
export async function scrollToMessage(
  messageId: string,
  options: ScrollToMessageOptions = {},
): Promise<HTMLElement | null> {
  const el = await revealMessage(messageId)
  if (!el) return null
  el.scrollIntoView({ behavior: "smooth", block: "center" })
  if (options.flash !== false) flashMessage(el)
  return el
}

/**
 * Blinks a ring around the message.
 *
 * Before, this painted the element's `background-color` — and the message
 * wrapper fills the whole row, so the result was a square rectangle
 * behind the rounded bubble. The ring marks the same place without covering what the
 * message has inside, and follows the radius of the element that receives it.
 */
function flashMessage(el: HTMLElement): void {
  const surface = el.querySelector<HTMLElement>("[data-msg-surface]") ?? el
  const prevOutline = surface.style.outline
  const prevOffset = surface.style.outlineOffset
  const prevTransition = surface.style.transition
  surface.style.transition = "outline-color 0.4s ease"
  surface.style.outline = "2px solid var(--primary)"
  surface.style.outlineOffset = "3px"
  window.setTimeout(() => {
    surface.style.outlineColor = "transparent"
  }, 600)
  window.setTimeout(() => {
    surface.style.outline = prevOutline
    surface.style.outlineColor = ""
    surface.style.outlineOffset = prevOffset
    surface.style.transition = prevTransition
  }, 1000)
}

/* ------------------------------------------------------------------ */
/* Highlight of the searched term                                      */
/* ------------------------------------------------------------------ */

/**
 * The chat search does NOT paint the message: a background on the wrapper becomes a
 * square block behind the bubble and, worse, does not point out what matched the search. With the
 * CSS Custom Highlight API (Chromium — it is what runs in Electron) the highlight
 * is only the characters of the term: the ranges go to `CSS.highlights` and the
 * drawing comes from the `::highlight(orbit-search-hit)` rule in index.css.
 * Registering and clearing is one line, so the highlight does not survive the closing
 * of the search.
 */
const SEARCH_HIGHLIGHT = "orbit-search-hit"

/** Cap on the scanned text: a giant answer does not need to be entirely highlighted. */
const MAX_WALK = 200_000

const COMBINING = /[\u0300-\u036f]/g

type HighlightCtor = new (...ranges: Range[]) => object

interface HighlightRegistry {
  set: (name: string, highlight: object) => void
  delete: (name: string) => void
}

function highlightRegistry(): HighlightRegistry | null {
  const registry = (globalThis as unknown as { CSS?: { highlights?: HighlightRegistry } }).CSS?.highlights
  return registry && typeof registry.set === "function" ? registry : null
}

function highlightConstructor(): HighlightCtor | null {
  const ctor = (globalThis as unknown as { Highlight?: unknown }).Highlight
  return typeof ctor === "function" ? (ctor as HighlightCtor) : null
}

/** Clears the search highlight. Called when closing the search and before each new highlight. */
export function clearTextHighlight(): void {
  highlightRegistry()?.delete(SEARCH_HIGHLIGHT)
}

/** Lowercase and without accents — the same comparison the search makes (normalizeText). */
function foldChar(ch: string): string {
  return ch.normalize("NFD").replace(COMBINING, "").toLowerCase()
}

function fold(text: string): string {
  let out = ""
  for (const ch of text) out += foldChar(ch)
  return out
}

/**
 * Folded text + the map back to the indices of the original (an accented
 * character may become letters of a different size after NFD, so the
 * DOM offset is not the search offset).
 */
function foldWithMap(text: string): { folded: string; starts: number[]; ends: number[] } {
  const chars: string[] = []
  const starts: number[] = []
  const ends: number[] = []
  let offset = 0
  for (const ch of text) {
    const next = offset + ch.length
    for (const folded of foldChar(ch)) {
      chars.push(folded)
      starts.push(offset)
      ends.push(next)
    }
    offset = next
  }
  return { folded: chars.join(""), starts, ends }
}

/**
 * Highlights `query` inside the message element and returns how many stretches
 * were marked. Replaces the previous highlight: only the current result stays
 * lit. Returns 0 when there is nothing to highlight (or when the runtime does not have the
 * API — the scroll still applies).
 */
export function highlightTextIn(el: HTMLElement, query: string): number {
  clearTextHighlight()
  const registry = highlightRegistry()
  const HighlightCtor = highlightConstructor()
  const term = fold(query.trim())
  if (!registry || !HighlightCtor || !term) return 0

  const ranges: Range[] = []
  let walked = 0
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const text = node.nodeValue
      if (!text || !text.trim()) return NodeFilter.FILTER_REJECT
      // Screen reader label and script are not visible content.
      if (node.parentElement?.closest("script, style, .sr-only")) return NodeFilter.FILTER_REJECT
      return NodeFilter.FILTER_ACCEPT
    },
  })
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const textNode = node as Text
    const value = textNode.nodeValue ?? ""
    walked += value.length
    if (walked > MAX_WALK) break
    const { folded, starts, ends } = foldWithMap(value)
    for (let at = folded.indexOf(term); at !== -1; at = folded.indexOf(term, at + term.length)) {
      const start = starts[at]
      const end = ends[at + term.length - 1]
      if (start === undefined || end === undefined || end <= start) continue
      const range = document.createRange()
      range.setStart(textNode, start)
      range.setEnd(textNode, end)
      ranges.push(range)
    }
  }
  if (ranges.length === 0) return 0
  registry.set(SEARCH_HIGHLIGHT, new HighlightCtor(...ranges))
  return ranges.length
}
