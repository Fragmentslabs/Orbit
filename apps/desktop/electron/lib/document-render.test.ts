import { describe, expect, it } from 'vitest'

import {
  headingSize,
  normalizeStyle,
  parseInline,
  parseMarkdown,
  renderHtml,
  renderOoxmlBody,
  renderThumbHtml,
  type Block,
} from './document-render'

/**
 * The document's source is a single one and feeds three outputs (HTML, PDF, DOCX). Two
 * failures here are silent:
 *
 * 1. Unrecognized syntax disappearing instead of becoming a paragraph — the document
 *    delivered to the user loses text without warning anyone.
 * 2. Badly escaped XML — the .docx simply does not open, and the error only shows up in
 *    Word, far from here.
 */

describe('parseMarkdown', () => {
  it('recognizes three levels of headings', () => {
    const blocks = parseMarkdown('# One\n## Two\n### Three')
    expect(blocks.map((b) => b.type === 'heading' && b.level)).toEqual([1, 2, 3])
  })

  it('joins consecutive lines into one paragraph and splits on a blank line', () => {
    const blocks = parseMarkdown('line one\nline two\n\nanother paragraph')
    expect(blocks).toHaveLength(2)
    expect(blocks[0]).toEqual({ type: 'paragraph', text: 'line one line two' })
  })

  it('tells a bulleted list from a numbered list', () => {
    const blocks = parseMarkdown('- a\n- b\n\n1. x\n2. y')
    const items = blocks.filter((b): b is Extract<Block, { type: 'listItem' }> => b.type === 'listItem')
    expect(items).toHaveLength(4)
    expect(items.slice(0, 2).every((i) => !i.ordered)).toBe(true)
    expect(items.slice(2).every((i) => i.ordered)).toBe(true)
  })

  it('reads a table with a header and rows', () => {
    const blocks = parseMarkdown('| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |')
    const table = blocks[0]
    expect(table.type).toBe('table')
    if (table.type !== 'table') return
    expect(table.header).toEqual(['a', 'b'])
    expect(table.rows).toEqual([['1', '2'], ['3', '4']])
  })

  it('text with vertical bars but NO divider does not become a table', () => {
    // Treating this as a table would destroy the user's sentence.
    const blocks = parseMarkdown('| this is not | a table |')
    expect(blocks[0].type).toBe('paragraph')
  })

  it('a page break is its own block', () => {
    const blocks = parseMarkdown('a\n\n\\pagebreak\n\nb')
    expect(blocks.map((b) => b.type)).toEqual(['paragraph', 'pageBreak', 'paragraph'])
  })

  it('blockquote and horizontal rule', () => {
    const blocks = parseMarkdown('> citado\n\n---')
    expect(blocks.map((b) => b.type)).toEqual(['quote', 'rule'])
  })

  it('unknown syntax becomes a paragraph instead of disappearing', () => {
    const blocks = parseMarkdown('~~riscado~~ e ![img](x.png)')
    expect(blocks).toHaveLength(1)
    expect(blocks[0].type).toBe('paragraph')
    expect((blocks[0] as Extract<Block, { type: 'paragraph' }>).text).toContain('riscado')
  })

  it('an empty document does not break', () => {
    expect(parseMarkdown('')).toEqual([])
    expect(parseMarkdown('\n\n   \n')).toEqual([])
  })
})

describe('parseInline', () => {
  it('splits bold, italics and code', () => {
    const runs = parseInline('normal **bold** and *light* and `code`')
    expect(runs.find((r) => r.bold)?.text).toBe('bold')
    expect(runs.find((r) => r.italic)?.text).toBe('light')
    expect(runs.find((r) => r.code)?.text).toBe('code')
  })

  it('text without markup becomes a single run', () => {
    expect(parseInline('plain')).toEqual([{ text: 'plain' }])
  })

  it('never returns an empty list', () => {
    expect(parseInline('')).toHaveLength(1)
  })
})

