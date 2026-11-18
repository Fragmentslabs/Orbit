import { describe, expect, it } from 'vitest'
import { buildMarkdownHtml, isHtmlDocument, isMarkdownSource, markdownOf, markdownToHtml } from './document-markdown'

const colors = { background: '#fff', foreground: '#000', muted: '#888', border: '#ddd', accent: '#fa0', highlight: 'rgba(1,2,3,.2)' }
const view = (filename: string, lines: string[][], kind: 'text' | 'pdf' = 'text') => ({
  filename,
  kind,
  pages: lines.map((l, i) => ({ num: i + 1, lines: l })),
})

describe('isMarkdownSource', () => {
  it('accepts markdown files only', () => {
    expect(isMarkdownSource(view('README.md', [['# a']]))).toBe(true)
    expect(isMarkdownSource(view('notes.markdown', [['x']]))).toBe(true)
    expect(isMarkdownSource(view('notes.txt', [['# a']]))).toBe(false)
    expect(isMarkdownSource(view('a.md', [['# a']], 'pdf'))).toBe(false)
  })
  it('leaves an HTML page saved as .md in text mode', () => {
    expect(isMarkdownSource(view('page.md', [['<!DOCTYPE html>', '<html>']]))).toBe(false)
    expect(isHtmlDocument('# Title\nmentions <body> later'.padStart(3000, ' '))).toBe(false)
  })
})

describe('markdownOf', () => {
  it('joins the reading pages with a blank line', () => {
    expect(markdownOf(view('a.md', [['one', 'two'], ['three']]))).toBe('one\ntwo\n\nthree')
  })
})

describe('markdownToHtml', () => {
  it('renders headings, tables and code', () => {
    const html = markdownToHtml('# T\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```\ncode\n```')
    expect(html).toContain('<h1>T</h1>')
    expect(html).toContain('<table>')
    expect(html).toContain('<pre><code>')
  })
  it('never runs raw HTML', () => {
    const html = markdownToHtml('<script>alert(1)</script> and <img src=x onerror=y>')
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;script&gt;')
  })
  it('draws links as text and keeps images to https', () => {
    expect(markdownToHtml('[go](https://a.com)')).toContain('<span class="a">go</span>')
    expect(markdownToHtml('[go](https://a.com)')).not.toContain('<a ')
    expect(markdownToHtml('![x](file:///etc/passwd)')).not.toContain('<img')
    expect(markdownToHtml('![x](https://a.com/i.png)')).toContain('<img src="https://a.com/i.png"')
  })
})

describe('buildMarkdownHtml', () => {
  it('wraps the body in the palette', () => {
    const html = buildMarkdownHtml('# T', colors)
    expect(html).toContain('background:#fff')
    expect(html).toContain('<h1>T</h1>')
  })
})
