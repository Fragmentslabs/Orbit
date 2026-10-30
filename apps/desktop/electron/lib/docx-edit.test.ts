import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'

import { applyReplacements, applyStructural, type Replacement, type StructuralEdits } from './docx-edit'

const _require = createRequire(import.meta.url)
const { DOMParser, XMLSerializer } = _require('@xmldom/xmldom') as typeof import('@xmldom/xmldom')

/**
 * The risk of this layer is RUN FRAGMENTATION: Word breaks a sentence into
 * several <w:r> because of revision marks and spell checker, so the sentence you read in the
 * document almost never exists as a contiguous string in the XML. A naive search
 * finds nothing — and the agent would report "edited" without having edited.
 */

/** Builds a paragraph with one <w:r> per piece — imitates the real fragmentation. */
function paragraph(...pieces: string[]): string {
  const runs = pieces
    .map((t) => `<w:r><w:t xml:space="preserve">${t}</w:t></w:r>`)
    .join('')
  return `<w:document xmlns:w="w"><w:body><w:p>${runs}</w:p></w:body></w:document>`
}

function run(xml: string, replacements: Replacement[]) {
  const doc = new DOMParser().parseFromString(xml, 'text/xml')
  const applied = applyReplacements(doc as never, replacements)
  const out = new XMLSerializer().serializeToString(doc as never)
  // A <w:t> left empty is serialized self-closed (<w:t/>); ignoring that
  // case would make the regex match across the tag and "leak" XML into the text.
  const text = [...out.matchAll(/<w:t[^>]*\/>|<w:t[^>]*>([\s\S]*?)<\/w:t>/g)]
    .map((m) => m[1] ?? '')
    .join('')
  return { applied, text, xml: out }
}

describe('applyReplacements', () => {
  it('replaces text contained in a single run', () => {
    const r = run(paragraph('The deadline is ninety days.'), [
      { find: 'ninety days', replace: 'one hundred and twenty days' },
    ])
    expect(r.applied).toEqual([1])
    expect(r.text).toBe('The deadline is one hundred and twenty days.')
  })

  it('replaces text SPLIT across runs — the case a naive search misses', () => {
    const r = run(paragraph('The deadline is nin', 'ety', ' days.'), [
      { find: 'ninety days', replace: 'one hundred and twenty days' },
    ])
    expect(r.applied).toEqual([1])
    expect(r.text).toBe('The deadline is one hundred and twenty days.')
  })

  it('the new text goes into the FIRST run, inheriting its formatting', () => {
    const xml = `<w:document xmlns:w="w"><w:body><w:p>` +
      `<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">nin</w:t></w:r>` +
      `<w:r><w:t xml:space="preserve">ety days</w:t></w:r>` +
      `</w:p></w:body></w:document>`
    const r = run(xml, [{ find: 'ninety days', replace: 'one hundred and twenty days' }])
    // The bold run is the one that starts carrying the whole text.
    expect(r.xml).toMatch(/<w:b\/><\/w:rPr><w:t[^>]*>one hundred and twenty days<\/w:t>/)
    expect(r.text).toBe('one hundred and twenty days')
  })

  it('without `all`, replaces only the first occurrence', () => {
    const r = run(paragraph('ACME and ACME'), [{ find: 'ACME', replace: 'BETA' }])
    expect(r.applied).toEqual([1])
    expect(r.text).toBe('BETA and ACME')
  })

  it('with `all`, replaces every one', () => {
    const r = run(paragraph('ACME and ACME and ACME'), [{ find: 'ACME', replace: 'BETA', all: true }])
    expect(r.applied).toEqual([3])
    expect(r.text).toBe('BETA and BETA and BETA')
  })

  it('a replacement containing the searched text does not loop forever', () => {
    // "X" -> "XY" with all: finding the result itself again would repeat
    // forever. The test fails by timeout if the protection disappears.
    const r = run(paragraph('value X here'), [{ find: 'X', replace: 'XY', all: true }])
    expect(r.text).toBe('value XY here')
  })

  it('replacing with empty deletes the stretch', () => {
    const r = run(paragraph('text [DRAFT] final'), [{ find: ' [DRAFT]', replace: '' }])
    expect(r.text).toBe('text final')
  })

  it('a missing stretch returns zero instead of failing', () => {
    const r = run(paragraph('nothing here'), [{ find: 'inexistente', replace: 'x' }])
    expect(r.applied).toEqual([0])
    expect(r.text).toBe('nothing here')
  })

  it('counts each replacement separately, in the order received', () => {
    const r = run(paragraph('A and B'), [
      { find: 'A', replace: '1' },
      { find: 'missing', replace: 'x' },
      { find: 'B', replace: '2' },
    ])
    expect(r.applied).toEqual([1, 0, 1])
    expect(r.text).toBe('1 and 2')
  })

  it('preserves xml:space when the new text has leading or trailing spaces', () => {
    const r = run(paragraph('a', 'b'), [{ find: 'ab', replace: ' c ' }])
    expect(r.xml).toContain('xml:space="preserve"')
    expect(r.text).toBe(' c ')
  })

  it('an empty search does nothing — it would insert everywhere', () => {
    const r = run(paragraph('text'), [{ find: '', replace: 'x', all: true }])
    expect(r.applied).toEqual([0])
    expect(r.text).toBe('text')
  })
})

/**
 * Structure: what the text swap cannot reach. What is at stake is the
 * same — the formatting of the user's document —, and the guarantee comes from cloning
 * XML that already exists instead of writing new XML.
 */
