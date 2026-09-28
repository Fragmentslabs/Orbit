import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'

import { applyReplacements, applyStructural, type Replacement, type StructuralEdits } from './docx-edit'

const _require = createRequire(import.meta.url)
const { DOMParser, XMLSerializer } = _require('@xmldom/xmldom') as typeof import('@xmldom/xmldom')

/**
 * O risco desta camada é a FRAGMENTAÇÃO DE RUNS: o Word quebra uma frase em
 * vários <w:r> por marcas de revisão e corretor, então a frase que se lê no
 * documento quase nunca existe como string contígua no XML. Uma busca ingênua
 * não acha nada — e o agente reportaria "editado" sem ter editado.
 */

/** Monta um parágrafo com um <w:r> por pedaço — imita a fragmentação real. */
function paragraph(...pedacos: string[]): string {
  const runs = pedacos
    .map((t) => `<w:r><w:t xml:space="preserve">${t}</w:t></w:r>`)
    .join('')
  return `<w:document xmlns:w="w"><w:body><w:p>${runs}</w:p></w:body></w:document>`
}

function run(xml: string, replacements: Replacement[]) {
  const doc = new DOMParser().parseFromString(xml, 'text/xml')
  const applied = applyReplacements(doc as never, replacements)
  const out = new XMLSerializer().serializeToString(doc as never)
  // Um <w:t> que ficou vazio é serializado autofechado (<w:t/>); ignorar esse
  // caso faria a regex casar através da tag e "vazar" XML para o texto.
  const texto = [...out.matchAll(/<w:t[^>]*\/>|<w:t[^>]*>([\s\S]*?)<\/w:t>/g)]
    .map((m) => m[1] ?? '')
    .join('')
  return { applied, texto, xml: out }
}

describe('applyReplacements', () => {
  it('troca texto contido num run só', () => {
    const r = run(paragraph('O prazo e de noventa dias.'), [
      { find: 'noventa dias', replace: 'cento e vinte dias' },
    ])
    expect(r.applied).toEqual([1])
    expect(r.texto).toBe('O prazo e de cento e vinte dias.')
  })

  it('troca texto QUEBRADO entre runs — o caso que a busca ingênua perde', () => {
    const r = run(paragraph('O prazo e de nov', 'enta', ' dias.'), [
      { find: 'noventa dias', replace: 'cento e vinte dias' },
    ])
    expect(r.applied).toEqual([1])
    expect(r.texto).toBe('O prazo e de cento e vinte dias.')
  })

  it('o texto novo entra no PRIMEIRO run, herdando a formatação dali', () => {
    const xml = `<w:document xmlns:w="w"><w:body><w:p>` +
      `<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">nov</w:t></w:r>` +
      `<w:r><w:t xml:space="preserve">enta dias</w:t></w:r>` +
      `</w:p></w:body></w:document>`
    const r = run(xml, [{ find: 'noventa dias', replace: 'cento e vinte dias' }])
    // O run em negrito é o que passa a carregar o texto inteiro.
    expect(r.xml).toMatch(/<w:b\/><\/w:rPr><w:t[^>]*>cento e vinte dias<\/w:t>/)
    expect(r.texto).toBe('cento e vinte dias')
  })

  it('sem `all`, troca só a primeira ocorrência', () => {
    const r = run(paragraph('ACME e ACME'), [{ find: 'ACME', replace: 'BETA' }])
    expect(r.applied).toEqual([1])
    expect(r.texto).toBe('BETA e ACME')
  })

  it('com `all`, troca todas', () => {
    const r = run(paragraph('ACME e ACME e ACME'), [{ find: 'ACME', replace: 'BETA', all: true }])
    expect(r.applied).toEqual([3])
    expect(r.texto).toBe('BETA e BETA e BETA')
  })

  it('substituição que contém o procurado não entra em laço infinito', () => {
    // "X" -> "XY" com all: encontrar de novo o próprio resultado repetiria
    // para sempre. O teste falha por timeout se a proteção sumir.
    const r = run(paragraph('valor X aqui'), [{ find: 'X', replace: 'XY', all: true }])
    expect(r.texto).toBe('valor XY aqui')
  })

  it('substituir por vazio apaga o trecho', () => {
    const r = run(paragraph('texto [RASCUNHO] final'), [{ find: ' [RASCUNHO]', replace: '' }])
    expect(r.texto).toBe('texto final')
  })

  it('trecho ausente devolve zero em vez de falhar', () => {
    const r = run(paragraph('nada aqui'), [{ find: 'inexistente', replace: 'x' }])
    expect(r.applied).toEqual([0])
    expect(r.texto).toBe('nada aqui')
  })

  it('conta cada substituição separadamente, na ordem recebida', () => {
    const r = run(paragraph('A e B'), [
      { find: 'A', replace: '1' },
      { find: 'ausente', replace: 'x' },
      { find: 'B', replace: '2' },
    ])
    expect(r.applied).toEqual([1, 0, 1])
    expect(r.texto).toBe('1 e 2')
  })

  it('preserva xml:space quando o texto novo tem espaço nas pontas', () => {
    const r = run(paragraph('a', 'b'), [{ find: 'ab', replace: ' c ' }])
    expect(r.xml).toContain('xml:space="preserve"')
    expect(r.texto).toBe(' c ')
  })

  it('busca vazia não faz nada — evitaria inserir em todo lugar', () => {
    const r = run(paragraph('texto'), [{ find: '', replace: 'x', all: true }])
    expect(r.applied).toEqual([0])
    expect(r.texto).toBe('texto')
  })
})

