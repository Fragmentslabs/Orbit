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
    <aside class="notes">Say the name and stop.</aside>
  </section>
  <section class="slide">
    <h2>What it does</h2>
    <ul><li>code</li><li>video</li></ul>
  </section>
  <section class="slide">
    <p>No heading at all.</p>
    <div data-notes="Note by attribute">body</div>
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
  it('returns the TOP slides, in order, with the opening attributes', () => {
    const bodies = slideBodies(deck)
    expect(bodies).toHaveLength(3)
    expect(bodies[0].attrs).toContain('data-title="Capa"')
    expect(bodies[0].body).toContain('<h1>Orbit</h1>')
    expect(bodies[1].body).toContain('What it does')
  })

  it('does not count a nested section as a slide', () => {
    const html = `<section class="slide"><h1>A</h1><section class="slide"><h2>inner</h2></section></section>
      <section class="slide"><h1>B</h1></section>`
    const bodies = slideBodies(html)
    expect(bodies).toHaveLength(2)
    expect(bodies[0].body).toContain('inner')
    expect(bodies[1].body).toContain('B')
  })

  it('ignores sections without the slide class', () => {
    expect(slideBodies('<section class="board"><h1>x</h1></section>')).toHaveLength(0)
  })
})

describe('slideTitle / slideNotes', () => {
  it('prefers data-title, then the heading, then "Slide N"', () => {
    expect(slideTitle('<h1>Ignorado</h1>', 'data-title="Escolhido"', 0)).toBe('Escolhido')
    expect(slideTitle('<h1>Do <em>heading</em></h1>', '', 0)).toBe('Do heading')
    expect(slideTitle('<h3>Terceiro</h3>', null, 4)).toBe('Terceiro')
    expect(slideTitle('<p>nada</p>', null, 2)).toBe('Slide 3')
  })

  it('reads the notes from <aside class="notes"> or from data-notes', () => {
    expect(slideNotes('<aside class="notes">fale <b>alto</b></aside>')).toBe('fale alto')
    expect(slideNotes('<div data-notes="curta">x</div>')).toBe('curta')
    expect(slideNotes('<aside class="algo">not a note</aside>')).toBe('')
  })
})

describe('readDeckSummary', () => {
  it('summarizes the whole deck the way the runtime would', () => {
    const summary = readDeckSummary(deck)
    expect(summary.title).toBe('Orbit em 3 slides')
    expect(summary.slides.map((s) => s.title)).toEqual(['Capa', 'What it does', 'Slide 3'])
    expect(summary.slides[0].notes).toBe('Say the name and stop.')
    expect(summary.slides[2].notes).toBe('Note by attribute')
    expect(summary.slides[1].notes).toBe('')
  })

  it('a deck with no <section class="slide"> has no slides', () => {
    expect(readDeckSummary('<html><body><h1>nada</h1></body></html>').slides).toEqual([])
  })

  it('does not explode with HTML truncated in the middle of a slide', () => {
    const summary = readDeckSummary('<section class="slide"><h1>Aberto')
    expect(summary.slides).toEqual([])
  })
})

describe('parseDeckSize', () => {
  const fallback = { width: 1280, height: 720 }

  it('with no meta, it stays at the default 16:9', () => {
    expect(parseDeckSize('<html><body><section class="slide">a</section></body></html>', fallback)).toEqual(
      fallback,
    )
  })

  it('reads width/height from the meta', () => {
    const html = '<head><meta name="orbit-slides" content="width=1920,height=1080"></head>'
    expect(parseDeckSize(html, fallback)).toEqual({ width: 1920, height: 1080 })
  })

  it('accepts semicolons and ignores unknown keys', () => {
    const html = '<meta content="width=1600; height=900; fps=30" name="orbit-slides">'
    expect(parseDeckSize(html, fallback)).toEqual({ width: 1600, height: 900 })
  })

  it('an invalid value does not break the default', () => {
    const html = '<meta name="orbit-slides" content="width=0,height=abc">'
    expect(parseDeckSize(html, fallback)).toEqual(fallback)
  })

  it('a declared axis only changes that axis', () => {
    const html = '<meta name="orbit-slides" content="width=1080">'
    expect(parseDeckSize(html, fallback)).toEqual({ width: 1080, height: 720 })
  })
})
