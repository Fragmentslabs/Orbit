import type { Element, ElementContent, Root } from 'hast'
import { describe, expect, it } from 'vitest'

import { isCaptionWorthy, rehypeFigureCaption } from './figure-caption'

/**
 * The caption diverges from standard Markdown on purpose, so what these tests
 * pin down is the LIMIT of that divergence: only the figure on its own, and only when the alt
 * was written to be read. Without that, "screenshot.png" would become a visible
 * caption and the cure would be worse than the disease.
 */
function img(alt: string): Element {
  return { type: 'element', tagName: 'img', properties: { alt, src: 'x.png' }, children: [] }
}

function paragraph(...children: ElementContent[]): Element {
  return { type: 'element', tagName: 'p', properties: {}, children }
}

function run(...children: ElementContent[]): Root {
  const tree: Root = { type: 'root', children }
  rehypeFigureCaption()(tree)
  return tree
}

describe('isCaptionWorthy', () => {
  it('accepts an alt that describes the figure', () => {
    expect(isCaptionWorthy('Dados Locais')).toBe(true)
    expect(isCaptionWorthy('Tela de seleção de projetos')).toBe(true)
    // A single word also describes, as long as it is not a generic label.
    expect(isCaptionWorthy('Arquitetura')).toBe(true)
  })

  it('rejects a file name', () => {
    expect(isCaptionWorthy('screenshot.png')).toBe(false)
    expect(isCaptionWorthy('Captura de tela 2024.jpg')).toBe(false)
  })

  it('rejects an alt that only repeats the file name', () => {
    expect(isCaptionWorthy('image', 'image.png')).toBe(false)
    expect(isCaptionWorthy('Figura 2', 'figura-2.png')).toBe(false)
    expect(isCaptionWorthy('img', '/assets/img.jpg?x=1')).toBe(false)
  })

  it('accepts it when the alt describes, even with a src', () => {
    expect(isCaptionWorthy('Tela de seleção de projetos', 'tela.png')).toBe(true)
  })

  it('rejects empty and whitespace', () => {
    expect(isCaptionWorthy('')).toBe(false)
    expect(isCaptionWorthy('   ')).toBe(false)
  })
})

describe('rehypeFigureCaption', () => {
  it('a figure on its own becomes a <figure> with a caption', () => {
    const tree = run(paragraph(img('Dados Locais')))

    const figure = tree.children[0] as Element
    expect(figure.tagName).toBe('figure')
    const [image, caption] = figure.children as Element[]
    expect(image.tagName).toBe('img')
    expect(caption.tagName).toBe('figcaption')
    expect(caption.children[0]).toEqual({ type: 'text', value: 'Dados Locais' })
  })

  it('the caption is hidden from the screen reader — it repeats the alt', () => {
    const tree = run(paragraph(img('Dados Locais')))

    const caption = (tree.children[0] as Element).children[1] as Element
    expect(caption.properties?.ariaHidden).toBe('true')
  })

  it('space around the image does not count as content', () => {
    const tree = run(
      paragraph({ type: 'text', value: '\n' }, img('Dados Locais'), { type: 'text', value: '\n' }),
    )

    expect((tree.children[0] as Element).tagName).toBe('figure')
  })

  it('an image in the middle of the text stays an inline illustration', () => {
    const tree = run(paragraph({ type: 'text', value: 'veja ' }, img('Dados Locais')))

    expect((tree.children[0] as Element).tagName).toBe('p')
  })

  it('a row of images does not become three figures', () => {
    const tree = run(paragraph(img('Build'), img('Cobertura')))

    expect((tree.children[0] as Element).tagName).toBe('p')
  })

  it('a generic alt gets no caption', () => {
    const tree = run(paragraph(img('screenshot.png')))

    expect((tree.children[0] as Element).tagName).toBe('p')
  })

  it('reaches a nested paragraph, not only the root', () => {
    const tree = run({
      type: 'element',
      tagName: 'blockquote',
      properties: {},
      children: [paragraph(img('Dados Locais'))],
    })

    const quote = tree.children[0] as Element
    expect((quote.children[0] as Element).tagName).toBe('figure')
  })
})