/**
 * Estrutura: o que a troca de texto não alcança. O que está em jogo é o
 * mesmo — a formatação do documento do usuário —, e a garantia vem de clonar
 * XML que já existe em vez de escrever XML novo.
 */
function estrutura(body: string, edits: StructuralEdits) {
  const xml = `<w:document xmlns:w="w"><w:body>${body}</w:body></w:document>`
  const doc = new DOMParser().parseFromString(xml, 'text/xml')
  const result = applyStructural(doc as never, edits)
  const out = new XMLSerializer().serializeToString(doc as never)
  const paragrafos = [...out.matchAll(/<w:p[ >][\s\S]*?<\/w:p>|<w:p\/>/g)].map((m) =>
    [...m[0].matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)].map((t) => t[1]).join(''),
  )
  return { result, xml: out, paragrafos }
}

const ITEM = (texto: string) =>
  `<w:p><w:pPr><w:pStyle w:val="ListaNumerada"/><w:numPr><w:numId w:val="3"/></w:numPr></w:pPr>` +
  `<w:r><w:rPr><w:rFonts w:ascii="Calibri"/></w:rPr><w:t>${texto}</w:t></w:r></w:p>`

const CELULA = (texto: string) =>
  `<w:tc><w:tcPr><w:tcBorders><w:top w:val="single"/></w:tcBorders></w:tcPr>` +
  `<w:p><w:r><w:t>${texto}</w:t></w:r></w:p></w:tc>`

