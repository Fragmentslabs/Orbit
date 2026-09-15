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
