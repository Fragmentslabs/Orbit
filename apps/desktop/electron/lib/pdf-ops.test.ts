import { describe, expect, it } from 'vitest'

import { parsePageRange } from './pdf-ops'

/**
 * A faixa de páginas é onde o modelo mais erra e onde o erro é silencioso:
 * uma faixa mal lida produz um PDF com as páginas erradas, que parece
 * perfeitamente válido.
 */
describe('parsePageRange', () => {
  it('lê páginas soltas e intervalos', () => {
    expect(parsePageRange('1,3,5', 10)).toEqual([1, 3, 5])
    expect(parsePageRange('2-5', 10)).toEqual([2, 3, 4, 5])
    expect(parsePageRange('1-3,7', 10)).toEqual([1, 2, 3, 7])
  })

  it('preserva a ORDEM pedida — é o que permite reordenar, não só filtrar', () => {
    expect(parsePageRange('5,1,3', 10)).toEqual([5, 1, 3])
  })

  it('intervalo invertido conta de trás para frente', () => {
    // "9-7" é intenção de ordem inversa; devolver vazio seria obedecer a
    // sintaxe e ignorar o pedido.
    expect(parsePageRange('9-7', 10)).toEqual([9, 8, 7])
  })

  it('descarta páginas fora do documento em vez de falhar', () => {
    expect(parsePageRange('1,99,3', 5)).toEqual([1, 3])
    expect(parsePageRange('0,1', 5)).toEqual([1])
  })

  it('tolera espaço e entradas vazias', () => {
    expect(parsePageRange(' 1 - 2 , , 4 ', 10)).toEqual([1, 2, 4])
  })

  it('faixa sem nada válido devolve lista vazia — quem chama avisa o usuário', () => {
    expect(parsePageRange('abc', 10)).toEqual([])
    expect(parsePageRange('', 10)).toEqual([])
  })

  it('repetir página é permitido (duplicar folha é pedido legítimo)', () => {
    expect(parsePageRange('1,1,2', 5)).toEqual([1, 1, 2])
  })
})
