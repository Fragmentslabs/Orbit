import { describe, expect, it } from 'vitest'

import {
  capPages,
  documentHeader,
  documentKindOf,
  isDocumentPath,
  pageLabel,
  pageLocator,
  pageWindow,
  paginateText,
  type DocumentPage,
  type ExtractedDocument,
} from './document-pages'

/**
 * The documents layer exists so that a 300-page PDF NEVER enters
 * whole into the context. Two failures here are silent and expensive:
 *
 * 1. The window returning more than what was asked for — the cost blows up again without
 *    anyone noticing, because the answer remains "right".
 * 2. The header not announcing that there is more document — the model answers as
 *    if it had read the whole thing, which is the exact mistake pagination avoids.
 */

const doc = (pages: DocumentPage[], over: Partial<ExtractedDocument> = {}): ExtractedDocument => ({
  kind: 'pdf',
  pages,
  totalPages: pages.length,
  totalChars: pages.reduce((n, p) => n + p.text.length, 0),
  truncated: false,
  ...over,
})

const page = (num: number, text = `text ${num}`): DocumentPage => ({ num, text })

describe('documentKindOf', () => {
  it('recognizes the supported formats, without depending on case', () => {
    expect(documentKindOf('spec.pdf')).toBe('pdf')
    expect(documentKindOf('REQUIREMENTS.PDF')).toBe('pdf')
    expect(documentKindOf('contract.docx')).toBe('docx')
    expect(documentKindOf('costs.xlsx')).toBe('spreadsheet')
    expect(documentKindOf('data.csv')).toBe('spreadsheet')
  })

  it('does not capture code files — plain text read is still their path', () => {
    expect(documentKindOf('index.ts')).toBeNull()
    expect(documentKindOf('README.md')).toBeNull()
    expect(isDocumentPath('app/main.rs')).toBe(false)
  })

  it('does not confuse an extension in the middle of the name', () => {
    expect(isDocumentPath('report.pdf.bak')).toBe(false)
  })
})

describe('paginateText', () => {
  it('breaks at a paragraph, never in the middle of a sentence', () => {
    const paragraph = 'a'.repeat(400)
    const pages = paginateText([paragraph, paragraph, paragraph].join('\n\n'), 500)
    expect(pages.length).toBeGreaterThan(1)
    for (const p of pages) expect(p.text).not.toMatch(/^a{1,399}$/)
  })

  it('numbers from 1 and in sequence', () => {
    const pages = paginateText(Array.from({ length: 6 }, () => 'x'.repeat(300)).join('\n\n'), 400)
    expect(pages.map((p) => p.num)).toEqual(pages.map((_, i) => i + 1))
  })

  it('empty text still returns one page — the caller never gets an empty list', () => {
    expect(paginateText('')).toHaveLength(1)
  })

  it('a paragraph larger than the target is not split (it becomes one big page)', () => {
    const giant = 'z'.repeat(5000)
    const pages = paginateText(giant, 1000)
    expect(pages).toHaveLength(1)
    expect(pages[0].text).toHaveLength(5000)
  })
})

describe('capPages', () => {
  it('cuts preserving whole pages and signals the cut', () => {
    const result = capPages([page(1, 'aaaa'), page(2, 'bbbb'), page(3, 'cccc')], 'pdf', 9)
    expect(result.pages).toHaveLength(2)
    expect(result.truncated).toBe(true)
    expect(result.pages.at(-1)!.text).toBe('bbbb')
  })

  it('a document within the limit is not marked as cut', () => {
    const result = capPages([page(1, 'aa'), page(2, 'bb')], 'pdf', 100)
    expect(result.truncated).toBe(false)
    expect(result.totalPages).toBe(2)
  })
})

describe('pageWindow', () => {
  const d = doc(Array.from({ length: 50 }, (_, i) => page(i + 1)))

  it('without offset it starts at the first page and respects the default', () => {
    const { from, to, pages } = pageWindow(d, undefined, undefined, 3, 20)
    expect(from).toBe(1)
    expect(to).toBe(3)
    expect(pages).toHaveLength(3)
  })

  it('a limit above the ceiling is cut — that is what keeps the whole document from coming in one call', () => {
    expect(pageWindow(d, 1, 999, 3, 20).pages).toHaveLength(20)
  })

  it('an offset past the end lands on the last page instead of returning empty', () => {
    const { from, pages } = pageWindow(d, 999, 2, 3, 20)
    expect(from).toBe(50)
    expect(pages).toHaveLength(1)
  })

  it('offset 0 or negative is normalized to the first page', () => {
    expect(pageWindow(d, 0, 2, 3, 20).from).toBe(1)
    expect(pageWindow(d, -5, 2, 3, 20).from).toBe(1)
  })
})

describe('documentHeader', () => {
  it('announces that there is more document and how to continue', () => {
    const header = documentHeader('spec.pdf', doc(Array.from({ length: 40 }, (_, i) => page(i + 1))), {
      from: 1,
      to: 3,
    })
    expect(header).toContain('pages="40"')
    expect(header).toContain('offset=4')
  })

  it('on the last page it does not suggest continuing', () => {
    const header = documentHeader('spec.pdf', doc([page(1), page(2)]), { from: 1, to: 2 })
    expect(header).not.toContain('offset=')
  })

  it('a spreadsheet is announced in sheets, not pages', () => {
    const sheet = doc([{ num: 1, text: 'a', label: 'Costs' }], { kind: 'spreadsheet' })
    expect(documentHeader('c.xlsx', sheet, { from: 1, to: 1 })).toContain('sheets="1"')
  })

  it('a cut document warns about the cut', () => {
    const truncatedDoc = doc([page(1)], { truncated: true })
    expect(documentHeader('g.pdf', truncatedDoc, { from: 1, to: 1 })).toContain('truncated')
  })
})

describe('pageLabel', () => {
  it('uses the sheet name when it exists', () => {
    expect(pageLabel({ num: 2, text: '', label: 'Costs' }, 'spreadsheet')).toBe('sheet "Costs"')
  })

  it('DOCX speaks of blocks, because the pagination there is synthetic', () => {
    expect(pageLabel({ num: 2, text: '' }, 'docx')).toBe('block 2')
  })

  it('PDF speaks of pages, which is the real pagination of the file', () => {
    expect(pageLabel({ num: 12, text: '' }, 'pdf')).toBe('p. 12')
  })
})

/**
 * The locator is what the agent CITES to the user and what it uses as
 * the offset. Saying "p12" in a DOCX would make the model point to a page Word
 * does not have (the pagination there is synthetic), and in a spreadsheet it would make "page 3"
 * mean the third sheet.
 */
describe('pageLocator', () => {
  it('PDF uses pages, which is the real pagination of the file', () => {
    expect(pageLocator({ num: 12, text: '' }, 'pdf')).toBe('p12')
  })

  it('DOCX does not pretend to have a Word page', () => {
    const locator = pageLocator({ num: 12, text: '' }, 'docx')
    expect(locator).toBe('block12')
    expect(locator).not.toMatch(/^p\d/)
  })

  it('a spreadsheet carries the sheet name along with the offset', () => {
    expect(pageLocator({ num: 3, text: '', label: 'Costs' }, 'spreadsheet')).toBe('sheet3 (Costs)')
  })

  it('always carries the number that serves as the read offset', () => {
    for (const kind of ['pdf', 'docx', 'spreadsheet'] as const) {
      expect(pageLocator({ num: 7, text: '' }, kind)).toContain('7')
    }
  })
})