describe('applyStructural', () => {
  it('o item novo herda estilo, numeração e fonte do item âncora', () => {
    const r = estrutura(ITEM('Volume e capacidade') + ITEM('Equações'), {
      insert: [{ after: 'Volume e capacidade', text: 'Fração geratriz' }],
    })
    expect(r.result.insert).toEqual([1])
    expect(r.paragrafos).toEqual(['Volume e capacidade', 'Fração geratriz', 'Equações'])
    // Três parágrafos na lista numerada, com a mesma fonte: o novo é clone.
    expect(r.xml.match(/w:numId w:val="3"/g)).toHaveLength(3)
    expect(r.xml.match(/w:ascii="Calibri"/g)).toHaveLength(3)
  })

  it('várias linhas viram vários itens, na ordem escrita', () => {
    const r = estrutura(ITEM('A') + ITEM('D'), {
      insert: [{ after: 'A', text: 'B\nC' }],
    })
    expect(r.paragrafos).toEqual(['A', 'B', 'C', 'D'])
  })

  it('like escolhe outro parágrafo como molde', () => {
    const titulo = '<w:p><w:pPr><w:pStyle w:val="Titulo1"/></w:pPr><w:r><w:t>Planejamento</w:t></w:r></w:p>'
    const r = estrutura(titulo + ITEM('Item'), {
      insert: [{ after: 'Item', text: 'Novo título', like: 'Planejamento' }],
    })
    expect(r.paragrafos).toEqual(['Planejamento', 'Item', 'Novo título'])
    expect(r.xml.match(/w:val="Titulo1"/g)).toHaveLength(2)
  })

  it('célula vazia recebe o texto com a formatação da marca de parágrafo', () => {
    // O caso real: a linha de um formulário com a coluna ainda em branco. Não
    // há run para herdar, e sem cuidado o texto novo nasceria sem formatação.
    const vazia = '<w:tc><w:p><w:pPr><w:rPr><w:b/></w:rPr></w:pPr></w:p></w:tc>'
    const tabela = `<w:tbl><w:tr>${CELULA('23/09')}${vazia}</w:tr></w:tbl>`
    const r = estrutura(tabela, { rows: [{ after: '23/09', cells: ['24/09', 'Em negrito'] }] })
    expect(r.paragrafos).toContain('Em negrito')
    expect(r.xml).toMatch(/<w:r><w:rPr><w:b\/><\/w:rPr><w:t>Em negrito<\/w:t><\/w:r>/)
  })

  it('remove o parágrafo pedido', () => {
    const r = estrutura(ITEM('fica') + ITEM('sai') + ITEM('fica também'), {
      remove: [{ containing: 'sai' }],
    })
    expect(r.result.remove).toEqual([1])
    expect(r.paragrafos).toEqual(['fica', 'fica também'])
  })

  it('não apaga o último parágrafo de uma célula — só esvazia', () => {
    // Célula sem parágrafo é arquivo que o Word chama de corrompido.
    const tabela = `<w:tbl><w:tr>${CELULA('única')}</w:tr></w:tbl>`
    const r = estrutura(tabela, { remove: [{ containing: 'única' }] })
    expect(r.result.remove).toEqual([1])
    expect(r.xml).toContain('<w:tc>')
    expect(r.xml.match(/<w:p>/g)?.length).toBe(1)
    expect(r.paragrafos).toEqual([''])
  })

  it('linha nova na tabela herda as bordas e recebe os valores por coluna', () => {
    const tabela =
      `<w:tbl><w:tr>${CELULA('23/09')}${CELULA('Volume')}</w:tr>` +
      `<w:tr>${CELULA('24/09')}${CELULA('Equações')}</w:tr></w:tbl>`
    const r = estrutura(tabela, { rows: [{ after: '23/09', cells: ['25/09', 'Fração'] }] })
    expect(r.result.rows).toEqual([1])
    expect(r.paragrafos).toEqual(['23/09', 'Volume', '25/09', 'Fração', '24/09', 'Equações'])
    // Seis células, todas com a borda: a nova linha é clone de uma de verdade.
    expect(r.xml.match(/<w:top w:val="single"\/>/g)).toHaveLength(6)
  })

  it('remove uma linha, mas nunca a última da tabela', () => {
    const duas = `<w:tbl><w:tr>${CELULA('a')}</w:tr><w:tr>${CELULA('b')}</w:tr></w:tbl>`
    expect(estrutura(duas, { removeRows: [{ containing: 'a' }] }).paragrafos).toEqual(['b'])

    const uma = `<w:tbl><w:tr>${CELULA('só')}</w:tr></w:tbl>`
    const r = estrutura(uma, { removeRows: [{ containing: 'só' }] })
    expect(r.result.removeRows).toEqual([0])
    expect(r.paragrafos).toEqual(['só'])
  })

  it('âncora que não existe é reportada como zero, sem mexer em nada', () => {
    const r = estrutura(ITEM('A'), {
      insert: [{ after: 'inexistente', text: 'X' }],
      rows: [{ after: 'A', cells: ['fora de tabela'] }],
    })
    expect(r.result.insert).toEqual([0])
    expect(r.result.rows).toEqual([0])
    expect(r.paragrafos).toEqual(['A'])
  })
})
