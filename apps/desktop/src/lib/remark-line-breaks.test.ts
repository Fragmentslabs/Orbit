import { describe, expect, it } from 'vitest'

import { applyChatLineBreaks } from './remark-line-breaks'

/**
 * What these tests pin down is the LIMIT of the rule: the single break becomes <br> in the
 * paragraph, and nowhere else. Without that limit, a text with
 * "linha\na" inside a code block would gain a blank line that
 * nobody wrote.
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
  it('a simple break in the paragraph becomes a break node', () => {
    const tree = run({ type: 'root', children: [paragraph(text('primeira\nsegunda'))] })

    expect(tree.children?.[0].children).toEqual([
      { type: 'text', value: 'primeira' },
      { type: 'break' },
      { type: 'text', value: 'segunda' },
    ])
  })

  it('a one-line paragraph does not change', () => {
    const tree = run({ type: 'root', children: [paragraph(text('uma linha'))] })

    expect(tree.children?.[0].children).toEqual([{ type: 'text', value: 'uma linha' }])
  })

  it('a break at the end of the text does not become a blank line', () => {
    const tree = run({ type: 'root', children: [paragraph(text('fim\n'))] })

    expect(tree.children?.[0].children).toEqual([{ type: 'text', value: 'fim' }])
  })

  it('a code block stays intact', () => {
    const code: Node = { type: 'code', value: 'linha 1\nlinha 2' }
    const tree = run({ type: 'root', children: [code] })

    expect(tree.children?.[0]).toEqual(code)
  })

  it('reaches the paragraph inside the list item', () => {
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

  it('a heading also keeps the break', () => {
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
