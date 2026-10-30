import { describe, expect, it } from 'vitest'
import { DOCX_PAGE_BREAK_MARK, splitDocxPages, splitOnPageBreaks } from '@shared/page-breaks'

describe('splitOnPageBreaks', () => {
  it('cuts at the instruction lines and leaves no `\\pagebreak` in the text', () => {
    const pages = splitOnPageBreaks('# Um\n\ntexto\n\n\\pagebreak\n\n# Dois\n\nmais')
    expect(pages).toEqual(['# Um\n\ntexto', '# Dois\n\nmais'])
  })

  it('returns a single page when there is no break', () => {
    expect(splitOnPageBreaks('# Um\n\ntexto')).toEqual(['# Um\n\ntexto'])
  })

  it('does not confuse the instruction in the middle of a sentence', () => {
    expect(splitOnPageBreaks('use \\pagebreak para quebrar')).toEqual([
      'use \\pagebreak para quebrar',
    ])
  })

  it('accepts spaces around the instruction', () => {
    expect(splitOnPageBreaks('a\n   \\pagebreak   \nb')).toEqual(['a', 'b'])
  })
})

describe('splitDocxPages', () => {
  it("cuts at the paragraph of the mark and discards it", () => {
    const html = `<p>um</p><p>${DOCX_PAGE_BREAK_MARK}</p><p>dois</p>`
    expect(splitDocxPages(html)).toEqual(['<p>um</p>', '<p>dois</p>'])
  })

  it('one sheet when the document has no mark', () => {
    expect(splitDocxPages('<p>um</p><p>dois</p>')).toEqual(['<p>um</p><p>dois</p>'])
  })

  it('preserves the blank page between two consecutive breaks', () => {
    const html = `<p>um</p><p>${DOCX_PAGE_BREAK_MARK}</p><p>${DOCX_PAGE_BREAK_MARK}</p><p>três</p>`
    expect(splitDocxPages(html)).toEqual(['<p>um</p>', '', '<p>três</p>'])
  })
})
