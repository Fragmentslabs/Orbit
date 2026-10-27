import { describe, expect, it } from 'vitest'
import { DOCX_PAGE_BREAK_MARK, splitDocxPages, splitOnPageBreaks } from '@shared/page-breaks'

describe('splitOnPageBreaks', () => {
  it('corta nas linhas de instrução e não deixa o `\\pagebreak` no texto', () => {
    const paginas = splitOnPageBreaks('# Um\n\ntexto\n\n\\pagebreak\n\n# Dois\n\nmais')
    expect(paginas).toEqual(['# Um\n\ntexto', '# Dois\n\nmais'])
  })

  it('devolve uma página só quando não há quebra', () => {
    expect(splitOnPageBreaks('# Um\n\ntexto')).toEqual(['# Um\n\ntexto'])
  })

  it('não confunde a instrução no meio de uma frase', () => {
    expect(splitOnPageBreaks('use \\pagebreak para quebrar')).toEqual([
      'use \\pagebreak para quebrar',
    ])
  })

  it('aceita espaços em volta da instrução', () => {
    expect(splitOnPageBreaks('a\n   \\pagebreak   \nb')).toEqual(['a', 'b'])
  })
})

describe('splitDocxPages', () => {
  it('corta no parágrafo da marca e o descarta', () => {
    const html = `<p>um</p><p>${DOCX_PAGE_BREAK_MARK}</p><p>dois</p>`
    expect(splitDocxPages(html)).toEqual(['<p>um</p>', '<p>dois</p>'])
  })

  it('uma folha quando o documento não tem marca', () => {
    expect(splitDocxPages('<p>um</p><p>dois</p>')).toEqual(['<p>um</p><p>dois</p>'])
  })

  it('preserva a página em branco entre duas quebras seguidas', () => {
    const html = `<p>um</p><p>${DOCX_PAGE_BREAK_MARK}</p><p>${DOCX_PAGE_BREAK_MARK}</p><p>três</p>`
    expect(splitDocxPages(html)).toEqual(['<p>um</p>', '', '<p>três</p>'])
  })
})
