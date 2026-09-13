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
 * A camada de documentos existe para que um PDF de 300 páginas NUNCA entre
 * inteiro no contexto. Duas falhas aqui são silenciosas e caras:
 *
 * 1. A janela devolver mais do que o pedido — o custo volta a explodir sem
 *    ninguém perceber, porque a resposta continua "certa".
 * 2. O cabeçalho não anunciar que há mais documento — o modelo responde como
 *    se tivesse lido o todo, que é o erro exato que a paginação evita.
 */

const doc = (pages: DocumentPage[], over: Partial<ExtractedDocument> = {}): ExtractedDocument => ({
  kind: 'pdf',
  pages,
  totalPages: pages.length,
  totalChars: pages.reduce((n, p) => n + p.text.length, 0),
  truncated: false,
  ...over,
})

const page = (num: number, text = `texto ${num}`): DocumentPage => ({ num, text })

describe('documentKindOf', () => {
  it('reconhece os formatos suportados, sem depender de maiúscula', () => {
    expect(documentKindOf('spec.pdf')).toBe('pdf')
    expect(documentKindOf('REQUISITOS.PDF')).toBe('pdf')
    expect(documentKindOf('contrato.docx')).toBe('docx')
    expect(documentKindOf('custos.xlsx')).toBe('spreadsheet')
    expect(documentKindOf('dados.csv')).toBe('spreadsheet')
  })

  it('não captura arquivo de código — o read de texto continua sendo o caminho deles', () => {
    expect(documentKindOf('index.ts')).toBeNull()
    expect(documentKindOf('README.md')).toBeNull()
    expect(isDocumentPath('app/main.rs')).toBe(false)
  })

  it('não confunde extensão no meio do nome', () => {
    expect(isDocumentPath('relatorio.pdf.bak')).toBe(false)
  })
})

describe('paginateText', () => {
  it('quebra em parágrafo, nunca no meio de uma frase', () => {
    const paragrafo = 'a'.repeat(400)
    const pages = paginateText([paragrafo, paragrafo, paragrafo].join('\n\n'), 500)
    expect(pages.length).toBeGreaterThan(1)
    for (const p of pages) expect(p.text).not.toMatch(/^a{1,399}$/)
  })

  it('numera a partir de 1 e em sequência', () => {
    const pages = paginateText(Array.from({ length: 6 }, () => 'x'.repeat(300)).join('\n\n'), 400)
    expect(pages.map((p) => p.num)).toEqual(pages.map((_, i) => i + 1))
  })

  it('texto vazio ainda devolve uma página — o chamador nunca recebe lista vazia', () => {
    expect(paginateText('')).toHaveLength(1)
  })

  it('parágrafo maior que o alvo não é partido (vira uma página grande)', () => {
    const gigante = 'z'.repeat(5000)
    const pages = paginateText(gigante, 1000)
    expect(pages).toHaveLength(1)
    expect(pages[0].text).toHaveLength(5000)
  })
})

describe('capPages', () => {
  it('corta preservando páginas inteiras e sinaliza o corte', () => {
    const result = capPages([page(1, 'aaaa'), page(2, 'bbbb'), page(3, 'cccc')], 'pdf', 9)
    expect(result.pages).toHaveLength(2)
    expect(result.truncated).toBe(true)
    expect(result.pages.at(-1)!.text).toBe('bbbb')
  })

  it('documento dentro do limite não é marcado como cortado', () => {
    const result = capPages([page(1, 'aa'), page(2, 'bb')], 'pdf', 100)
    expect(result.truncated).toBe(false)
    expect(result.totalPages).toBe(2)
  })
})

describe('pageWindow', () => {
  const d = doc(Array.from({ length: 50 }, (_, i) => page(i + 1)))

  it('sem offset começa na primeira página e respeita o padrão', () => {
    const { from, to, pages } = pageWindow(d, undefined, undefined, 3, 20)
    expect(from).toBe(1)
    expect(to).toBe(3)
    expect(pages).toHaveLength(3)
  })

  it('limit acima do teto é cortado — é o que impede o documento inteiro de vir numa chamada', () => {
    expect(pageWindow(d, 1, 999, 3, 20).pages).toHaveLength(20)
  })

  it('offset além do fim cai na última página em vez de devolver vazio', () => {
    const { from, pages } = pageWindow(d, 999, 2, 3, 20)
    expect(from).toBe(50)
    expect(pages).toHaveLength(1)
  })

  it('offset 0 ou negativo é normalizado para a primeira página', () => {
    expect(pageWindow(d, 0, 2, 3, 20).from).toBe(1)
    expect(pageWindow(d, -5, 2, 3, 20).from).toBe(1)
  })
})

describe('documentHeader', () => {
  it('anuncia que há mais documento e como continuar', () => {
    const header = documentHeader('spec.pdf', doc(Array.from({ length: 40 }, (_, i) => page(i + 1))), {
      from: 1,
      to: 3,
    })
    expect(header).toContain('paginas="40"')
    expect(header).toContain('offset=4')
  })

  it('na última página não sugere continuar', () => {
    const header = documentHeader('spec.pdf', doc([page(1), page(2)]), { from: 1, to: 2 })
    expect(header).not.toContain('offset=')
  })

  it('planilha é anunciada em abas, não em páginas', () => {
    const planilha = doc([{ num: 1, text: 'a', label: 'Custos' }], { kind: 'spreadsheet' })
    expect(documentHeader('c.xlsx', planilha, { from: 1, to: 1 })).toContain('abas="1"')
  })

  it('documento cortado avisa o corte', () => {
    const cortado = doc([page(1)], { truncated: true })
    expect(documentHeader('g.pdf', cortado, { from: 1, to: 1 })).toContain('cortado')
  })
})

describe('pageLabel', () => {
  it('usa o nome da aba quando existe', () => {
    expect(pageLabel({ num: 2, text: '', label: 'Custos' }, 'spreadsheet')).toBe('aba "Custos"')
  })

  it('DOCX fala em bloco, porque a paginação ali é sintética', () => {
    expect(pageLabel({ num: 2, text: '' }, 'docx')).toBe('bloco 2')
  })

  it('PDF fala em página, que é a paginação real do arquivo', () => {
    expect(pageLabel({ num: 12, text: '' }, 'pdf')).toBe('p. 12')
  })
})

/**
 * O localizador é o que o agente CITA para o usuário e o que ele usa como
 * offset. Dizer "p12" num DOCX faria o modelo apontar uma página que o Word
 * não tem (a paginação ali é sintética), e numa planilha faria "página 3"
 * significar a terceira aba.
 */
describe('pageLocator', () => {
  it('PDF usa página, que é a paginação real do arquivo', () => {
    expect(pageLocator({ num: 12, text: '' }, 'pdf')).toBe('p12')
  })

  it('DOCX não finge ter página do Word', () => {
    const locator = pageLocator({ num: 12, text: '' }, 'docx')
    expect(locator).toBe('bloco12')
    expect(locator).not.toMatch(/^p\d/)
  })

  it('planilha leva o nome da aba junto do offset', () => {
    expect(pageLocator({ num: 3, text: '', label: 'Custos' }, 'spreadsheet')).toBe('aba3 (Custos)')
  })

  it('sempre carrega o número que serve de offset na leitura', () => {
    for (const kind of ['pdf', 'docx', 'spreadsheet'] as const) {
      expect(pageLocator({ num: 7, text: '' }, kind)).toContain('7')
    }
  })
})
