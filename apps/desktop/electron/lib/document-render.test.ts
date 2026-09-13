import { describe, expect, it } from 'vitest'

import {
  parseInline,
  parseMarkdown,
  renderHtml,
  renderOoxmlBody,
  type Block,
} from './document-render'

/**
 * O fonte do documento é um só e alimenta três saídas (HTML, PDF, DOCX). Duas
 * falhas aqui são silenciosas:
 *
 * 1. Sintaxe não reconhecida sumir em vez de virar parágrafo — o documento
 *    entregue ao usuário perde texto sem avisar ninguém.
 * 2. XML mal escapado — o .docx simplesmente não abre, e o erro só aparece no
 *    Word, longe daqui.
 */

describe('parseMarkdown', () => {
  it('reconhece títulos de três níveis', () => {
    const blocks = parseMarkdown('# Um\n## Dois\n### Três')
    expect(blocks.map((b) => b.type === 'heading' && b.level)).toEqual([1, 2, 3])
  })

  it('junta linhas seguidas num parágrafo só e separa em linha vazia', () => {
    const blocks = parseMarkdown('linha um\nlinha dois\n\noutro parágrafo')
    expect(blocks).toHaveLength(2)
    expect(blocks[0]).toEqual({ type: 'paragraph', text: 'linha um linha dois' })
  })

  it('distingue lista com marcador de lista numerada', () => {
    const blocks = parseMarkdown('- a\n- b\n\n1. x\n2. y')
    const items = blocks.filter((b): b is Extract<Block, { type: 'listItem' }> => b.type === 'listItem')
    expect(items).toHaveLength(4)
    expect(items.slice(0, 2).every((i) => !i.ordered)).toBe(true)
    expect(items.slice(2).every((i) => i.ordered)).toBe(true)
  })

  it('lê tabela com cabeçalho e linhas', () => {
    const blocks = parseMarkdown('| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |')
    const table = blocks[0]
    expect(table.type).toBe('table')
    if (table.type !== 'table') return
    expect(table.header).toEqual(['a', 'b'])
    expect(table.rows).toEqual([['1', '2'], ['3', '4']])
  })

  it('texto com barras verticais SEM divisória não vira tabela', () => {
    // Tratar isso como tabela destruiria a frase do usuário.
    const blocks = parseMarkdown('| isto não é | tabela |')
    expect(blocks[0].type).toBe('paragraph')
  })

  it('quebra de página é um bloco próprio', () => {
    const blocks = parseMarkdown('a\n\n\\pagebreak\n\nb')
    expect(blocks.map((b) => b.type)).toEqual(['paragraph', 'pageBreak', 'paragraph'])
  })

  it('citação e linha horizontal', () => {
    const blocks = parseMarkdown('> citado\n\n---')
    expect(blocks.map((b) => b.type)).toEqual(['quote', 'rule'])
  })

  it('sintaxe desconhecida vira parágrafo em vez de sumir', () => {
    const blocks = parseMarkdown('~~riscado~~ e ![img](x.png)')
    expect(blocks).toHaveLength(1)
    expect(blocks[0].type).toBe('paragraph')
    expect((blocks[0] as Extract<Block, { type: 'paragraph' }>).text).toContain('riscado')
  })

  it('documento vazio não quebra', () => {
    expect(parseMarkdown('')).toEqual([])
    expect(parseMarkdown('\n\n   \n')).toEqual([])
  })
})

describe('parseInline', () => {
  it('separa negrito, itálico e código', () => {
    const runs = parseInline('normal **forte** e *leve* e `cod`')
    expect(runs.find((r) => r.bold)?.text).toBe('forte')
    expect(runs.find((r) => r.italic)?.text).toBe('leve')
    expect(runs.find((r) => r.code)?.text).toBe('cod')
  })

  it('texto sem marcação vira um run só', () => {
    expect(parseInline('simples')).toEqual([{ text: 'simples' }])
  })

  it('nunca devolve lista vazia', () => {
    expect(parseInline('')).toHaveLength(1)
  })
})

