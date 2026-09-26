import { describe, expect, it } from 'vitest'
import { selectDraftImages } from './image-drafts'

/**
 * O que está em jogo: de um lado, a galeria do usuário virando o rascunho do
 * agente; do outro, apagar uma imagem que ele queria. Os dois casos reais
 * estão aqui — a escada, que a primeira versão já pegava, e o leque, que ela
 * deixava passar inteiro.
 */

const cadeia = (pares: [string, string][]) => new Map(pares)

describe('selectDraftImages', () => {
  it('descarta o degrau da escada e mantém o topo', () => {
    const drafts = selectDraftImages({
      produced: ['b', 'c', 'd'],
      parents: cadeia([
        ['b', 'anexo'],
        ['c', 'b'],
        ['d', 'c'],
      ]),
      keep: new Set(),
    })
    expect(drafts.sort()).toEqual(['b', 'c'])
  })

  it('descarta as tentativas anteriores feitas da mesma base', () => {
    // "tira melhor o verde": quatro recortes do MESMO original, com tolerâncias
    // diferentes. Nenhum é pai do outro — era o caso que passava inteiro.
    const drafts = selectDraftImages({
      produced: ['t1', 't2', 't3', 't4'],
      parents: cadeia([
        ['t1', 'anexo'],
        ['t2', 'anexo'],
        ['t3', 'anexo'],
        ['t4', 'anexo'],
      ]),
      keep: new Set(),
    })
    expect(drafts.sort()).toEqual(['t1', 't2', 't3'])
  })

  it('nunca descarta o que o agente marcou como entrega', () => {
    // Variantes para o usuário escolher: mesma base, todas sobrevivem.
    const drafts = selectDraftImages({
      produced: ['v1', 'v2', 'v3'],
      parents: cadeia([
        ['v1', 'anexo'],
        ['v2', 'anexo'],
        ['v3', 'anexo'],
      ]),
      keep: new Set(['v1', 'v2', 'v3']),
    })
    expect(drafts).toEqual([])
  })

  it('não toca no anexo do usuário nem na base de um turno anterior', () => {
    // 'anexo' é pai de tudo e não está em produced: não é desta resposta.
    const drafts = selectDraftImages({
      produced: ['b'],
      parents: cadeia([['b', 'anexo']]),
      keep: new Set(),
    })
    expect(drafts).toEqual([])
  })

  it('mistura os dois formatos: refez duas vezes e depois seguiu editando', () => {
    // t1 e t2 saem do anexo (t1 é tentativa descartada); de t2 sai o texto,
    // que por sua vez vira a versão comprimida. Sobra só a última.
    const drafts = selectDraftImages({
      produced: ['t1', 't2', 'texto', 'final'],
      parents: cadeia([
        ['t1', 'anexo'],
        ['t2', 'anexo'],
        ['texto', 't2'],
        ['final', 'texto'],
      ]),
      keep: new Set(),
    })
    expect(drafts.sort()).toEqual(['t1', 't2', 'texto'])
  })
})
