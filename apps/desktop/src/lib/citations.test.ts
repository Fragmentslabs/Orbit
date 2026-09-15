import { describe, expect, it } from 'vitest'

import { parseSourceHref, rescueLegacyCitations } from './citations'
import { sourceAnchor } from '@/electron/lib/document-pages'

/**
 * As duas pontas da citação: o main escreve o endereço, o renderer o lê. Este
 * arquivo fecha o contrato importando os DOIS lados de verdade — a versão
 * anterior copiava a regex para dentro do teste, e uma cópia que diverge passa
 * no teste e quebra no app.
 */

describe('parseSourceHref', () => {
  it('lê o endereço que o sourceAnchor gera', () => {
    expect(parseSourceHref(sourceAnchor('src3', 12, 28))).toEqual({
      docId: 'src3',
      page: 12,
      fromLine: 28,
      toLine: undefined,
    })
  })

  it('lê intervalo de linhas', () => {
    expect(parseSourceHref(sourceAnchor('doc1', 4, 28, 31))).toMatchObject({
      fromLine: 28,
      toLine: 31,
    })
  })

  it('lê citação só de página', () => {
    expect(parseSourceHref(sourceAnchor('doc2', 7))).toMatchObject({ page: 7, fromLine: undefined })
  })

  it('ignora link comum — a citação não pode sequestrar um link da web', () => {
    expect(parseSourceHref('https://exemplo.com/p1')).toBeNull()
  })

  it('ignora id forjado', () => {
    expect(parseSourceHref('#orbit-source/../../etc/p1')).toBeNull()
    expect(parseSourceHref('#orbit-source/src1/p')).toBeNull()
  })
})

describe('rescueLegacyCitations', () => {
  /**
   * O formato antigo (`orbit-source://`) era apagado pelo sanitizador e
   * aparecia como "[blocked]" na conversa. As respostas já gravadas guardam o
   * texto como foi escrito, então só a reescrita na renderização as conserta.
   */
  it('converte a citação antiga para a atual', () => {
    const antigo = 'Unicast é um para um [1](orbit-source://src1/p3L12).'
    const novo = rescueLegacyCitations(antigo)
    expect(novo).toBe('Unicast é um para um [1](#orbit-source/src1/p3L12).')
    expect(parseSourceHref('#orbit-source/src1/p3L12')).not.toBeNull()
  })

  it('converte todas as ocorrências da mesma resposta', () => {
    const texto = '[1](orbit-source://src1/p1L2) e [2](orbit-source://doc2/p4L9-11)'
    expect(rescueLegacyCitations(texto)).toBe('[1](#orbit-source/src1/p1L2) e [2](#orbit-source/doc2/p4L9-11)')
  })

  it('não toca em texto sem citação antiga — mesma referência de volta', () => {
    const texto = 'Veja [1](https://exemplo.com) e [2](#orbit-source/src1/p1L2).'
    expect(rescueLegacyCitations(texto)).toBe(texto)
  })

  it('não reescreve a palavra solta fora de um link', () => {
    const texto = 'O esquema orbit-source:// foi trocado por fragmento.'
    expect(rescueLegacyCitations(texto)).toBe(texto)
  })
})