function structure(body: string, edits: StructuralEdits) {
  const xml = `<w:document xmlns:w="w"><w:body>${body}</w:body></w:document>`
  const doc = new DOMParser().parseFromString(xml, 'text/xml')
  const result = applyStructural(doc as never, edits)
  const out = new XMLSerializer().serializeToString(doc as never)
  const paragraphs = [...out.matchAll(/<w:p[ >][\s\S]*?<\/w:p>|<w:p\/>/g)].map((m) =>
    [...m[0].matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)].map((t) => t[1]).join(''),
  )
  return { result, xml: out, paragraphs }
}

const ITEM = (text: string) =>
  `<w:p><w:pPr><w:pStyle w:val="NumberedList"/><w:numPr><w:numId w:val="3"/></w:numPr></w:pPr>` +
  `<w:r><w:rPr><w:rFonts w:ascii="Calibri"/></w:rPr><w:t>${text}</w:t></w:r></w:p>`

const CELL = (text: string) =>
  `<w:tc><w:tcPr><w:tcBorders><w:top w:val="single"/></w:tcBorders></w:tcPr>` +
  `<w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:tc>`

describe('applyStructural', () => {
  it('the new item inherits style, numbering and font from the anchor item', () => {
    const r = structure(ITEM('Volume and capacity') + ITEM('Equations'), {
      insert: [{ after: 'Volume and capacity', text: 'Generating fraction' }],
    })
    expect(r.result.insert).toEqual([1])
    expect(r.paragraphs).toEqual(['Volume and capacity', 'Generating fraction', 'Equations'])
    // Three paragraphs in the numbered list, with the same font: the new one is a clone.
    expect(r.xml.match(/w:numId w:val="3"/g)).toHaveLength(3)
    expect(r.xml.match(/w:ascii="Calibri"/g)).toHaveLength(3)
  })

  it('several lines become several items, in the written order', () => {
    const r = structure(ITEM('A') + ITEM('D'), {
      insert: [{ after: 'A', text: 'B\nC' }],
    })
    expect(r.paragraphs).toEqual(['A', 'B', 'C', 'D'])
  })

  it('like picks another paragraph as the template', () => {
    const title = '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Planning</w:t></w:r></w:p>'
    const r = structure(title + ITEM('Item'), {
      insert: [{ after: 'Item', text: 'New heading', like: 'Planning' }],
    })
    expect(r.paragraphs).toEqual(['Planning', 'Item', 'New heading'])
    expect(r.xml.match(/w:val="Heading1"/g)).toHaveLength(2)
  })

  it('an empty cell receives the text with the paragraph mark formatting', () => {
    // The real case: a form line with the column still blank. There is no
    // run to inherit, and without care the new text would be born without formatting.
    const emptyCell = '<w:tc><w:p><w:pPr><w:rPr><w:b/></w:rPr></w:pPr></w:p></w:tc>'
    const table = `<w:tbl><w:tr>${CELL('23/09')}${emptyCell}</w:tr></w:tbl>`
    const r = structure(table, { rows: [{ after: '23/09', cells: ['24/09', 'In bold'] }] })
    expect(r.paragraphs).toContain('In bold')
    expect(r.xml).toMatch(/<w:r><w:rPr><w:b\/><\/w:rPr><w:t>In bold<\/w:t><\/w:r>/)
  })

  it('removes the requested paragraph', () => {
    const r = structure(ITEM('stays') + ITEM('goes') + ITEM('also stays'), {
      remove: [{ containing: 'goes' }],
    })
    expect(r.result.remove).toEqual([1])
    expect(r.paragraphs).toEqual(['stays', 'also stays'])
  })

  it('does not delete the last paragraph of a cell — only empties it', () => {
    // A cell without a paragraph is a file Word calls corrupted.
    const table = `<w:tbl><w:tr>${CELL('only')}</w:tr></w:tbl>`
    const r = structure(table, { remove: [{ containing: 'only' }] })
    expect(r.result.remove).toEqual([1])
    expect(r.xml).toContain('<w:tc>')
    expect(r.xml.match(/<w:p>/g)?.length).toBe(1)
    expect(r.paragraphs).toEqual([''])
  })

  it('a new row in the table inherits the borders and gets values per column', () => {
    const table =
      `<w:tbl><w:tr>${CELL('23/09')}${CELL('Volume')}</w:tr>` +
      `<w:tr>${CELL('24/09')}${CELL('Equations')}</w:tr></w:tbl>`
    const r = structure(table, { rows: [{ after: '23/09', cells: ['25/09', 'Fraction'] }] })
    expect(r.result.rows).toEqual([1])
    expect(r.paragraphs).toEqual(['23/09', 'Volume', '25/09', 'Fraction', '24/09', 'Equations'])
    // Six cells, all with the border: the new row is a clone of a real one.
    expect(r.xml.match(/<w:top w:val="single"\/>/g)).toHaveLength(6)
  })

  it('removes a row, but never the last one in the table', () => {
    const two = `<w:tbl><w:tr>${CELL('a')}</w:tr><w:tr>${CELL('b')}</w:tr></w:tbl>`
    expect(structure(two, { removeRows: [{ containing: 'a' }] }).paragraphs).toEqual(['b'])

    const only = `<w:tbl><w:tr>${CELL('solo')}</w:tr></w:tbl>`
    const r = structure(only, { removeRows: [{ containing: 'solo' }] })
    expect(r.result.removeRows).toEqual([0])
    expect(r.paragraphs).toEqual(['solo'])
  })

  it('a missing anchor is reported as zero, without touching anything', () => {
    const r = structure(ITEM('A'), {
      insert: [{ after: 'inexistente', text: 'X' }],
      rows: [{ after: 'A', cells: ['outside the table'] }],
    })
    expect(r.result.insert).toEqual([0])
    expect(r.result.rows).toEqual([0])
    expect(r.paragraphs).toEqual(['A'])
  })
})
