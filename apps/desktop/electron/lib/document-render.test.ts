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

/**
 * O estilo vem do MODELO. Duas falhas aqui são graves e silenciosas: um valor
 * malicioso ou torto vira CSS/XML inválido — no melhor caso o documento fica
 * estranho, no pior o .docx não abre.
 */
describe('normalizeStyle', () => {
  it('sem estilo, devolve o padrão', () => {
    const s = normalizeStyle()
    expect(s.fontFamily).toBe('Georgia')
    expect(s.fontSize).toBe(11)
    expect(s.columns).toBe(1)
  })

  it('aceita os valores válidos', () => {
    const s = normalizeStyle({ fontFamily: 'Calibri', fontSize: 13, accentColor: '#1f4e79', marginCm: 1.5, columns: 2, align: 'left' })
    expect(s).toEqual({
      fontFamily: 'Calibri', fontSize: 13, accentColor: '1F4E79',
      marginCm: 1.5, columns: 2, align: 'left',
    })
  })

  it('limpa a fonte — um nome com pontuação injetaria CSS/XML', () => {
    const s = normalizeStyle({ fontFamily: 'Arial"; } body { display:none } /*' })
    expect(s.fontFamily).not.toMatch(/["';{}/*]/)
    expect(s.fontFamily.startsWith('Arial')).toBe(true)
  })

  it('cor inválida cai no padrão em vez de virar XML quebrado', () => {
    for (const bad of ['red', '#12', 'rgb(1,2,3)', '"><script>', '']) {
      expect(normalizeStyle({ accentColor: bad }).accentColor).toBe('111111')
    }
  })

  it('aceita hex com e sem #, normalizando para maiúsculas', () => {
    expect(normalizeStyle({ accentColor: '#abcdef' }).accentColor).toBe('ABCDEF')
    expect(normalizeStyle({ accentColor: 'abcdef' }).accentColor).toBe('ABCDEF')
  })

  it('números fora da faixa são limitados, não rejeitados', () => {
    expect(normalizeStyle({ fontSize: 200 }).fontSize).toBe(18)
    expect(normalizeStyle({ fontSize: 1 }).fontSize).toBe(7)
    expect(normalizeStyle({ columns: 99 }).columns).toBe(3)
    expect(normalizeStyle({ marginCm: -5 }).marginCm).toBe(0.5)
  })

  it('valor não numérico não vira NaN no CSS', () => {
    const s = normalizeStyle({ fontSize: Number.NaN, marginCm: undefined })
    expect(s.fontSize).toBe(11)
    expect(s.marginCm).toBe(2.5)
  })

  it('títulos escalam com o corpo', () => {
    const grande = normalizeStyle({ fontSize: 14 })
    expect(headingSize(grande, 1)).toBeGreaterThan(headingSize(normalizeStyle(), 1))
    expect(headingSize(grande, 1)).toBeGreaterThan(headingSize(grande, 2))
  })
})

describe('estilo aplicado às saídas', () => {
  const style = { fontFamily: 'Calibri', fontSize: 13, accentColor: '#1F4E79', columns: 2, marginCm: 1.5 }

  it('HTML leva fonte, tamanho, cor e colunas', () => {
    const html = renderHtml(parseMarkdown('# Título'), 'T', style)
    expect(html).toContain("'Calibri'")
    expect(html).toContain('13pt')
    expect(html).toContain('#1F4E79')
    expect(html).toContain('column-count: 2')
  })

  it('DOCX leva a cor no título', () => {
    // O OOXML usa hex sem "#"; com ele o Word ignora a cor em silêncio.
    const xml = renderOoxmlBody(parseMarkdown('| a |\n|---|\n| 1 |'), style)
    expect(xml).toContain('w:fill="1F4E79"')
    expect(xml).not.toContain('#1F4E79')
  })

  it('uma coluna não emite regra de colunas', () => {
    expect(renderHtml(parseMarkdown('x'), 'T', { columns: 1 })).not.toContain('column-count')
  })
})

describe('alinhamento de tabela', () => {
  const md = '| esq | centro | dir |\n|:---|:---:|---:|\n| a | b | c |'

  it('a divisória define o alinhamento de cada coluna', () => {
    const table = parseMarkdown(md)[0]
    expect(table.type).toBe('table')
    if (table.type !== 'table') return
    expect(table.align).toEqual(['left', 'center', 'right'])
  })

  it('no HTML vira classe por célula', () => {
    const html = renderHtml(parseMarkdown(md), 'T')
    expect(html).toContain('<th class="c">')
    expect(html).toContain('<td class="r">')
  })

  it('no DOCX vira w:jc no parágrafo da célula — alinhar a célula não moveria o texto', () => {
    const xml = renderOoxmlBody(parseMarkdown(md))
    expect(xml).toContain('<w:jc w:val="center"/>')
    expect(xml).toContain('<w:jc w:val="right"/>')
  })

  it('tabela sem marcação de alinhamento fica toda à esquerda', () => {
    const table = parseMarkdown('| a | b |\n|---|---|\n| 1 | 2 |')[0]
    if (table.type !== 'table') return
    expect(table.align).toEqual(['left', 'left'])
  })
})


/**
 * Bloco de código cercado. Antes disto, ``` caía no ramo de parágrafo e as
 * linhas eram juntadas por espaço — o código chegava ao documento numa linha
 * só, com os marcadores à mostra. Como documentação técnica é o uso mais
 * comum do documento, é o caso que mais aparecia quebrado.
 */
describe('miniatura nativa', () => {
  const blocks = parseMarkdown('# Guia\n\nTexto.\n\n```ts\nconst a = 1\n```')

  it('traz as duas paletas na mesma página', () => {
    const html = renderThumbHtml(blocks, 'Guia')

    // A captura troca de tema ligando a classe, sem recarregar nada.
    expect(html).toContain(':root.dark')
    expect(html).toMatch(/--bg:/)
  })

  it('não é a folha impressa: nada de A4 nem margem de página', () => {
    const html = renderThumbHtml(blocks, 'Guia')

    expect(html).not.toContain('@page')
    expect(html).not.toContain('cm')
  })

  it('desenha os mesmos blocos do documento', () => {
    const html = renderThumbHtml(blocks, 'Guia')

    expect(html).toContain('<h1>Guia</h1>')
    expect(html).toContain('<pre><code>const a = 1</code></pre>')
  })
})

describe('bloco de código', () => {
  it('guarda as linhas cruas, sem juntar nem aparar', () => {
    const blocks = parseMarkdown('Antes:\n\n```ts\nclass A {\n  x = 1\n}\n```\n\nDepois.')

    expect(blocks).toEqual([
      { type: 'paragraph', text: 'Antes:' },
      { type: 'code', lines: ['class A {', '  x = 1', '}'], lang: 'ts' },
      { type: 'paragraph', text: 'Depois.' },
    ])
  })

  it('não interpreta Markdown lá dentro', () => {
    const blocks = parseMarkdown('```sh\n# instala tudo\n- npm i\n| a | b |\n```')

    expect(blocks).toEqual([
      { type: 'code', lines: ['# instala tudo', '- npm i', '| a | b |'], lang: 'sh' },
    ])
  })

  it('cerca sem fechar leva o resto do texto, em vez de perdê-lo', () => {
    const blocks = parseMarkdown('```\nsobrou aberto\nmais uma linha')

    expect(blocks).toEqual([{ type: 'code', lines: ['sobrou aberto', 'mais uma linha'] }])
  })

  it('o HTML sai em <pre>, com as quebras e os símbolos preservados', () => {
    const html = renderHtml(parseMarkdown('```ts\nif (a < b) {\n  go()\n}\n```'), 'T')

    expect(html).toContain('<pre><code>if (a &lt; b) {\n  go()\n}</code></pre>')
    // Sem pre-wrap a linha longa sai cortada na margem do PDF.
    expect(html).toContain('white-space: pre-wrap')
  })

  it('o DOCX sai com uma linha por parágrafo, em Courier e sem justificar', () => {
    const xml = renderOoxmlBody(parseMarkdown('```\nlinha um\nlinha dois\n```'))

    expect(xml.match(/w:pStyle w:val="CodeBlock"/g)).toHaveLength(2)
    expect(xml).toContain('<w:t xml:space="preserve">linha um</w:t>')
    expect(xml).toContain('<w:t xml:space="preserve">linha dois</w:t>')
  })
})

describe('fontFamily vinda como pilha de CSS', () => {
  it('fica com a primeira família, e não com os nomes grudados', () => {
    // O que o modelo manda de verdade quando o esquema pede um nome.
    expect(normalizeStyle({ fontFamily: 'Inter, Segoe UI, sans-serif' }).fontFamily).toBe('Inter')
  })

  it('aspas da pilha não entram no nome', () => {
    expect(normalizeStyle({ fontFamily: '"Times New Roman", serif' }).fontFamily).toBe(
      'Times New Roman',
    )
  })
})

describe('barra invertida do Markdown', () => {
  it('o campo de data escapado sai com os underscores, e sem a barra', () => {
    // Veio de um caso real: o modelo escapa os underscores para o campo não
    // virar negrito na TELA (onde `__` é ênfase), e o mesmo texto vira o PDF.
    // Sem tratar o escape, o documento saía com "\_\_\_\_/\_\_\_\_" à mostra.
    expect(parseInline('Data: \\_\\_\\_\\_/\\_\\_\\_\\_/\\_\\_\\_\\_\\_\\_')).toEqual([
      { text: 'Data: ____/____/______' },
    ])
  })

  it('asterisco escapado é asterisco, não começo de itálico', () => {
    expect(parseInline('3 \\* 4 = 12')).toEqual([{ text: '3 * 4 = 12' }])
  })

  it('o escape não atrapalha a ênfase de verdade na mesma linha', () => {
    const runs = parseInline('**Data:** \\_\\_\\_\\_/\\_\\_\\_\\_')
    expect(runs).toEqual([{ text: 'Data:', bold: true }, { text: ' ____/____' }])
  })

  it('barra invertida sozinha continua sendo barra invertida', () => {
    // Só a pontuação do Markdown é neutralizada; "C:\temp" não vira "C:temp".
    expect(parseInline('caminho C:\\temp')).toEqual([{ text: 'caminho C:\\temp' }])
  })
})
