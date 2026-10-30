/**
 * Document authored by the agent: a Markdown source that becomes three outputs.
 *
 * Why Markdown and not HTML, since the artifacts are already HTML? Because the
 * destination here is DOCX and PDF, and HTML→DOCX is intractable: arbitrary CSS has no
 * equivalent in OOXML. Markdown has a small, closed vocabulary —
 * heading, paragraph, list, table — that maps directly to both formats,
 * and it is what the model writes best. The HTML artifact remains the way
 * for dashboard and prototype; a document is another object.
 *
 * The same source generates:
 *   - HTML  → preview in the conversation (and the origin of the PDF, via printToPDF)
 *   - OOXML → the .docx
 *
 * Pure module (no Electron, no IO) to be testable.
 */

export type CellAlign = 'left' | 'center' | 'right'

export type Block =
  | { type: 'heading'; level: 1 | 2 | 3; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'listItem'; text: string; ordered: boolean }
  | { type: 'quote'; text: string }
  | { type: 'table'; header: string[]; rows: string[][]; align: CellAlign[] }
  /** Code block surrounded by ``` — the lines go RAW, without joining or
   *  trimming, because indentation and line breaks are the content. */
  | { type: 'code'; lines: string[]; lang?: string }
  | { type: 'rule' }
  | { type: 'pageBreak' }

// ─── Diagrams ────────────────────────────────────────────────────────────

/**
 * A Mermaid diagram already drawn (see mermaid-render.ts): the SVG goes to the
 * HTML/PDF and the PNG to the .docx. Width and height in CSS px (96 dpi).
 */
export interface RenderedDiagram {
  svg: string
  png: Buffer
  width: number
  height: number
}

/**
 * Finds the diagram of a Mermaid source. Whoever renders does not know how to draw
 * — that requires DOM and lives in the main —, it only asks. A source with no answer falls
 * back to the code block, and the document comes out whole even with a broken diagram.
 */
export type DiagramLookup = (source: string) => RenderedDiagram | undefined

export const isMermaid = (block: Block): block is Extract<Block, { type: 'code' }> =>
  block.type === 'code' && block.lang?.toLowerCase() === 'mermaid'

/** The source of a ```mermaid block, the way the diagram renderer receives it. */
export const mermaidSource = (block: Extract<Block, { type: 'code' }>) =>
  block.lines.join('\n').trim()

/** The document's Mermaid sources, in the order they appear. */
export function mermaidSourcesOf(blocks: Block[]): string[] {
  return blocks.filter(isMermaid).map(mermaidSource).filter((src) => src.length > 0)
}

// ─── Document style ──────────────────────────────────────────────────────

/**
 * Document customization. It is a CLOSED set of options, and not free CSS,
 * for a hard reason: everything here has to exist in OOXML too. Arbitrary CSS
 * would render a beautiful PDF and a broken .docx, and the user would only
 * find out when opening the file in Word.
 */
export interface DocumentStyle {
  /** Font family. A name that does not exist on the reader's machine falls back
   *  to the fallback — both in the browser and in Word. */
  fontFamily?: string
  /** Body text in points. Headings scale proportionally. */
  fontSize?: number
  /** Accent color (hex): headings, table header and rules. */
  accentColor?: string
  /** Page margin in centimeters (counts for the PDF; on screen the margin is for
   *  reading). */
  marginCm?: number
  /** Text columns. Counts for the whole document. */
  columns?: number
  align?: 'left' | 'justify'
}

export interface ResolvedStyle {
  fontFamily: string
  fontSize: number
  accentColor: string
  marginCm: number
  columns: number
  align: 'left' | 'justify'
}

const DEFAULT_STYLE: ResolvedStyle = {
  fontFamily: 'Georgia',
  fontSize: 11,
  accentColor: '111111',
  marginCm: 2.5,
  columns: 1,
  align: 'justify',
}

/** Scale of the headings over the body — keeps the original proportion (11pt →
 *  20/15/12.5pt) at any base size. */
const HEADING_SCALE = [1.82, 1.36, 1.14]

/**
 * The style comes from the MODEL, so every field is validated before becoming CSS or an
 * XML attribute. A font name with `;}` would inject a rule into the document's CSS;
 * a color with quotes would break the XML and the .docx would not even open.
 */
