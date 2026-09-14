import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'

import { applyReplacements, type Replacement } from './docx-edit'

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