describe('renderHtml', () => {
  it('groups consecutive items into a single list', () => {
    const html = renderHtml(parseMarkdown('- a\n- b\n- c'), 'T')
    expect(html.match(/<ul>/g)).toHaveLength(1)
    expect(html.match(/<li>/g)).toHaveLength(3)
  })

  it('switching the list type opens a new list', () => {
    const html = renderHtml(parseMarkdown('- a\n\n1. b'), 'T')
    expect(html).toContain('<ul>')
    expect(html).toContain('<ol>')
  })

  it('escapes HTML in the content — user text does not become markup', () => {
    const html = renderHtml(parseMarkdown('<script>alert(1)</script>'), 'T')
    expect(html).not.toContain('<script>alert')
    expect(html).toContain('&lt;script&gt;')
  })

  it('escapes the title too', () => {
    expect(renderHtml([], '<b>x</b>')).toContain('&lt;b&gt;')
  })

  it('carries print CSS, because this HTML also becomes the PDF', () => {
    const html = renderHtml([], 'T')
    expect(html).toContain('@page')
    expect(html).toContain('A4')
  })
})

describe('renderOoxmlBody', () => {
  it('a heading becomes a Word Heading style', () => {
    expect(renderOoxmlBody(parseMarkdown('## Summary'))).toContain('w:val="Heading2"')
  })

  it('bulleted and numbered lists use different numIds', () => {
    const xml = renderOoxmlBody(parseMarkdown('- a\n\n1. b'))
    expect(xml).toContain('w:numId w:val="1"')
    expect(xml).toContain('w:numId w:val="2"')
  })

  it('the table comes out with borders — without them Word draws no lines at all', () => {
    const xml = renderOoxmlBody(parseMarkdown('| a |\n|---|\n| 1 |'))
    expect(xml).toContain('<w:tbl>')
    expect(xml).toContain('w:tblBorders')
  })

  it('escapes XML — that is what separates a .docx that opens from one that does not', () => {
    const xml = renderOoxmlBody(parseMarkdown('a < b & c > d and "quotes"'))
    expect(xml).toContain('&lt;')
    expect(xml).toContain('&amp;')

    // Inside <w:t> no raw "<" can be left behind, nor an "&" that does not start an
    // entity — both cases make Word refuse the file.
    const contents = [...xml.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)].map((m) => m[1])
    expect(contents.length).toBeGreaterThan(0)
    for (const text of contents) {
      expect(text).not.toContain('<')
      expect(text.replace(/&(?:amp|lt|gt|quot|apos|#\d+);/g, '')).not.toContain('&')
    }
  })

  it('negrito vira w:b', () => {
    expect(renderOoxmlBody(parseMarkdown('**bold**'))).toContain('<w:b/>')
  })

  it('the page break applies to the NEXT block, not the previous one', () => {
    const xml = renderOoxmlBody(parseMarkdown('before\n\n\\pagebreak\n\nafter'))
    const breakAt = xml.indexOf('pageBreakBefore')
    const before = xml.indexOf('before')
    const after = xml.indexOf('after')
    expect(breakAt).toBeGreaterThan(before)
    expect(breakAt).toBeLessThan(after)
  })

  it('a break before a table is not lost (w:tbl does not accept pageBreakBefore)', () => {
    const xml = renderOoxmlBody(parseMarkdown('a\n\n\\pagebreak\n\n| h |\n|---|\n| 1 |'))
    expect(xml).toContain('pageBreakBefore')
    expect(xml).toContain('<w:tbl>')
  })
})

describe('renderHtml — page break', () => {
  it('applies the break to the NEXT block, not as an empty element', () => {
    // An empty <div class="page-break"></div> is collapsed by Chromium and the
    // PDF comes out with a single page — it was exactly the bug found in the spike.
    const html = renderHtml(parseMarkdown('before\n\n\\pagebreak\n\n## After'), 'T')
    expect(html).not.toContain('<div class="page-break"></div>')
    expect(html).toContain('<h2 class="page-break">')
  })

  it('a break before a list marks the list', () => {
    const html = renderHtml(parseMarkdown('a\n\n\\pagebreak\n\n- item'), 'T')
    expect(html).toContain('<ul class="page-break">')
  })

  it('a break before a table marks the table', () => {
    const html = renderHtml(parseMarkdown('a\n\n\\pagebreak\n\n| h |\n|---|\n| 1 |'), 'T')
    expect(html).toContain('<table class="page-break">')
  })

  it('with no break no block gets the class', () => {
    expect(renderHtml(parseMarkdown('a\n\n## b'), 'T')).not.toContain('page-break"')
  })
})

/**
 * Fill-in line and line break: the two cases that showed up in a really generated
 * exam and came out wrong on the user's screen.
 */
describe('parseInline — form', () => {
  it('a fill-in line survives whole', () => {
    const runs = parseInline('Name: ______________________')
    expect(runs.map((r) => r.text).join('')).toBe('Name: ______________________')
    expect(runs.some((r) => r.bold || r.italic)).toBe(false)
  })

  it('bold after underscores is still recognized', () => {
    // "__ **Date:** __" matched as underscore italic and SWALLOWED the
    // **Date:**, which came out raw in the document.
    const runs = parseInline('**Name:** ____________ **Date:** __/__/__')
    const bolds = runs.filter((r) => r.bold).map((r) => r.text)
    expect(bolds).toEqual(['Name:', 'Date:'])
    expect(runs.map((r) => r.text).join('')).toContain('__/__/__')
  })

  it('an underscore inside a word does not become emphasis', () => {
    const runs = parseInline('the variable user_name_id stays whole')
    expect(runs).toHaveLength(1)
    expect(runs[0].italic).toBeUndefined()
  })

  it('the asterisk still works for bold and italics', () => {
    const runs = parseInline('**bold** and *light*')
    expect(runs.find((r) => r.bold)?.text).toBe('bold')
    expect(runs.find((r) => r.italic)?.text).toBe('light')
  })
})

describe('parseInline — <br>', () => {
  it('becomes a line break instead of escaped text', () => {
    const runs = parseInline('a<br>b')
    expect(runs.map((r) => (r.br ? "|" : r.text)).join('')).toBe('a|b')
  })

  it('accepts the variations the model writes', () => {
    for (const tag of ['<br>', '<br/>', '<br />', '<BR>']) {
      expect(parseInline(`x${tag}y`).filter((r) => r.br)).toHaveLength(1)
    }
  })

  it('in HTML it comes out as <br>, not escaped', () => {
    const html = renderHtml(parseMarkdown('a) 245 + 138 = ______<br><br>b) 356'), 'T')
    expect(html).toContain('<br>')
    expect(html).not.toContain('&lt;br&gt;')
  })

  it('in DOCX it comes out as w:br inside the paragraph', () => {
    expect(renderOoxmlBody(parseMarkdown('a<br>b'))).toContain('<w:br/>')
  })

  it('other HTML stays escaped — only <br> is interpreted', () => {
    const html = renderHtml(parseMarkdown('<script>x</script> e <b>y</b>'), 'T')
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('&lt;b&gt;')
  })
})

/**
 * The style comes from the MODEL. Two failures here are serious and silent: a
 * malicious or mangled value becomes invalid CSS/XML — at best the document looks
 * odd, at worst the .docx does not open.
 */
describe('normalizeStyle', () => {
  it('without a style, returns the default', () => {
    const s = normalizeStyle()
    expect(s.fontFamily).toBe('Georgia')
    expect(s.fontSize).toBe(11)
    expect(s.columns).toBe(1)
  })

  it('accepts the valid values', () => {
    const s = normalizeStyle({ fontFamily: 'Calibri', fontSize: 13, accentColor: '#1f4e79', marginCm: 1.5, columns: 2, align: 'left' })
    expect(s).toEqual({
      fontFamily: 'Calibri', fontSize: 13, accentColor: '1F4E79',
      marginCm: 1.5, columns: 2, align: 'left',
    })
  })

  it('sanitizes the font — a name with punctuation would inject CSS/XML', () => {
    const s = normalizeStyle({ fontFamily: 'Arial"; } body { display:none } /*' })
    expect(s.fontFamily).not.toMatch(/["';{}/*]/)
    expect(s.fontFamily.startsWith('Arial')).toBe(true)
  })

  it('an invalid color falls back to the default instead of broken XML', () => {
    for (const bad of ['red', '#12', 'rgb(1,2,3)', '"><script>', '']) {
      expect(normalizeStyle({ accentColor: bad }).accentColor).toBe('111111')
    }
  })

  it('accepts hex with and without #, normalizing to uppercase', () => {
    expect(normalizeStyle({ accentColor: '#abcdef' }).accentColor).toBe('ABCDEF')
    expect(normalizeStyle({ accentColor: 'abcdef' }).accentColor).toBe('ABCDEF')
  })

  it('numbers out of range are clamped, not rejected', () => {
    expect(normalizeStyle({ fontSize: 200 }).fontSize).toBe(18)
    expect(normalizeStyle({ fontSize: 1 }).fontSize).toBe(7)
    expect(normalizeStyle({ columns: 99 }).columns).toBe(3)
    expect(normalizeStyle({ marginCm: -5 }).marginCm).toBe(0.5)
  })

  it('a non-numeric value does not become NaN in the CSS', () => {
    const s = normalizeStyle({ fontSize: Number.NaN, marginCm: undefined })
    expect(s.fontSize).toBe(11)
    expect(s.marginCm).toBe(2.5)
  })

  it('headings scale with the body', () => {
    const large = normalizeStyle({ fontSize: 14 })
    expect(headingSize(large, 1)).toBeGreaterThan(headingSize(normalizeStyle(), 1))
    expect(headingSize(large, 1)).toBeGreaterThan(headingSize(large, 2))
  })
})

describe('style applied to the outputs', () => {
  const style = { fontFamily: 'Calibri', fontSize: 13, accentColor: '#1F4E79', columns: 2, marginCm: 1.5 }

  it('HTML carries font, size, color and columns', () => {
    const html = renderHtml(parseMarkdown('# Title'), 'T', style)
    expect(html).toContain("'Calibri'")
    expect(html).toContain('13pt')
    expect(html).toContain('#1F4E79')
    expect(html).toContain('column-count: 2')
  })

  it('DOCX carries the color in the heading', () => {
    // OOXML uses hex without "#"; with it Word ignores the color silently.
    const xml = renderOoxmlBody(parseMarkdown('| a |\n|---|\n| 1 |'), style)
    expect(xml).toContain('w:fill="1F4E79"')
    expect(xml).not.toContain('#1F4E79')
  })

  it('a single column emits no column rule', () => {
    expect(renderHtml(parseMarkdown('x'), 'T', { columns: 1 })).not.toContain('column-count')
  })
})

describe('table alignment', () => {
  const md = '| left | center | right |\n|:---|:---:|---:|\n| a | b | c |'

  it('the divider sets the alignment of each column', () => {
    const table = parseMarkdown(md)[0]
    expect(table.type).toBe('table')
    if (table.type !== 'table') return
    expect(table.align).toEqual(['left', 'center', 'right'])
  })

  it('in HTML it becomes a class per cell', () => {
    const html = renderHtml(parseMarkdown(md), 'T')
    expect(html).toContain('<th class="c">')
    expect(html).toContain('<td class="r">')
  })

  it('in DOCX it becomes w:jc in the cell paragraph — aligning the cell would not move the text', () => {
    const xml = renderOoxmlBody(parseMarkdown(md))
    expect(xml).toContain('<w:jc w:val="center"/>')
    expect(xml).toContain('<w:jc w:val="right"/>')
  })

  it('a table with no alignment markup stays all left', () => {
    const table = parseMarkdown('| a | b |\n|---|---|\n| 1 | 2 |')[0]
    if (table.type !== 'table') return
    expect(table.align).toEqual(['left', 'left'])
  })
})


/**
 * Fenced code block. Before this, ``` fell into the paragraph branch and the
 * lines were joined by a space — the code reached the document in a single
 * line, with the markers showing. Since technical documentation is the most
 * common use of the document, it is the case that showed up broken the most.
 */
describe('miniatura nativa', () => {
  const blocks = parseMarkdown('# Guia\n\nTexto.\n\n```ts\nconst a = 1\n```')

  it('brings both palettes on the same page', () => {
    const html = renderThumbHtml(blocks, 'Guia')

    // The capture changes theme by toggling the class, without reloading anything.
    expect(html).toContain(':root.dark')
    expect(html).toMatch(/--bg:/)
  })

  it('it is not the printed sheet: no A4, no page margin', () => {
    const html = renderThumbHtml(blocks, 'Guia')

    expect(html).not.toContain('@page')
    expect(html).not.toContain('cm')
  })

  it('draws the same blocks as the document', () => {
    const html = renderThumbHtml(blocks, 'Guia')

    expect(html).toContain('<h1>Guia</h1>')
    expect(html).toContain('<pre><code>const a = 1</code></pre>')
  })
})

describe('code block', () => {
  it('keeps the raw lines, without joining or trimming', () => {
    const blocks = parseMarkdown('Before:\n\n```ts\nclass A {\n  x = 1\n}\n```\n\nAfter.')

    expect(blocks).toEqual([
      { type: 'paragraph', text: 'Before:' },
      { type: 'code', lines: ['class A {', '  x = 1', '}'], lang: 'ts' },
      { type: 'paragraph', text: 'After.' },
    ])
  })

  it('does not interpret Markdown in there', () => {
    const blocks = parseMarkdown('```sh\n# installs everything\n- npm i\n| a | b |\n```')

    expect(blocks).toEqual([
      { type: 'code', lines: ['# installs everything', '- npm i', '| a | b |'], lang: 'sh' },
    ])
  })

  it('an unclosed fence takes the rest of the text instead of losing it', () => {
    const blocks = parseMarkdown('```\nleft open\none more line')

    expect(blocks).toEqual([{ type: 'code', lines: ['left open', 'one more line'] }])
  })

  it('the HTML comes out in <pre>, with breaks and symbols preserved', () => {
    const html = renderHtml(parseMarkdown('```ts\nif (a < b) {\n  go()\n}\n```'), 'T')

    expect(html).toContain('<pre><code>if (a &lt; b) {\n  go()\n}</code></pre>')
    // Without pre-wrap the long line comes out cut at the PDF's margin.
    expect(html).toContain('white-space: pre-wrap')
  })

  it('the DOCX comes out with one line per paragraph, in Courier and unjustified', () => {
    const xml = renderOoxmlBody(parseMarkdown('```\nline one\nline two\n```'))

    expect(xml.match(/w:pStyle w:val="CodeBlock"/g)).toHaveLength(2)
    expect(xml).toContain('<w:t xml:space="preserve">line one</w:t>')
    expect(xml).toContain('<w:t xml:space="preserve">line two</w:t>')
  })
})

describe('fontFamily coming in as a CSS stack', () => {
  it('keeps the first family, not the names glued together', () => {
    // What the model really sends when the schema asks for a name.
    expect(normalizeStyle({ fontFamily: 'Inter, Segoe UI, sans-serif' }).fontFamily).toBe('Inter')
  })

  it('quotes from the stack do not enter the name', () => {
    expect(normalizeStyle({ fontFamily: '"Times New Roman", serif' }).fontFamily).toBe(
      'Times New Roman',
    )
  })
})

describe('Markdown backslash', () => {
  it('the escaped date field comes out with the underscores, and without the slash', () => {
    // It came from a real case: the model escapes the underscores so the field does not
    // become bold ON SCREEN (where `__` is emphasis), and the same text becomes the PDF.
    // Without handling the escape, the document came out with "\_\_\_\_/\_\_\_\_" showing.
    expect(parseInline('Data: \\_\\_\\_\\_/\\_\\_\\_\\_/\\_\\_\\_\\_\\_\\_')).toEqual([
      { text: 'Data: ____/____/______' },
    ])
  })

  it('an escaped asterisk is an asterisk, not the start of italics', () => {
    expect(parseInline('3 \\* 4 = 12')).toEqual([{ text: '3 * 4 = 12' }])
  })

  it('the escape does not disturb real emphasis on the same line', () => {
    const runs = parseInline('**Data:** \\_\\_\\_\\_/\\_\\_\\_\\_')
    expect(runs).toEqual([{ text: 'Data:', bold: true }, { text: ' ____/____' }])
  })

  it('a lone backslash stays a backslash', () => {
    // Only Markdown punctuation is neutralized; "C:\temp" does not become "C:temp".
    expect(parseInline('path C:\\temp')).toEqual([{ text: 'path C:\\temp' }])
  })
})

describe('the library font in the document', () => {
  it('declares @font-face before the CSS, and nothing when the family is a system one', () => {
    const html = renderHtml([], 'T', { fontFamily: 'Inter' }, undefined, "@font-face{font-family:'Inter'}")
    expect(html).toContain('<style data-orbit-fonts>')
    expect(html.indexOf('data-orbit-fonts')).toBeLessThan(html.indexOf('<style>'))
    expect(renderHtml([], 'T', { fontFamily: 'Georgia' })).not.toContain('data-orbit-fonts')
  })
})

