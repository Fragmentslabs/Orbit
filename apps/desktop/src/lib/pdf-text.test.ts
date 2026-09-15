import { describe, expect, it } from 'vitest'

import { locateText, selectionScaleX, type PdfTextItem } from './pdf-text'

/**
 * O destaque no PDF sai daqui. O risco da camada é a FRAGMENTAÇÃO: o PDF
 * quebra a frase em vários itens e a posição dos espaços entre eles não é
 * confiável, então a frase que se lê na página quase nunca existe como string
 * contígua nos itens. Uma busca ingênua não acha nada — e o painel mostraria a
 * página certa sem marca nenhuma, que é indistinguível de "não está aqui".
 */

/** Itens numa linha, cada um com a sua fatia da largura. */
function linha(pedacos: string[], y = 0.5): PdfTextItem[] {
  let x = 0.1
  return pedacos.map((text) => {
    const width = text.length * 0.01
    const item = { x, y, width, height: 0.02, text }
    x += width
    return item
  })
}

describe('locateText', () => {
  it('acha o trecho contido num item só', () => {
    const rects = locateText(linha(['O prazo e de noventa dias']), 'noventa dias')
    expect(rects).toHaveLength(1)
  })

  it('acha o trecho QUEBRADO entre itens — o caso que a busca ingênua perde', () => {
    const rects = locateText(linha(['O prazo e de nov', 'enta', ' dias']), 'noventa dias')
    expect(rects).toHaveLength(3)
  })

  it('ignora diferença de espaço entre os itens', () => {
    const rects = locateText(linha(['um', '  destino', 'unico']), 'um destino unico')
    expect(rects).toHaveLength(3)
  })

  it('não diferencia maiúscula de minúscula', () => {
    expect(locateText(linha(['Unicast envia']), 'unicast')).toHaveLength(1)
  })

  it('devolve TODAS as ocorrências, não só a primeira', () => {
    const itens = [...linha(['unicast aqui'], 0.2), ...linha(['e unicast ali'], 0.4)]
    const rects = locateText(itens, 'unicast')
    expect(rects).toHaveLength(2)
    // Em linhas diferentes: é o que prova que não marcou duas vezes a mesma.
    expect(new Set(rects.map((r) => r.y)).size).toBe(2)
  })

  it('as ocorrências não se sobrepõem — avança além do casamento', () => {
    const rects = locateText(linha(['aaaa']), 'aa')
    expect(rects).toHaveLength(2)
  })

  it('trecho ausente não marca nada', () => {
    expect(locateText(linha(['texto qualquer']), 'inexistente')).toEqual([])
  })

  it('busca curta demais não marca nada — marcaria a página inteira', () => {
    expect(locateText(linha(['a b c']), 'a')).toEqual([])
    expect(locateText(linha(['a b c']), ' ')).toEqual([])
  })

  it('página sem texto devolve vazio em vez de falhar', () => {
    expect(locateText([], 'qualquer')).toEqual([])
  })

  it('devolve o retângulo do item, em fração da página', () => {
    const [rect] = locateText([{ x: 0.1, y: 0.2, width: 0.3, height: 0.02, text: 'alvo' }], 'alvo')
    expect(rect).toEqual({ x: 0.1, y: 0.2, width: 0.3, height: 0.02 })
  })

  it('respeita o teto de ocorrências', () => {
    const itens = Array.from({ length: 50 }, (_, i) => ({
      x: 0.1,
      y: i * 0.01,
      width: 0.05,
      height: 0.02,
      text: 'alvo',
    }))
    expect(locateText(itens, 'alvo', 10)).toHaveLength(10)
  })
})

describe('selectionScaleX', () => {
  const item = (text: string, width: number): PdfTextItem => ({
    x: 0,
    y: 0,
    width,
    height: 0.02,
    text,
  })

  it('texto mais largo que o estimado estica a camada', () => {
    // 10 caracteres, altura 0.02, página 1:1 → estimativa 0.1 de largura.
    expect(selectionScaleX(item('0123456789', 0.2), 1)).toBeCloseTo(2, 5)
  })

  it('texto mais estreito encolhe', () => {
    expect(selectionScaleX(item('0123456789', 0.05), 1)).toBeCloseTo(0.5, 5)
  })

  it('a proporção da página entra na conta', () => {
    // Largura e altura são frações de eixos diferentes: numa página mais larga
    // que alta, a mesma fração de largura cobre mais pixels.
    const quadrada = selectionScaleX(item('0123456789', 0.1), 1)
    const larga = selectionScaleX(item('0123456789', 0.1), 2)
    expect(larga).toBeCloseTo(quadrada * 2, 5)
  })

  it('fica em faixa sã mesmo com item degenerado', () => {
    expect(selectionScaleX(item('', 0.5), 1)).toBe(1)
    expect(selectionScaleX({ x: 0, y: 0, width: 0.5, height: 0, text: 'x' }, 1)).toBe(1)
    expect(selectionScaleX(item('x', 9), 1)).toBeLessThanOrEqual(3)
    expect(selectionScaleX(item('x'.repeat(500), 0.001), 1)).toBeGreaterThanOrEqual(0.2)
  })
})
