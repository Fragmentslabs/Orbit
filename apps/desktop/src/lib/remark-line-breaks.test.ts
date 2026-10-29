import { describe, expect, it } from 'vitest'

import { applyChatLineBreaks } from './remark-line-breaks'

/**
 * O que estes testes fixam é o LIMITE da regra: a quebra simples vira <br> no
 * parágrafo, e em mais lugar nenhum. Sem esse limite, um texto com
 * "linha\na" dentro de um bloco de código ganharia uma linha em branco que
 * ninguém escreveu.
 */
interface Node {
  type: string
  value?: string
  children?: Node[]
}

function run(tree: Node): Node {
  applyChatLineBreaks(tree)
  return tree
}

function paragraph(...children: Node[]): Node {
  return { type: 'paragraph', children }
}

function text(value: string): Node {
  return { type: 'text', value }
}

describe('remarkChatLineBreaks', () => {
  it('quebra simples no parágrafo vira nó break', () => {
    const tree = run({ type: 'root', children: [paragraph(text('primeira\nsegunda'))] })

    expect(tree.children?.[0].children).toEqual([
      { type: 'text', value: 'primeira' },
      { type: 'break' },
      { type: 'text', value: 'segunda' },
    ])
  })

  it('parágrafo de uma linha só não muda', () => {
    const tree = run({ type: 'root', children: [paragraph(text('uma linha'))] })

    expect(tree.children?.[0].children).toEqual([{ type: 'text', value: 'uma linha' }])
  })

  it('quebra no fim do texto não vira linha em branco', () => {
    const tree = run({ type: 'root', children: [paragraph(text('fim\n'))] })

    expect(tree.children?.[0].children).toEqual([{ type: 'text', value: 'fim' }])
  })

  it('bloco de código fica intacto', () => {
    const code: Node = { type: 'code', value: 'linha 1\nlinha 2' }
    const tree = run({ type: 'root', children: [code] })

    expect(tree.children?.[0]).toEqual(code)
  })

  it('alcança o parágrafo dentro do item de lista', () => {
    const tree = run({
      type: 'root',
      children: [
        {
          type: 'list',
          children: [{ type: 'listItem', children: [paragraph(text('um\ndois'))] }],
        },
      ],
    })

    const item = tree.children?.[0].children?.[0]
    expect(item?.children?.[0].children).toEqual([
      { type: 'text', value: 'um' },
      { type: 'break' },
      { type: 'text', value: 'dois' },
    ])
  })

  it('título também mantém a quebra', () => {
    const tree = run({
      type: 'root',
      children: [{ type: 'heading', children: [text('título\ncontinuado')] }],
    })

    expect(tree.children?.[0].children).toEqual([
      { type: 'text', value: 'título' },
      { type: 'break' },
      { type: 'text', value: 'continuado' },
    ])
  })
})
