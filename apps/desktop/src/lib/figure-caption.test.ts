import type { Element, ElementContent, Root } from 'hast'
import { describe, expect, it } from 'vitest'

import { isCaptionWorthy, rehypeFigureCaption } from './figure-caption'

/**
 * A legenda diverge do Markdown padrão de propósito, então o que estes testes
 * fixam é o LIMITE dessa divergência: só a figura sozinha, e só quando o alt
 * foi escrito para ser lido. Sem isso, "screenshot.png" viraria legenda
 * visível e o remédio ficaria pior que a doença.
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
  it('aceita alt que descreve a figura', () => {
    expect(isCaptionWorthy('Dados Locais')).toBe(true)
    expect(isCaptionWorthy('Tela de seleção de projetos')).toBe(true)
    // Uma palavra só também descreve, desde que não seja rótulo genérico.
    expect(isCaptionWorthy('Arquitetura')).toBe(true)
  })

  it('recusa nome de arquivo', () => {
    expect(isCaptionWorthy('screenshot.png')).toBe(false)
    expect(isCaptionWorthy('Captura de tela 2024.jpg')).toBe(false)
  })

  it('recusa rótulo genérico, com ou sem número', () => {
    for (const alt of ['image', 'img', 'Figura', 'figura 2', 'screenshot', 'Tela', 'print_1']) {
      expect(isCaptionWorthy(alt), alt).toBe(false)
    }
  })

  it('recusa vazio e espaço em branco', () => {
    expect(isCaptionWorthy('')).toBe(false)
    expect(isCaptionWorthy('   ')).toBe(false)
  })
})

describe('rehypeFigureCaption', () => {
  it('a figura sozinha vira <figure> com legenda', () => {
    const tree = run(paragraph(img('Dados Locais')))

    const figure = tree.children[0] as Element
    expect(figure.tagName).toBe('figure')
    const [image, caption] = figure.children as Element[]
    expect(image.tagName).toBe('img')
    expect(caption.tagName).toBe('figcaption')
    expect(caption.children[0]).toEqual({ type: 'text', value: 'Dados Locais' })
  })

  it('a legenda é escondida do leitor de tela — ela repete o alt', () => {
    const tree = run(paragraph(img('Dados Locais')))

    const caption = (tree.children[0] as Element).children[1] as Element
    expect(caption.properties?.ariaHidden).toBe('true')
  })

  it('espaço em volta da imagem não conta como conteúdo', () => {
    const tree = run(
      paragraph({ type: 'text', value: '\n' }, img('Dados Locais'), { type: 'text', value: '\n' }),
    )

    expect((tree.children[0] as Element).tagName).toBe('figure')
  })

  it('imagem no meio do texto continua ilustração inline', () => {
    const tree = run(paragraph({ type: 'text', value: 'veja ' }, img('Dados Locais')))

    expect((tree.children[0] as Element).tagName).toBe('p')
  })

  it('fileira de imagens não vira três figuras', () => {
    const tree = run(paragraph(img('Build'), img('Cobertura')))

    expect((tree.children[0] as Element).tagName).toBe('p')
  })

  it('alt genérico não ganha legenda', () => {
    const tree = run(paragraph(img('screenshot.png')))

    expect((tree.children[0] as Element).tagName).toBe('p')
  })

  it('alcança parágrafo aninhado, não só a raiz', () => {
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
