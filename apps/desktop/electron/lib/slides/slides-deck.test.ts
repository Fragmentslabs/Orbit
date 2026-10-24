import { describe, expect, it } from 'vitest'
import {
  parseDeckSize,
  plainText,
  readDeckSummary,
  slideBodies,
  slideNotes,
  slideTitle,
} from './slides-deck'

const deck = `<!doctype html>
<html><head><title>Orbit em 3 slides</title></head>
<body>
  <section class="slide cover" data-title="Capa">
    <h1>Orbit</h1>
    <aside class="notes">Diga o nome e pare.</aside>
  </section>
  <section class="slide">
    <h2>O que ele faz</h2>
    <ul><li>código</li><li>vídeo</li></ul>
  </section>
  <section class="slide">
    <p>Sem heading nenhum.</p>
    <div data-notes="Nota por atributo">corpo</div>
  </section>
</body></html>`

describe('plainText', () => {
  it('tira tags, scripts e estilos e resolve entidades', () => {
    expect(plainText('<h1>Oi <em>mundo</em></h1>')).toBe('Oi mundo')
    expect(plainText('<script>alert(1)</script><style>p{}</style>texto')).toBe('texto')
    expect(plainText('a &amp; b &lt;c&gt; &quot;d&quot; &#65; &#x42;')).toBe('a & b <c> "d" A B')
    expect(plainText('  muito   espaço \n aqui ')).toBe('muito espaço aqui')
  })
})

describe('slideBodies', () => {
  it('devolve os slides de TOPO, na ordem, com os atributos da abertura', () => {
    const bodies = slideBodies(deck)
    expect(bodies).toHaveLength(3)
    expect(bodies[0].attrs).toContain('data-title="Capa"')
    expect(bodies[0].body).toContain('<h1>Orbit</h1>')
    expect(bodies[1].body).toContain('O que ele faz')
  })

  it('não conta uma seção aninhada como slide', () => {
    const html = `<section class="slide"><h1>A</h1><section class="slide"><h2>interna</h2></section></section>
      <section class="slide"><h1>B</h1></section>`
    const bodies = slideBodies(html)
    expect(bodies).toHaveLength(2)
    expect(bodies[0].body).toContain('interna')
    expect(bodies[1].body).toContain('B')
  })

  it('ignora seções sem a classe slide', () => {
    expect(slideBodies('<section class="board"><h1>x</h1></section>')).toHaveLength(0)
  })
})

describe('slideTitle / slideNotes', () => {
  it('prefere data-title, depois o heading, depois "Slide N"', () => {
    expect(slideTitle('<h1>Ignorado</h1>', 'data-title="Escolhido"', 0)).toBe('Escolhido')
    expect(slideTitle('<h1>Do <em>heading</em></h1>', '', 0)).toBe('Do heading')
    expect(slideTitle('<h3>Terceiro</h3>', null, 4)).toBe('Terceiro')
    expect(slideTitle('<p>nada</p>', null, 2)).toBe('Slide 3')
  })

  it('lê as notas de <aside class="notes"> ou de data-notes', () => {
    expect(slideNotes('<aside class="notes">fale <b>alto</b></aside>')).toBe('fale alto')
    expect(slideNotes('<div data-notes="curta">x</div>')).toBe('curta')
    expect(slideNotes('<aside class="algo">não é nota</aside>')).toBe('')
  })
})

describe('readDeckSummary', () => {
  it('resume o deck inteiro como o runtime faria', () => {
    const summary = readDeckSummary(deck)
    expect(summary.title).toBe('Orbit em 3 slides')
    expect(summary.slides.map((s) => s.title)).toEqual(['Capa', 'O que ele faz', 'Slide 3'])
    expect(summary.slides[0].notes).toBe('Diga o nome e pare.')
    expect(summary.slides[2].notes).toBe('Nota por atributo')
    expect(summary.slides[1].notes).toBe('')
  })

  it('deck sem <section class="slide"> não tem slides', () => {
    expect(readDeckSummary('<html><body><h1>nada</h1></body></html>').slides).toEqual([])
  })

  it('não explode com HTML truncado no meio de um slide', () => {
    const summary = readDeckSummary('<section class="slide"><h1>Aberto')
    expect(summary.slides).toEqual([])
  })
})

describe('parseDeckSize', () => {
  const fallback = { width: 1280, height: 720 }

  it('sem meta, fica no 16:9 padrão', () => {
    expect(parseDeckSize('<html><body><section class="slide">a</section></body></html>', fallback)).toEqual(
      fallback,
    )
  })

  it('lê width/height do meta', () => {
    const html = '<head><meta name="orbit-slides" content="width=1920,height=1080"></head>'
    expect(parseDeckSize(html, fallback)).toEqual({ width: 1920, height: 1080 })
  })

  it('aceita ponto e vírgula e ignora chaves desconhecidas', () => {
    const html = '<meta content="width=1600; height=900; fps=30" name="orbit-slides">'
    expect(parseDeckSize(html, fallback)).toEqual({ width: 1600, height: 900 })
  })

  it('valor inválido não derruba o padrão', () => {
    const html = '<meta name="orbit-slides" content="width=0,height=abc">'
    expect(parseDeckSize(html, fallback)).toEqual(fallback)
  })

  it('um eixo declarado só muda aquele eixo', () => {
    const html = '<meta name="orbit-slides" content="width=1080">'
    expect(parseDeckSize(html, fallback)).toEqual({ width: 1080, height: 720 })
  })
})