describe('renderHtml', () => {
  it('agrupa itens consecutivos numa lista só', () => {
    const html = renderHtml(parseMarkdown('- a\n- b\n- c'), 'T')
    expect(html.match(/<ul>/g)).toHaveLength(1)
    expect(html.match(/<li>/g)).toHaveLength(3)
  })

  it('troca de tipo de lista abre lista nova', () => {
    const html = renderHtml(parseMarkdown('- a\n\n1. b'), 'T')
    expect(html).toContain('<ul>')
    expect(html).toContain('<ol>')
  })

  it('escapa HTML do conteúdo — o texto do usuário não vira markup', () => {
    const html = renderHtml(parseMarkdown('<script>alert(1)</script>'), 'T')
    expect(html).not.toContain('<script>alert')
    expect(html).toContain('&lt;script&gt;')
  })

  it('escapa o título também', () => {
    expect(renderHtml([], '<b>x</b>')).toContain('&lt;b&gt;')
  })

  it('leva CSS de impressão, porque este HTML também vira o PDF', () => {
    const html = renderHtml([], 'T')
    expect(html).toContain('@page')
    expect(html).toContain('A4')
  })
})

describe('renderOoxmlBody', () => {
  it('título vira estilo Heading do Word', () => {
    expect(renderOoxmlBody(parseMarkdown('## Resumo'))).toContain('w:val="Heading2"')
  })

  it('lista com marcador e numerada usam numIds diferentes', () => {
    const xml = renderOoxmlBody(parseMarkdown('- a\n\n1. b'))
    expect(xml).toContain('w:numId w:val="1"')
    expect(xml).toContain('w:numId w:val="2"')
  })

  it('tabela sai com bordas — sem isso o Word desenha sem linha nenhuma', () => {
    const xml = renderOoxmlBody(parseMarkdown('| a |\n|---|\n| 1 |'))
    expect(xml).toContain('<w:tbl>')
    expect(xml).toContain('w:tblBorders')
  })

  it('escapa XML — é o que separa um .docx que abre de um que não abre', () => {
    const xml = renderOoxmlBody(parseMarkdown('a < b & c > d e "aspas"'))
    expect(xml).toContain('&lt;')
    expect(xml).toContain('&amp;')

    // Dentro de <w:t> não pode sobrar "<" cru, nem "&" que não inicie uma
    // entidade — os dois casos fazem o Word recusar o arquivo.
    const conteudos = [...xml.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)].map((m) => m[1])
    expect(conteudos.length).toBeGreaterThan(0)
    for (const texto of conteudos) {
      expect(texto).not.toContain('<')
      expect(texto.replace(/&(?:amp|lt|gt|quot|apos|#\d+);/g, '')).not.toContain('&')
    }
  })

  it('negrito vira w:b', () => {
    expect(renderOoxmlBody(parseMarkdown('**forte**'))).toContain('<w:b/>')
  })

  it('quebra de página aplica no bloco SEGUINTE, não no anterior', () => {
    const xml = renderOoxmlBody(parseMarkdown('antes\n\n\\pagebreak\n\ndepois'))
    const breakAt = xml.indexOf('pageBreakBefore')
    const antes = xml.indexOf('antes')
    const depois = xml.indexOf('depois')
    expect(breakAt).toBeGreaterThan(antes)
    expect(breakAt).toBeLessThan(depois)
  })

  it('quebra antes de tabela não se perde (w:tbl não aceita pageBreakBefore)', () => {
    const xml = renderOoxmlBody(parseMarkdown('a\n\n\\pagebreak\n\n| h |\n|---|\n| 1 |'))
    expect(xml).toContain('pageBreakBefore')
    expect(xml).toContain('<w:tbl>')
  })
})

describe('renderHtml — quebra de página', () => {
  it('aplica a quebra no bloco SEGUINTE, não como elemento vazio', () => {
    // Um <div class="page-break"></div> vazio é colapsado pelo Chromium e o
    // PDF sai com uma página só — foi exatamente o bug encontrado no spike.
    const html = renderHtml(parseMarkdown('antes\n\n\\pagebreak\n\n## Depois'), 'T')
    expect(html).not.toContain('<div class="page-break"></div>')
    expect(html).toContain('<h2 class="page-break">')
  })

  it('quebra antes de lista marca a lista', () => {
    const html = renderHtml(parseMarkdown('a\n\n\\pagebreak\n\n- item'), 'T')
    expect(html).toContain('<ul class="page-break">')
  })

  it('quebra antes de tabela marca a tabela', () => {
    const html = renderHtml(parseMarkdown('a\n\n\\pagebreak\n\n| h |\n|---|\n| 1 |'), 'T')
    expect(html).toContain('<table class="page-break">')
  })

  it('sem quebra nenhum bloco recebe a classe', () => {
    expect(renderHtml(parseMarkdown('a\n\n## b'), 'T')).not.toContain('page-break"')
  })
})

/**
 * Linha de preencher e quebra de linha: os dois casos que apareceram numa
 * prova gerada de verdade e saíram errados na tela do usuário.
 */
describe('parseInline — formulário', () => {
  it('linha de preencher sobrevive inteira', () => {
    const runs = parseInline('Nome: ______________________')
    expect(runs.map((r) => r.text).join('')).toBe('Nome: ______________________')
    expect(runs.some((r) => r.bold || r.italic)).toBe(false)
  })

  it('negrito depois de underscores continua sendo reconhecido', () => {
    // "__ **Data:** __" casava como itálico de underscore e ENGOLIA o
    // **Data:**, que saía cru no documento.
    const runs = parseInline('**Nome:** ____________ **Data:** __/__/__')
    const bolds = runs.filter((r) => r.bold).map((r) => r.text)
    expect(bolds).toEqual(['Nome:', 'Data:'])
    expect(runs.map((r) => r.text).join('')).toContain('__/__/__')
  })

  it('underscore no meio de palavra não vira ênfase', () => {
    const runs = parseInline('a variável user_name_id continua inteira')
    expect(runs).toHaveLength(1)
    expect(runs[0].italic).toBeUndefined()
  })

  it('asterisco continua funcionando para negrito e itálico', () => {
    const runs = parseInline('**forte** e *leve*')
    expect(runs.find((r) => r.bold)?.text).toBe('forte')
    expect(runs.find((r) => r.italic)?.text).toBe('leve')
  })
})

describe('parseInline — <br>', () => {
  it('vira quebra de linha em vez de texto escapado', () => {
    const runs = parseInline('a<br>b')
    expect(runs.map((r) => (r.br ? "|" : r.text)).join('')).toBe('a|b')
  })

  it('aceita as variações que o modelo escreve', () => {
    for (const tag of ['<br>', '<br/>', '<br />', '<BR>']) {
      expect(parseInline(`x${tag}y`).filter((r) => r.br)).toHaveLength(1)
    }
  })

  it('no HTML sai como <br>, não escapado', () => {
    const html = renderHtml(parseMarkdown('a) 245 + 138 = ______<br><br>b) 356'), 'T')
    expect(html).toContain('<br>')
    expect(html).not.toContain('&lt;br&gt;')
  })

  it('no DOCX sai como w:br dentro do parágrafo', () => {
    expect(renderOoxmlBody(parseMarkdown('a<br>b'))).toContain('<w:br/>')
  })

  it('outro HTML continua escapado — só <br> é interpretado', () => {
    const html = renderHtml(parseMarkdown('<script>x</script> e <b>y</b>'), 'T')
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('&lt;b&gt;')
  })
})