export function normalizeStyle(style?: DocumentStyle): ResolvedStyle {
  // The model usually sends a CSS STACK ("Inter, Segoe UI, sans-serif")
  // where the schema asks for a name. Without splitting it, the cleanup below erased the
  // commas and left "Inter Segoe UI sans-serif" — a font that does not exist
  // on any machine, so the document fell back silently.
  const first = (style?.fontFamily ?? '').split(',')[0].replace(/["']/g, '')
  // The hyphen comes last in the class, where it is literal — no escape needed.
  const family = first.replace(/[^a-zA-Z0-9 -]/g, '').trim().slice(0, 40)
  const hex = (style?.accentColor ?? '').replace(/^#/, '')
  return {
    fontFamily: family || DEFAULT_STYLE.fontFamily,
    fontSize: clamp(style?.fontSize, 7, 18, DEFAULT_STYLE.fontSize),
    accentColor: /^[0-9a-fA-F]{6}$/.test(hex) ? hex.toUpperCase() : DEFAULT_STYLE.accentColor,
    marginCm: clamp(style?.marginCm, 0.5, 5, DEFAULT_STYLE.marginCm),
    columns: Math.round(clamp(style?.columns, 1, 3, DEFAULT_STYLE.columns)),
    align: style?.align === 'left' ? 'left' : DEFAULT_STYLE.align,
  }
}

function clamp(value: number | undefined, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

export function headingSize(style: ResolvedStyle, level: 1 | 2 | 3): number {
  return Math.round(style.fontSize * HEADING_SCALE[level - 1] * 10) / 10
}

/** Fallback stack: the requested font, then a compatible generic. Without this,
 *  a nonexistent name would leave the document in the system default font, which
 *  can be quite different from what the agent wanted. */
export function fontStack(style: ResolvedStyle): string {
  const monoish = /courier|mono|consolas/i.test(style.fontFamily)
  const sansish = /arial|helvetica|calibri|verdana|tahoma|segoe|roboto|inter|open sans|sans-serif/i.test(style.fontFamily)
  const generic = monoish ? 'monospace' : sansish ? 'sans-serif' : "'Times New Roman', serif"
  return `'${style.fontFamily}', ${generic}`
}

/** Explicit page break in the source — Markdown has no syntax for that
 *  and a multi-page document needs one. */
const PAGE_BREAK = /^\\pagebreak\s*$/i

/**
 * Code block fence. Without this, ``` fell into the paragraph branch and the
 * lines were JOINED BY A SPACE — the code reached the document in a single
 * line, with the raw markers showing. It is the syntax that appears most in
 * technical documentation, which is the most common use of the document.
 */
const FENCE = /^(`{3,}|~{3,})\s*([A-Za-z0-9+#._-]*)\s*$/

const HEADING = /^(#{1,3})\s+(.*)$/
const BULLET = /^[-*+]\s+(.*)$/
const ORDERED = /^\d+[.)]\s+(.*)$/
const QUOTE = /^>\s?(.*)$/
const RULE = /^(?:-{3,}|\*{3,}|_{3,})\s*$/
const TABLE_ROW = /^\|(.+)\|\s*$/
const TABLE_DIVIDER = /^\|[\s:|-]+\|\s*$/

function tableCells(line: string): string[] {
  return line
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((c) => c.trim())
}

/**
 * Alignment from the divider line (`|:---|:---:|---:|`).
 *
 * The divider was always ACCEPTED with `:` and the alignment discarded — a
 * table of values requested right-aligned came out all left, without warning. Reading it
 * here is what makes the syntax honest.
 */
function tableAlign(divider: string, columns: number): CellAlign[] {
  const marks = tableCells(divider)
  return Array.from({ length: columns }, (_, i) => {
    const mark = marks[i] ?? ''
    const left = mark.startsWith(':')
    const right = mark.endsWith(':')
    if (left && right) return 'center'
    if (right) return 'right'
    return 'left'
  })
}

/**
 * Markdown → blocks. It is a deliberate SUBSET: what exists in both
 * destination formats. Unrecognized syntax falls back as a paragraph instead of
 * being discarded — losing the user's text would be worse than formatting it badly.
 */
export function parseMarkdown(markdown: string): Block[] {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  const blocks: Block[] = []
  let paragraph: string[] = []

  const flushParagraph = () => {
    if (paragraph.length === 0) return
    blocks.push({ type: 'paragraph', text: paragraph.join(' ').trim() })
    paragraph = []
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trim()

    if (trimmed === '') {
      flushParagraph()
      continue
    }
    if (PAGE_BREAK.test(trimmed)) {
      flushParagraph()
      blocks.push({ type: 'pageBreak' })
      continue
    }
    if (RULE.test(trimmed)) {
      flushParagraph()
      blocks.push({ type: 'rule' })
      continue
    }

    // The fence is tested BEFORE the rule and the rest: inside it nothing is
    // interpreted, otherwise a shell `# comment` would become a heading.
    const fence = FENCE.exec(trimmed)
    if (fence) {
      flushParagraph()
      const marker = fence[1][0]
      const size = fence[1].length
      const code: string[] = []
      i += 1
      while (i < lines.length) {
        const closing = FENCE.exec(lines[i].trim())
        // It only closes with the SAME character and at least the same length: it is what
        // lets a Markdown block contain a smaller fence inside.
        if (closing && closing[1][0] === marker && closing[1].length >= size) break
        code.push(lines[i])
        i += 1
      }
      // Unclosed fence: the block enters anyway, up to the end of the text.
      // Discarding would be losing the content because of a missing marker.
      blocks.push({ type: 'code', lines: code, ...(fence[2] ? { lang: fence[2] } : {}) })
      continue
    }

    const heading = HEADING.exec(trimmed)
    if (heading) {
      flushParagraph()
      blocks.push({
        type: 'heading',
        level: heading[1].length as 1 | 2 | 3,
        text: heading[2].trim(),
      })
      continue
    }

    // Table: header line followed by the divider line. Without the divider
    // it is not a table — it is text with vertical bars, and treating it as a table
    // would destroy the content.
    if (TABLE_ROW.test(trimmed) && i + 1 < lines.length && TABLE_DIVIDER.test(lines[i + 1].trim())) {
      flushParagraph()
      const header = tableCells(trimmed)
      i += 1 // consumes the divider, but reads its alignment before
      const align = tableAlign(lines[i].trim(), header.length)
      const rows: string[][] = []
      while (i + 1 < lines.length && TABLE_ROW.test(lines[i + 1].trim())) {
        i += 1
        rows.push(tableCells(lines[i].trim()))
      }
      blocks.push({ type: 'table', header, rows, align })
      continue
    }

    const bullet = BULLET.exec(trimmed)
    if (bullet) {
      flushParagraph()
      blocks.push({ type: 'listItem', text: bullet[1].trim(), ordered: false })
      continue
    }
    const ordered = ORDERED.exec(trimmed)
    if (ordered) {
      flushParagraph()
      blocks.push({ type: 'listItem', text: ordered[1].trim(), ordered: true })
      continue
    }
    const quote = QUOTE.exec(trimmed)
    if (quote) {
      flushParagraph()
      blocks.push({ type: 'quote', text: quote[1].trim() })
      continue
    }

    paragraph.push(trimmed)
  }
  flushParagraph()
  return blocks
}

// ─── Inline ──────────────────────────────────────────────────────────────

export interface InlineRun {
  text: string
  bold?: boolean
  italic?: boolean
  code?: boolean
  /** Line break inside the paragraph (came from a <br> in the source). */
  br?: boolean
}

/**
 * Emphasis ONLY with asterisk and backtick — `_` and `__` were deliberately left
 * out.
 *
 * In a document, a run of underscores is almost never emphasis: it is a fill-in
 * line ("Name: ______"), which is the daily bread of forms, exams and
 * cards. With the underscore rule active, `__ **Date:** __` matched as a single
 * italic and SWALLOWED the `**Date:**` in the middle — the document came out with the
 * raw marker visible. The model can always use * and **; the fill-in
 * line has no alternative.
 */
const INLINE = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/
/** <br>, <br/> and <br /> — what the model writes to open up space for an answer. */
const LINE_BREAK = /<br\s*\/?>/gi

/**
 * Characters that the backslash neutralizes, as Markdown dictates.
 *
 * Here the reason is concrete: the model writes `\\_\\_\\_\\_/\\_\\_\\_\\_` to draw a
 * date field that does not become bold ON SCREEN (where the underscore is emphasis), and
 * that same text becomes the PDF. Without handling the escape, the document came out with the
 * backslash showing — the problem changed places instead of going away.
 */
const ESCAPABLE = /\\([\\`*_{}[\]()#+\-.!|>~])/g
/** Marker of the escaped character while the emphasis is split. It never shows up
 *  in a real document, which is the requirement to serve as a marker. */
const MASK = '\u0000'

function maskEscapes(text: string): string {
  return text.replace(ESCAPABLE, (_all, char: string) => `${MASK}${char.charCodeAt(0)}${MASK}`)
}

function unmaskEscapes(text: string): string {
  return text.replace(
    new RegExp(`${MASK}(\\d+)${MASK}`, 'g'),
    (_all, code: string) => String.fromCharCode(Number(code)),
  )
}

/**
 * Splits the text into runs with markup. A single pass, without nesting:
 * bold inside italic is rare in a generated document and the cost of supporting it
 * (a real parser) does not pay for itself here.
 */
export function parseInline(text: string): InlineRun[] {
  const runs: InlineRun[] = []
  // The <br> is handled BEFORE the emphasis: it is structure, not style, and it has to
  // survive the HTML escape that the rest of the content goes through.
  const segments = text.split(LINE_BREAK)
  segments.forEach((segment, index) => {
    if (index > 0) runs.push({ text: '', br: true })
    // The escaped character leaves the scene before the emphasis split: that is what
    // makes `\*` an asterisk in the text, and not the start of an italic.
    for (const part of maskEscapes(segment).split(INLINE)) {
      if (part === '') continue
      const push = (run: InlineRun) => runs.push({ ...run, text: unmaskEscapes(run.text) })
      if (/^\*\*[\s\S]+\*\*$/.test(part)) push({ text: part.slice(2, -2), bold: true })
      else if (/^`[\s\S]+`$/.test(part)) push({ text: part.slice(1, -1), code: true })
      else if (/^\*[\s\S]+\*$/.test(part)) push({ text: part.slice(1, -1), italic: true })
      else push({ text: part })
    }
  })
  return runs.length > 0 ? runs : [{ text: '' }]
}

const escapeXml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

// ─── HTML (preview and origin of the PDF) ──────────────────────────────

function inlineHtml(text: string): string {
  return parseInline(text)
    .map((run) => {
      if (run.br) return '<br>'
      const escaped = escapeXml(run.text)
      if (run.bold) return `<strong>${escaped}</strong>`
      if (run.italic) return `<em>${escaped}</em>`
      if (run.code) return `<code>${escaped}</code>`
      return escaped
    })
    .join('')
}

/**
 * CSS of a printed document, not of a web page: measurements in centimeters, font
 * from the chosen style, controlled page break. It is the same HTML that becomes
 * the PDF, so the preview's content is the file's.
 */
function documentCss(style: ResolvedStyle): string {
  const accent = `#${style.accentColor}`
  // Table header and rules use the accent color with transparency, so that
  // a strong accent does not become an illegible solid band.
  const columns =
    style.columns > 1
      ? `column-count: ${style.columns}; column-gap: 1cm;`
      : ''
  return `
  /*
   * Margin ONLY in the body padding. With @page margin also set, the two
   * added up: the PDF came out with 5cm at the top instead of 2.5cm, and 25 lines
   * fit where 30 fit.
   */
  @page { size: A4; margin: 0; }
  :root { color-scheme: light }
  body { margin: 0; padding: ${style.marginCm}cm ${Math.max(0.5, style.marginCm - 0.5)}cm;
         background: #fff; color: #111;
         font: ${style.fontSize}pt/1.6 ${fontStack(style)}; ${columns} }
  h1 { font-size: ${headingSize(style, 1)}pt; margin: 0 0 .6em; color: ${accent}; }
  h2 { font-size: ${headingSize(style, 2)}pt; margin: 1.4em 0 .4em; color: ${accent}; }
  h3 { font-size: ${headingSize(style, 3)}pt; margin: 1.2em 0 .3em; color: ${accent}; }
  p { margin: 0 0 .7em; text-align: ${style.align}; }
  ul, ol { margin: 0 0 .7em 1.4em; padding: 0; }
  li { margin: 0 0 .25em; }
  blockquote { margin: 0 0 .7em; padding-left: 1em; border-left: 3px solid ${accent}; color: #444; }
  code { font-family: 'Courier New', monospace; font-size: .92em; background: #f3f3f3; padding: .1em .3em; }
  /*
   * Code block. The pre-wrap is not decoration: on an A4 sheet a long line
   * with no break comes out CUT in the PDF, and whatever crosses the margin simply
   * is not printed. And the alignment goes back to the left because the body of the
   * document may be justified, which in code spaces the symbols out.
   */
  pre { margin: 0 0 .8em; padding: .6em .8em; background: #f6f7f9;
        border: 1px solid #e4e6ea; border-left: 3px solid ${accent};
        font-family: 'Courier New', monospace; font-size: ${Math.max(7, style.fontSize - 1.5)}pt;
        line-height: 1.45; text-align: left; white-space: pre-wrap;
        overflow-wrap: break-word; break-inside: avoid; }
  /* Inside the block the <code> does not repeat the background or the padding of the inline. */
  pre code { background: none; padding: 0; font-size: 1em; }
  /* Mermaid diagram: the SVG comes with its natural width and shrinks to fit the
     column, never being split between two pages. */
  .diagram { margin: .4em 0 1em; text-align: center; break-inside: avoid; }
  .diagram svg { max-width: 100%; height: auto; }
  hr { border: 0; border-top: 1px solid ${accent}; margin: 1.2em 0; opacity: .35; }
  table { border-collapse: collapse; width: 100%; margin: 0 0 .9em;
          font-size: ${Math.max(7, style.fontSize - 1)}pt; }
  th, td { border: 1px solid #bbb; padding: .35em .5em; vertical-align: top; }
  th { background: ${accent}; color: #fff; font-weight: bold; }
  /* Alignment coming from the table divider (|:---:|) */
  .c { text-align: center; } .r { text-align: right; } .l { text-align: left; }
  /* A table split between columns becomes unreadable; the column breaks before it. */
  table, blockquote { break-inside: avoid; }
  /* break-before is the modern name; page-break-before stays as a fallback.
     The class goes on the block that follows the break, never on an empty element. */
  .page-break { break-before: page; page-break-before: always; }

  /*
   * ON SCREEN the document uses a reading margin, not a printing one. The preview
   * fits the card width and renders at natural size — without shrinking by
   * transform, which is what left the text small and soft. With 2.5cm of
   * margin in a chat column little text would be left per line.
   *
   * printToPDF respects @media print and ignores @media screen (verified),
   * so the delivered file keeps the document margin.
   */
  @media screen {
    body { padding: 1.2cm 1.4cm; }
  }
  @media print {
    body { padding: ${style.marginCm}cm ${Math.max(0.5, style.marginCm - 0.5)}cm; }
  }
`
}

/**
 * The blocks in HTML, without page or style — it is what the printed document and the
 * native thumbnail have in common. Each one puts its own CSS around it.
 */
function htmlBody(blocks: Block[], diagrams?: DiagramLookup): string {
  const parts: string[] = []
  let list: { ordered: boolean; items: string[] } | null = null
  /**
   * The break is applied to the FOLLOWING block, never as an element of its own: an empty
   * `<div class="page-break">` is collapsed by Chromium and
   * page-break-before simply does not happen — the PDF came out with a single
   * page. Same strategy as renderOoxmlBody.
   */
  let pendingBreak = false
  const breakClass = () => {
    if (!pendingBreak) return ''
    pendingBreak = false
    return ' class="page-break"'
  }

  const flushList = () => {
    if (!list) return
    const tag = list.ordered ? 'ol' : 'ul'
    parts.push(
      `<${tag}${breakClass()}>${list.items.map((i) => `<li>${inlineHtml(i)}</li>`).join('')}</${tag}>`,
    )
    list = null
  }

  for (const block of blocks) {
    if (block.type !== 'listItem') flushList()
    switch (block.type) {
      case 'heading':
        parts.push(`<h${block.level}${breakClass()}>${inlineHtml(block.text)}</h${block.level}>`)
        break
      case 'paragraph':
        parts.push(`<p${breakClass()}>${inlineHtml(block.text)}</p>`)
        break
      case 'quote':
        parts.push(`<blockquote${breakClass()}>${inlineHtml(block.text)}</blockquote>`)
        break
      case 'code': {
        const diagram = isMermaid(block) ? diagrams?.(mermaidSource(block)) : undefined
        if (diagram) {
          const brk = breakClass()
          parts.push(`<figure class="diagram${brk ? ' page-break' : ''}">${diagram.svg}</figure>`)
          break
        }
        parts.push(
          `<pre${breakClass()}><code>${block.lines.map(escapeXml).join('\n')}</code></pre>`,
        )
        break
      }
      case 'rule':
        parts.push(`<hr${breakClass()}>`)
        break
      case 'pageBreak':
        pendingBreak = true
        break
      case 'table': {
        // Alignment class per COLUMN, coming from the Markdown divider.
        const cls = (i: number) => {
          const a = block.align[i] ?? 'left'
          return a === 'center' ? ' class="c"' : a === 'right' ? ' class="r"' : ''
        }
        const head = block.header.map((c, i) => `<th${cls(i)}>${inlineHtml(c)}</th>`).join('')
        const body = block.rows
          .map((row) => `<tr>${row.map((c, i) => `<td${cls(i)}>${inlineHtml(c)}</td>`).join('')}</tr>`)
          .join('')
        parts.push(
          `<table${breakClass()}><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`,
        )
        break
      }
      case 'listItem':
        if (!list || list.ordered !== block.ordered) {
          flushList()
          list = { ordered: block.ordered, items: [] }
        }
        list.items.push(block.text)
        break
    }
  }
  flushList()
  return parts.join('\n')
}

export function renderHtml(
  blocks: Block[],
  title: string,
  style?: DocumentStyle,
  diagrams?: DiagramLookup,
  /**
   * `@font-face` of a font from Orbit's library. It goes before the document's CSS
   * because the PDF is printed from its own window (orbit-artifact://)
   * and that is the only way Chromium knows the family: a name without a declaration falls
   * back, and the PDF would come out with the wrong font without telling anyone.
   */
  fontFaces?: string,
): string {
  const fontStyle = fontFaces ? `<style data-orbit-fonts>${fontFaces}</style>\n` : ''
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeXml(title)}</title>
${fontStyle}<style>${documentCss(normalizeStyle(style))}</style>
</head><body>
${htmlBody(blocks, diagrams)}
</body></html>`
}

/**
 * The THUMBNAIL of a live document in Markdown.
 *
 * The gallery tile is the document's cover, so it has to look like what the
 * user sees when opening: the native screen in Orbit's theme, and not the white A4 sheet
 * — that is the face of the PDF, and only what was requested as a file deserves it.
 *
 * It comes out with BOTH palettes on the same page, swapped by a class on the
 * <html>: the capture loads the page once and photographs both themes, which
 * avoids a second Chromium window and keeps the tile right even when the
 * user switches the theme later.
 *
 * The colors are the app tokens (index.css), in oklch — Chromium understands them, and
 * copying the values is what makes the tile match the grid around it. The
 * font does not: Geist is bundled by the renderer and does not exist in this window, hence
 * the system stack.
 */
export function renderThumbHtml(
  blocks: Block[],
  title: string,
  diagrams?: DiagramLookup,
): string {
  const body = htmlBody(blocks, diagrams)
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8">
<title>${escapeXml(title)}</title>
<style>
  :root { color-scheme: light;
    --bg: oklch(1 0 0); --fg: oklch(0.141 0.005 285.823);
    --muted: oklch(0.967 0.001 286.375); --muted-fg: oklch(0.552 0.016 285.938);
    --border: oklch(0.92 0.004 286.32); }
  :root.dark { color-scheme: dark;
    --bg: oklch(0.141 0.005 285.823); --fg: oklch(0.985 0 0);
    --muted: oklch(0.274 0.006 286.033); --muted-fg: oklch(0.705 0.015 286.067);
    --border: oklch(1 0 0 / 14%); }
  body { margin: 0; padding: 34px 40px; background: var(--bg); color: var(--fg);
         font: 15px/1.65 ui-sans-serif, 'Segoe UI', system-ui, sans-serif; }
  h1 { font-size: 1.7em; margin: 0 0 .5em; font-weight: 600; letter-spacing: -.01em; }
  h2 { font-size: 1.3em; margin: 1.2em 0 .4em; font-weight: 600; }
  h3 { font-size: 1.1em; margin: 1em 0 .3em; font-weight: 600; }
  p { margin: 0 0 .7em; }
  ul, ol { margin: 0 0 .7em 1.3em; padding: 0; }
  li { margin: 0 0 .25em; }
  blockquote { margin: 0 0 .7em; padding-left: .9em; border-left: 2px solid var(--border);
               color: var(--muted-fg); }
  code { font-family: ui-monospace, 'Cascadia Mono', Consolas, monospace; font-size: .88em;
         background: var(--muted); border-radius: 4px; padding: .1em .35em; }
  pre { margin: 0 0 .8em; padding: .7em .9em; background: var(--muted);
        border: 1px solid var(--border); border-radius: 8px;
        font-family: ui-monospace, 'Cascadia Mono', Consolas, monospace; font-size: .82em;
        line-height: 1.5; white-space: pre-wrap; overflow-wrap: break-word; }
  pre code { background: none; padding: 0; font-size: 1em; }
  hr { border: 0; border-top: 1px solid var(--border); margin: 1.2em 0; }
  table { border-collapse: collapse; width: 100%; margin: 0 0 .8em; font-size: .9em; }
  th, td { border: 1px solid var(--border); padding: .35em .5em; text-align: left; }
  th { background: var(--muted); font-weight: 600; }
  .c { text-align: center; } .r { text-align: right; }
  /* The diagram is drawn on a light background; in the dark theme it becomes a white
     card instead of dark lines fading into the background. */
  .diagram { margin: 0 0 .8em; padding: .6em; background: #fff; border-radius: 8px;
             text-align: center; }
  .diagram svg { max-width: 100%; height: auto; }
</style>
</head><body>
${body}
</body></html>`
}

// ─── OOXML (the .docx) ─────────────────────────────────────────────

function inlineOoxml(text: string): string {
  return parseInline(text)
    .map((run) => {
      // In OOXML the break inside the paragraph is a single run with <w:br/>.
      if (run.br) return '<w:r><w:br/></w:r>'
      const props: string[] = []
      if (run.bold) props.push('<w:b/>')
      if (run.italic) props.push('<w:i/>')
      if (run.code) props.push('<w:rFonts w:ascii="Courier New" w:hAnsi="Courier New"/>')
      const rPr = props.length > 0 ? `<w:rPr>${props.join('')}</w:rPr>` : ''
      return `<w:r>${rPr}<w:t xml:space="preserve">${escapeXml(run.text)}</w:t></w:r>`
    })
    .join('')
}

/** numId of the list definitions declared in numbering.xml. */
const NUM_BULLET = 1
const NUM_ORDERED = 2

function paragraphOoxml(
  content: string,
  opts: { style?: string; numId?: number; pageBreak?: boolean; after?: number } = {},
): string {
  const pPr: string[] = []
  // In the schema order of pPr: pStyle, pageBreakBefore, numPr, spacing.
  if (opts.style) pPr.push(`<w:pStyle w:val="${opts.style}"/>`)
  if (opts.pageBreak) pPr.push('<w:pageBreakBefore/>')
  if (opts.numId) pPr.push(`<w:numPr><w:ilvl w:val="0"/><w:numId w:val="${opts.numId}"/></w:numPr>`)
  if (opts.after !== undefined) pPr.push(`<w:spacing w:after="${opts.after}"/>`)
  const props = pPr.length > 0 ? `<w:pPr>${pPr.join('')}</w:pPr>` : ''
  return `<w:p>${props}${content}</w:p>`
}

function tableOoxml(
  header: string[],
  rows: string[][],
  align: CellAlign[],
  style: ResolvedStyle,
): string {
  /** In OOXML the alignment belongs to the PARAGRAPH inside the cell (w:jc), not to the
   *  cell — aligning the cell does not move the text. */
  const jc = (i: number) => {
    const a = align[i] ?? 'left'
    return a === 'left' ? '' : `<w:jc w:val="${a}"/>`
  }
  const cell = (text: string, i: number, isHeader: boolean) => {
    // Header with the accent color filled in and white text, mirroring the
    // CSS — without w:shd Word draws the header like the body.
    const shading = isHeader
      ? `<w:shd w:val="clear" w:color="auto" w:fill="${style.accentColor}"/>`
      : ''
    const content = isHeader
      ? `<w:r><w:rPr><w:b/><w:color w:val="FFFFFF"/></w:rPr><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r>`
      : inlineOoxml(text)
    return `<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/>${shading}</w:tcPr><w:p><w:pPr>${jc(i)}</w:pPr>${content}</w:p></w:tc>`
  }
  const headerRow = `<w:tr>${header.map((c, i) => cell(c, i, true)).join('')}</w:tr>`
  const bodyRows = rows
    .map((row) => `<w:tr>${row.map((c, i) => cell(c, i, false)).join('')}</w:tr>`)
    .join('')
  // Explicit borders: without tblBorders Word draws the table with no lines at all.
  const borders = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
    .map((side) => `<w:${side} w:val="single" w:sz="4" w:color="999999"/>`)
    .join('')
  return `<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/><w:tblBorders>${borders}</w:tblBorders></w:tblPr>${headerRow}${bodyRows}</w:tbl>`
}

/**
 * An image already registered in the package: the rId points to the PNG in word/media,
 * and the size is the diagram's natural one in CSS px.
 */
export interface DocxImage {
  rId: string
  width: number
  height: number
}

/** EMU per CSS px (96 dpi) and per cm — OOXML's drawing units. */
const EMU_PER_PX = 9525
const EMU_PER_CM = 360000
/** Height ceiling: a diagram taller than this does not fit on an A4 sheet. */
const MAX_IMAGE_HEIGHT_CM = 22

/**
 * The centered paragraph with the inline image. It shrinks (without distorting) to
 * the usable width of the column — the PNG is 2x, so shrinking loses no sharpness.
 */
function imageOoxml(
  image: DocxImage,
  drawingId: number,
  maxWidthEmu: number,
  pageBreak: boolean,
): string {
  let cx = image.width * EMU_PER_PX
  let cy = image.height * EMU_PER_PX
  const k = Math.min(1, maxWidthEmu / cx, (MAX_IMAGE_HEIGHT_CM * EMU_PER_CM) / cy)
  cx = Math.round(cx * k)
  cy = Math.round(cy * k)
  const name = `Diagram ${drawingId}`
  const A = 'http://schemas.openxmlformats.org/drawingml/2006/main'
  const drawing =
    `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">` +
    `<wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${drawingId}" name="${name}"/>` +
    `<wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="${A}" noChangeAspect="1"/></wp:cNvGraphicFramePr>` +
    `<a:graphic xmlns:a="${A}">` +
    `<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
    `<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
    `<pic:nvPicPr><pic:cNvPr id="${drawingId}" name="${name}"/><pic:cNvPicPr/></pic:nvPicPr>` +
    `<pic:blipFill><a:blip r:embed="${image.rId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
    `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
    `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>` +
    `</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`
  // jc on the paragraph itself: the body may be justified, and an image
  // "justified" stays against the left margin.
  // The order inside pPr is the schema's (pageBreakBefore, spacing, jc): the
  // Word refuses the file when it comes swapped.
  return `<w:p><w:pPr>${
    pageBreak ? '<w:pageBreakBefore/>' : ''
  }<w:spacing w:before="120" w:after="200"/><w:jc w:val="center"/></w:pPr>${drawing}</w:p>`
}

/**
 * Body of document.xml from the blocks. `images` answers, by Mermaid source,
 * the image the package already registered; the document that uses it needs to
 * declare the wp and r namespaces (see buildDocx).
 */
export function renderOoxmlBody(
  blocks: Block[],
  style?: DocumentStyle,
  images?: (source: string) => DocxImage | undefined,
): string {
  const resolved = normalizeStyle(style)
  const parts: string[] = []
  let pendingBreak = false
  let drawingId = 0
  // Usable width of ONE column: A4 minus the side margins (the same as in
  // buildDocx), divided by the columns discounting the space between them.
  const sideCm = Math.max(0.5, resolved.marginCm - 0.5)
  const columnCm = (21 - 2 * sideCm - (resolved.columns - 1) * 0.75) / resolved.columns
  const maxWidthEmu = Math.round(columnCm * EMU_PER_CM)

  for (const block of blocks) {
    switch (block.type) {
      case 'heading':
        parts.push(paragraphOoxml(inlineOoxml(block.text), { style: `Heading${block.level}`, pageBreak: pendingBreak }))
        break
      case 'paragraph':
        parts.push(paragraphOoxml(inlineOoxml(block.text), { pageBreak: pendingBreak }))
        break
      case 'quote':
        parts.push(paragraphOoxml(inlineOoxml(block.text), { style: 'Quote', pageBreak: pendingBreak }))
        break
      case 'listItem':
        parts.push(
          paragraphOoxml(inlineOoxml(block.text), {
            style: 'ListParagraph',
            numId: block.ordered ? NUM_ORDERED : NUM_BULLET,
            pageBreak: pendingBreak,
          }),
        )
        break
      case 'table':
        // The page break does not apply to a table (there is no
        // pageBreakBefore in w:tbl): it enters as an empty paragraph before it.
        if (pendingBreak) parts.push(paragraphOoxml('', { pageBreak: true }))
        parts.push(tableOoxml(block.header, block.rows, block.align, resolved))
        break
      case 'code': {
        const image = isMermaid(block) ? images?.(mermaidSource(block)) : undefined
        if (image) {
          parts.push(imageOoxml(image, ++drawingId, maxWidthEmu, pendingBreak))
          break
        }
        // One line per PARAGRAPH: OOXML has no pre-formatted block
        // element, and a paragraph with only <w:br/> would lose the gray
        // background line by line. An empty block still yields a paragraph, otherwise
        // ``` ``` would disappear without leaving a trace.
        const lines = block.lines.length > 0 ? block.lines : ['']
        lines.forEach((line, idx) => {
          parts.push(
            paragraphOoxml(`<w:r><w:t xml:space="preserve">${escapeXml(line)}</w:t></w:r>`, {
              style: 'CodeBlock',
              pageBreak: pendingBreak && idx === 0,
              // The style zeroes the spacing between the block's lines; the last
              // one gives the breathing room back, otherwise the following text sticks to the code.
              ...(idx === lines.length - 1 ? { after: 160 } : {}),
            }),
          )
        })
        break
      }
      case 'rule':
        parts.push(
          `<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:color="AAAAAA"/></w:pBdr>${
            pendingBreak ? '<w:pageBreakBefore/>' : ''
          }</w:pPr></w:p>`,
        )
        break
      case 'pageBreak':
        pendingBreak = true
        continue
    }
    pendingBreak = false
  }
  return parts.join('')
}
