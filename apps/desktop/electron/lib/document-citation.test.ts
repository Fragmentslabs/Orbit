import { describe, expect, it } from 'vitest'

import { numberLines, sourceAnchor } from './document-pages'

/**
 * A citação só vale se o número que o modelo lê for o mesmo que o painel
 * destaca. Estes testes fecham o par: a numeração que vai para o modelo e o
 * endereço que volta no clique.
 */

describe('numberLines', () => {
  it('numera a partir de 1, com o texto separado por barra', () => {
    expect(numberLines('alfa\nbeta')).toBe('  1| alfa\n  2| beta')
  })

  it('preserva linha vazia — pular a mudaria a contagem de todas as seguintes', () => {
    expect(numberLines('a\n\nb')).toBe('  1| a\n  2| \n  3| b')
  })

  it('não mexe no conteúdo da linha', () => {
    const linha = '  espaços | pipes | e | acentuação ç'
    expect(numberLines(linha)).toBe(`  1| ${linha}`)
  })

  it('alinha à direita para o texto começar na mesma coluna', () => {
    const saida = numberLines(Array.from({ length: 12 }, (_, i) => `l${i}`).join('\n')).split('\n')
    expect(saida[0].indexOf('|')).toBe(saida[11].indexOf('|'))
  })
})

describe('sourceAnchor', () => {
  it('endereço de página, sem linha', () => {
    expect(sourceAnchor('src3', 12)).toBe('#orbit-source/src3/p12')
  })

  it('linha única', () => {
    expect(sourceAnchor('doc1', 4, 28)).toBe('#orbit-source/doc1/p4L28')
  })

  it('intervalo de linhas', () => {
    expect(sourceAnchor('doc1', 4, 28, 31)).toBe('#orbit-source/doc1/p4L28-31')
  })

  it('intervalo de uma linha só não vira faixa', () => {
    expect(sourceAnchor('doc1', 4, 28, 28)).toBe('#orbit-source/doc1/p4L28')
  })
})

/**
 * Cópia da regex do renderer (shared.tsx). Vive aqui porque o componente
 * importa React e o vitest roda em node — o que importa é o CONTRATO entre os
 * dois lados, e ele quebraria em silêncio: um endereço que não casa vira link
 * comum, que não abre nada e não avisa.
 */
const SOURCE_HREF = /^#orbit-source\/([a-z]+\d+)\/p(\d+)(?:L(\d+)(?:-(\d+))?)?$/i

describe('contrato do endereço com o renderer', () => {
  it('tudo que sourceAnchor gera é reconhecido do outro lado', () => {
    for (const anchor of [
      sourceAnchor('src3', 12),
      sourceAnchor('doc1', 4, 28),
      sourceAnchor('doc12', 400, 1, 999),
    ]) {
      expect(SOURCE_HREF.test(anchor)).toBe(true)
    }
  })

  it('extrai id, página e linhas', () => {
    const m = SOURCE_HREF.exec(sourceAnchor('src7', 12, 28, 31))
    expect(m?.slice(1)).toEqual(['src7', '12', '28', '31'])
  })

  it('não casa com http nem com id inventado', () => {
    expect(SOURCE_HREF.test('https://exemplo.com/p1')).toBe(false)
    expect(SOURCE_HREF.test('#orbit-source/../../etc/p1')).toBe(false)
    expect(SOURCE_HREF.test('#orbit-source/src1/p')).toBe(false)
  })
})
