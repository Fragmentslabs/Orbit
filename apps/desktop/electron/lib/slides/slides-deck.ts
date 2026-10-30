/**
 * Reading a slide deck from HTML, in main.
 *
 * The deck is a single file (`index.html` with one `<section class="slide">` per
 * slide) — the same document the scheme serves and the runtime animates. There is
 * no browser here: what this module delivers is what can be known by READING the
 * file — how many slides, the title of each one and the presenter notes. It is
 * what the agent gets back from `slides_preview` and what the tab uses as a
 * fallback before the runtime answers.
 *
 * The title and note rules are the SAME as the runtime's (slides-runtime.ts):
 * `data-title`, otherwise the first h1/h2/h3, otherwise "Slide N"; the note is the
 * text of `<aside class="notes">` or of an element with `data-notes`.
 *
 * The parser is deliberately a tag scanner, and not a DOM: running a DOM in main
 * would cost a Chromium window per preview, and what is extracted here is shallow.
 */

export interface DeckSlideSummary {
  /** Display title (the same one the tab shows in the list). */
  title: string
  /** Presenter notes, plain text ('' when there are none). */
  notes: string
}

export interface DeckSummary {
  /** <title> of the document ('' when absent). */
  title: string
  slides: DeckSlideSummary[]
}

/** Ceiling of slides read — a real deck does not come close to it. */
const MAX_SLIDES = 300

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  hellip: '…',
}

/** Plain text of an HTML excerpt: tags out, entities resolved. */
export function plainText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (match, code: string) => {
      if (code.startsWith('#')) {
        const num = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10)
        return Number.isFinite(num) ? String.fromCodePoint(num) : match
      }
      return ENTITIES[code.toLowerCase()] ?? match
    })
    .replace(/\s+/g, ' ')
    .trim()
}

/** Attributes of an opening tag, without interpreting CSS or anything else. */
function attr(attrs: string, name: string): string | null {
  const pattern = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i')
  const match = pattern.exec(attrs)
  if (!match) return null
  return plainText(match[2] ?? match[3] ?? match[4] ?? '')
}

function isSlideOpen(attrs: string): boolean {
  const className = attr(attrs, 'class') ?? ''
  return className.split(/\s+/).includes('slide')
}

export interface DeckSlideBody {
  /** Attributes of the slide's opening tag (that is where `data-title` lives). */
  attrs: string
  /** What is between the opening and the closing tag. */
  body: string
}

/**
 * Body of each TOP-LEVEL `<section class="slide">`, in document order.
 * Nested sections belong to the slide that contains them (the same criterion as
 * the runtime), so the search skips whatever is already inside an open slide.
 */
export function slideBodies(html: string): DeckSlideBody[] {
  const bodies: DeckSlideBody[] = []
  const tag = /<(\/?)section\b([^>]*)>/gi
  let depth = 0
  let slideStart = -1
  let slideDepth = -1
  let match: RegExpExecArray | null

  while ((match = tag.exec(html))) {
    const closing = match[1] === '/'
    if (!closing) {
      if (slideStart < 0 && isSlideOpen(match[2])) {
        slideStart = match.index
        slideDepth = depth
      }
      depth++
      continue
    }
    depth--
    if (slideStart >= 0 && depth === slideDepth) {
      // The `</section>` that closes the slide: the body is what lies between the opening
      // tag and this closing one.
      const openTagEnd = html.indexOf('>', slideStart)
      bodies.push({
        attrs: html.slice(slideStart, openTagEnd).replace(/^<section\b/i, '').trim(),
        body: html.slice(openTagEnd + 1, match.index),
      })
      slideStart = -1
      slideDepth = -1
      if (bodies.length >= MAX_SLIDES) break
    }
  }
  return bodies
}

/** Title of a slide: `data-title`, otherwise the first heading, otherwise "Slide N". */
export function slideTitle(body: string, attrs: string | null, index: number): string {
  const explicit = attrs ? attr(attrs, 'data-title') : null
  if (explicit && explicit.trim()) return explicit.trim()
  const heading = /<(h1|h2|h3)\b[^>]*>([\s\S]*?)<\/\1>/i.exec(body)
  const text = heading ? plainText(heading[2]) : ''
  return text || `Slide ${index + 1}`
}

/**
 * Presenter notes. Two forms, with different semantics:
 *
 *   <aside class="notes">the text</aside>   → the element's TEXT
 *   <div data-notes="the text">…</div>      → the VALUE of the attribute
 *
 * If the element has `data-notes` filled in, it wins (it is the explicit form);
 * with no value, the content counts — the same rule as the runtime.
 */
export function slideNotes(body: string): string {
  const marked = /<([a-z][a-z0-9]*)\b([^>]*\bdata-notes\b[^>]*)>([\s\S]*?)<\/\1>/i.exec(body)
  if (marked) {
    const value = attr(marked[2], 'data-notes')
    if (value && value.trim()) return value.trim()
    return plainText(marked[3])
  }
  const aside = /<aside\b([^>]*)>([\s\S]*?)<\/aside>/gi
  let match: RegExpExecArray | null
  while ((match = aside.exec(body))) {
    const className = attr(match[1], 'class') ?? ''
    if (className.split(/\s+/).includes('notes')) return plainText(match[2])
  }
  return ''
}

/** Stage size declared by the deck (the default when there is no meta). */
export interface DeckSize {
  width: number
  height: number
}

/**
 * The stage size, read from `<meta name="orbit-slides">`.
 *
 * The runtime already does this reading in the browser, to scale; here it exists
 * again because the PDF is printed in the MAIN PROCESS, far from the deck: without
 * knowing the real size, the PDF page would come out 16:9 and a 4:3 deck (or a
 * 1920x1080 one) would be cropped or shrunk with a white margin on the sides.
 *
 * Same parse as the runtime, and for the same reason: `width=1920,height=1080`,
 * separated by comma or semicolon. An invalid value falls back to the default.
 */
export function parseDeckSize(html: string, fallback: DeckSize): DeckSize {
  let width = fallback.width
  let height = fallback.height
  const meta = /<meta\b[^>]*name=["']orbit-slides["'][^>]*>/i.exec(html)
  if (!meta) return { width, height }
  const content = attr(meta[0], 'content') ?? ''
  for (const pair of content.split(/[,;]/)) {
    const at = pair.indexOf('=')
    if (at < 0) continue
    const key = pair.slice(0, at).trim().toLowerCase()
    const num = Number(pair.slice(at + 1).trim())
    if (!Number.isFinite(num) || num <= 0) continue
    if (key === 'width') width = Math.round(num)
    if (key === 'height') height = Math.round(num)
  }
  return { width, height }
}

/** Summary of the deck read from the file. */
export function readDeckSummary(html: string): DeckSummary {
  const titleTag = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  // The opening attributes come along with the body: the `data-title` lives in the tag,
  // not inside it.
  const slides = slideBodies(html).map(({ attrs, body }, index) => ({
    title: slideTitle(body, attrs, index),
    notes: slideNotes(body),
  }))

  return {
    title: titleTag ? plainText(titleTag[1]) : '',
    slides,
  }
}
