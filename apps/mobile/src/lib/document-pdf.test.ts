import { describe, expect, it } from 'vitest'
import vm from 'node:vm'
import { parseDocMessage } from './document-web-script'
import { addPagesScript, buildPdfShell, citedText, locateText, pagesToFetch, pdfOutline, setupScript, squash } from './document-pdf'

const colors = { background: '#111', foreground: '#eee', muted: '#888', border: '#333', accent: '#fa0', highlight: 'rgba(1,2,3,.2)' }
const item = (text: string, x: number, y = 0.1) => ({ x, y, width: 0.1, height: 0.02, text })

describe('locateText', () => {
  const items = [item('a des', 0.1), item('tino', 0.2), item('other', 0.5, 0.3)]
  it('matches across items ignoring spaces and case', () => {
    const rects = locateText(items, 'A Destino')
    expect(rects.map((r) => r.x)).toEqual([0.1, 0.2])
  })
  it('finds every occurrence and ignores too-short needles', () => {
    expect(locateText([item('foo', 0.1), item('foo', 0.4)], 'foo')).toHaveLength(2)
    expect(locateText(items, 'a')).toEqual([])
    expect(locateText([], 'foo')).toEqual([])
  })
  it('squashes whitespace and lowercases', () => {
    expect(squash(' A  b\nC ')).toBe('abc')
  })
})

describe('citedText', () => {
  const view = { pages: [{ num: 2, lines: ['one', 'two', 'three'] }] }
  it('joins the cited lines of the cited page', () => {
    expect(citedText(view, { page: 2, fromLine: 2, toLine: 3 })).toBe('two three')
    expect(citedText(view, { page: 2, fromLine: 1 })).toBe('one')
  })
  it('is empty without a line or on a missing page', () => {
    expect(citedText(view, { page: 2 })).toBe('')
    expect(citedText(view, { page: 9, fromLine: 1 })).toBe('')
    expect(citedText(view, undefined)).toBe('')
  })
})

describe('pagesToFetch', () => {
  it('takes a batch from the page, skipping pages in hand and stopping at the total', () => {
    expect(pagesToFetch(1, 10, () => false)).toEqual([1, 2, 3])
    expect(pagesToFetch(9, 10, () => false)).toEqual([9, 10])
    expect(pagesToFetch(2, 10, (n) => n === 2)).toEqual([3, 4, 5])
    expect(pagesToFetch(2, 10, (n) => n === 3)).toEqual([2])
  })
})

describe('pdfOutline', () => {
  it('points entries at page containers and drops the ones without a page', () => {
    expect(
      pdfOutline([
        { title: 'Intro', page: 1, level: 0 },
        { title: 'Lost', page: null, level: 1 },
        { title: ' Deep ', page: 4, level: 2 },
      ]),
    ).toEqual([
      { id: 'pg1', title: 'Intro', level: 1 },
      { id: 'pg4', title: 'Deep', level: 3 },
    ])
  })
})

describe('shell', () => {
  it('is valid JavaScript and defines the protocol the viewer chrome calls', () => {
    const html = buildPdfShell(colors)
    const script = /<script>([\s\S]*)<\/script>/.exec(html)?.[1] ?? ''
    expect(() => new vm.Script(script)).not.toThrow()
    for (const name of ['find', 'step', 'clear', 'jump', 'zoom', 'init', 'setup', 'addPages']) {
      expect(script).toContain(`${name}:`)
    }
    expect(html).toContain('background:#111')
  })
  it('builds injectable calls', () => {
    expect(setupScript({ total: 3, aspect: 0.7, outline: [] })).toContain('"total":3')
    const call = addPagesScript([{ page: 1, dataUrl: 'data:image/png;base64,AA', width: 10, height: 20, items: [] }])
    expect(() => new vm.Script(call)).not.toThrow()
  })
})

describe('parseDocMessage need', () => {
  it('reads a page request and rejects nonsense', () => {
    expect(parseDocMessage('{"type":"need","page":4}')).toEqual({ type: 'need', page: 4 })
    expect(parseDocMessage('{"type":"need","page":0}')).toBeNull()
    expect(parseDocMessage('{"type":"need","page":"4"}')).toBeNull()
  })
})
