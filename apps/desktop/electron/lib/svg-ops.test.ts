import { describe, expect, it } from 'vitest'

import { assertSafeSvg, normalizeColor, recolorSvg, resizeSvg, svgInfo } from './svg-ops'

/**
 * O que se protege aqui é o desenho.
 *
 * Trocar cor num SVG só vale se o resultado continuar sendo o mesmo ícone: o
 * erro caro não é errar a cor, é perder o contorno, preencher o que era vazado
 * ou quebrar a escala. Cada teste abaixo é uma dessas.
 */

const ICONE = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">
  <rect x="2" y="2" width="20" height="20" fill="#FF0000" stroke="#00f"/>
  <circle cx="12" cy="12" r="5" fill="none" stroke="#ff0000"/>
  <path d="M0 0h4v4H0z" style="fill:#ff0000;stroke:currentColor"/>
</svg>`

describe('normalizeColor', () => {
  it('iguala as formas que são a mesma cor', () => {
    expect(normalizeColor('#F00')).toBe('#ff0000')
    expect(normalizeColor('#ff0000')).toBe('#ff0000')
    expect(normalizeColor('rgb(255, 0, 0)')).toBe('#ff0000')
  })

  it('não inventa tradução de nome para hexadecimal', () => {
    // Traduzir os 147 nomes do CSS traria mais erro do que acerto; `white`
    // casa com `white`, e isso é previsível.
    expect(normalizeColor('White')).toBe('white')
  })
})

describe('svgInfo', () => {
  it('relata tamanho, viewBox e as cores que existem lá dentro', () => {
    const info = svgInfo(ICONE)
    expect(info.width).toBe(24)
    expect(info.height).toBe(24)
    expect(info.viewBox).toBe('0 0 24 24')
    // Normalizadas e sem repetição: é o que permite pedir a troca sem abrir o
    // arquivo para descobrir o que tem dentro.
    expect(info.colors).toEqual(['#0000ff', '#ff0000'])
  })

  it('não conta como cor o que não é', () => {
    // `none` é ausência de pintura e `currentColor` é a herança da página.
    expect(svgInfo(ICONE).colors).not.toContain('none')
    expect(svgInfo(ICONE).colors).not.toContain('currentcolor')
  })

  it('recusa o que não é SVG em vez de devolver vazio', () => {
    expect(() => svgInfo('<html><body>oi</body></html>')).toThrow(/Não é um SVG/)
  })
})

describe('recolorSvg', () => {
  it('troca a cor pedida e deixa as outras', () => {
    const { markup, changed } = recolorSvg(ICONE, { map: { '#f00': '#00ff00' } })
    // Casa nas três formas em que o vermelho aparece: atributo maiúsculo,
    // atributo minúsculo e dentro do style.
    expect(changed).toBe(3)
    expect(markup).not.toMatch(/#FF0000|#ff0000/i)
    expect(markup).toContain('#00f') // o azul não foi tocado
  })

  it('NÃO preenche o que era só contorno', () => {
    // `fill="none"` é o que faz o círculo ser um anel. Pintá-lo transformaria
    // o ícone em outro desenho.
    const { markup } = recolorSvg(ICONE, { all: '#123456' })
    expect(markup).toContain('fill="none"')
  })

  it('NÃO resolve currentColor', () => {
    // É o que deixa um ícone ser recolorido pela página que o usa; resolver
    // aqui destruiria a propriedade mais útil de um ícone.
    const { markup } = recolorSvg(ICONE, { all: '#123456' })
    expect(markup).toContain('currentColor')
  })

  it('all pinta tudo — a variante monocromática', () => {
    const { markup, changed } = recolorSvg(ICONE, { all: '#111111' })
    expect(changed).toBe(4)
    expect(markup).not.toContain('#00f')
    expect(svgInfo(markup).colors).toEqual(['#111111'])
  })

  it('mapa que não casa devolve zero em vez de fingir sucesso', () => {
    const { changed } = recolorSvg(ICONE, { map: { '#abcdef': '#000000' } })
    expect(changed).toBe(0)
  })

  it('pedido sem cor nenhuma é erro, não cópia silenciosa', () => {
    expect(() => recolorSvg(ICONE, {})).toThrow(/map.*all|all.*map/s)
  })
})

describe('resizeSvg', () => {
  it('muda o tamanho e preserva o viewBox', () => {
    // O viewBox é o sistema de coordenadas: mexer nele recortaria o desenho.
    const out = resizeSvg(ICONE, { width: 512 })
    const info = svgInfo(out)
    expect(info.width).toBe(512)
    expect(info.viewBox).toBe('0 0 24 24')
  })

  it('um lado só mantém a proporção', () => {
    const largo = `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="10" viewBox="0 0 40 10"><rect width="40" height="10" fill="#000"/></svg>`
    const info = svgInfo(resizeSvg(largo, { width: 400 }))
    expect(info.width).toBe(400)
    expect(info.height).toBe(100)
  })

  it('SVG sem viewBox ganha um, senão o conteúdo esticaria', () => {
    const sem = `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="20"><rect width="10" height="20" fill="#000"/></svg>`
    expect(svgInfo(resizeSvg(sem, { width: 100 })).viewBox).toBe('0 0 10 20')
  })

  it('pedido sem medida é erro', () => {
    expect(() => resizeSvg(ICONE, {})).toThrow(/width/)
  })
})

describe('assertSafeSvg', () => {
  it('aceita um SVG comum', () => {
    expect(() => assertSafeSvg(ICONE)).not.toThrow()
  })

  it('recusa script e manipulador de evento', () => {
    // Não executa onde nós mostramos (image/svg+xml dentro de <img>), mas
    // acompanha o arquivo que a pessoa baixa e leva para outro lugar.
    expect(() =>
      assertSafeSvg('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
    ).toThrow(/script/i)
    expect(() =>
      assertSafeSvg('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>'),
    ).toThrow(/evento/i)
  })

  it('recusa o que não é SVG', () => {
    expect(() => assertSafeSvg('só um texto')).toThrow(/Não é um SVG/)
  })
})
