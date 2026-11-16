import { describe, expect, it } from 'vitest'
import type { DocumentTextView } from '@orbit/companion-client'
import { buildSourceHtml, citedRange, parseSourceHref, rescueLegacyCitations, sourceToText } from './document-source'

const colors = { background: '#fff', foreground: '#000', muted: '#888', border: '#ddd', accent: '#fa0', highlight: 'rgba(1,2,3,.2)' }
const view: DocumentTextView = {
  id: 'doc1',
  filename: 'a.pdf',
  kind: 'pdf',
  totalPages: 2,
  pages: [
    { num: 1, lines: ['alpha', 'beta <b>'] },
    { num: 2, lines: ['gamma', '', 'delta'] },
  ],
  hasOriginal: true,
  originalKind: 'pdf',
}
const pageTitle = (p: { num: number }) => `Page ${p.num}`

describe('parseSourceHref', () => {
  it('reads page and line range', () => {
    expect(parseSourceHref('#orbit-source/doc1/p3L4-6')).toEqual({ docId: 'doc1', page: 3, fromLine: 4, toLine: 6 })
    expect(parseSourceHref('#orbit-source/src12/p1')).toEqual({ docId: 'src12', page: 1, fromLine: undefined, toLine: undefined })
    expect(parseSourceHref('#orbit-source/doc1/p2L7')?.toLine).toBeUndefined()
  })
  it('rejects invented ids and other links', () => {
    expect(parseSourceHref('#orbit-source/src?/p1')).toBeNull()
    expect(parseSourceHref('https://example.com')).toBeNull()
    expect(parseSourceHref('#orbit-memory/mem_abc123')).toBeNull()
  })
})

describe('rescueLegacyCitations', () => {
  it('rewrites the old scheme to the fragment', () => {
    expect(rescueLegacyCitations('see [1](orbit-source://doc1/p2)')).toBe('see [1](#orbit-source/doc1/p2)')
    expect(rescueLegacyCitations('plain')).toBe('plain')
  })
})

describe('citedRange', () => {
  it('needs a first line and never ends before it', () => {
    expect(citedRange({ page: 1 })).toBeNull()
    expect(citedRange({ page: 1, fromLine: 3 })).toEqual({ from: 3, to: 3 })
    expect(citedRange({ page: 1, fromLine: 3, toLine: 2 })).toEqual({ from: 3, to: 3 })
  })
})

describe('buildSourceHtml', () => {
  it('draws a heading per page and escapes the text', () => {
    const html = buildSourceHtml(view, { pageTitle, colors })
    expect(html).toContain('<h2 id="p1">Page 1</h2>')
    expect(html).toContain('<h2 id="p2">Page 2</h2>')
    expect(html).toContain('beta &lt;b&gt;')
    expect(html).not.toContain('beta <b>')
  })
  it('marks only the cited lines of the cited page', () => {
    const html = buildSourceHtml(view, { pageTitle, colors, cite: { page: 2, fromLine: 1, toLine: 2 } })
    expect(html.match(/class="l cited"/g)).toHaveLength(2)
    expect(html).toContain('<div class="l cited"><span class="n">1</span><span class="t">gamma')
    expect(html).toContain('<div class="l"><span class="n">1</span><span class="t">alpha')
  })
})

describe('sourceToText', () => {
  it('joins pages with a blank line', () => {
    expect(sourceToText(view)).toBe('alpha\nbeta <b>\n\ngamma\n\ndelta')
  })
})
