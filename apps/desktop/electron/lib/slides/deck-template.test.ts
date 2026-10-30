import { describe, expect, it } from 'vitest'
import { buildDeckHtml } from './deck-template'
import { readDeckSummary } from './slides-deck'

describe('buildDeckHtml', () => {
  it('builds one <section class="slide"> per slide, in order', () => {
    const html = buildDeckHtml({
      title: 'Meu deck',
      slides: [
        { html: '<h1>Capa</h1>', notes: 'abertura' },
        { html: '<h2>Um</h2>' },
        { html: '<h2>Dois</h2>' },
      ],
    })
    expect(html.match(/<section class="slide"/g)).toHaveLength(3)
    expect(html.indexOf('Capa')).toBeLessThan(html.indexOf('<h2>Um</h2>'))
    expect(html.indexOf('<h2>Um</h2>')).toBeLessThan(html.indexOf('<h2>Dois</h2>'))
  })

  it('declares the 16:9 stage and the document title', () => {
    const html = buildDeckHtml({ title: 'Deck do produto', slides: [{ html: '<h1>x</h1>' }] })
    expect(html).toContain('<meta name="orbit-slides" content="width=1280,height=720">')
    expect(html).toContain('<title>Deck do produto</title>')
    expect(html).toContain('<html lang="pt-BR">')
  })

  it('escapes title and notes, but leaves the slide content as HTML', () => {
    const html = buildDeckHtml({
      title: 'A & B',
      slides: [{ title: 'Capa "1"', html: '<h1>Orbit & cia</h1>', notes: 'diga <forte> e 5 > 3' }],
    })
    expect(html).toContain('<title>A &amp; B</title>')
    expect(html).toContain('data-title="Capa &quot;1&quot;"')
    expect(html).toContain('<h1>Orbit & cia</h1>')
    expect(html).toContain('<aside class="notes">diga &lt;forte&gt; e 5 &gt; 3</aside>')
  })

  it('brings no script and no runtime — navigation belongs to the app', () => {
    const html = buildDeckHtml({ title: 't', slides: [{ html: '<h1>x</h1>' }] })
    expect(html).not.toContain('<script')
    expect(html).not.toContain('__orbit_slides_runtime')
    expect(html).not.toContain('orbit-motion')
  })

  it('what it builds is what the main reader understands', () => {
    const html = buildDeckHtml({
      title: 'Round trip',
      slides: [
        { title: 'Capa', html: '<h1>Orbit</h1>', notes: 'nota um' },
        { html: '<h2>Segundo</h2>' },
      ],
    })
    const summary = readDeckSummary(html)
    expect(summary.title).toBe('Round trip')
    expect(summary.slides).toEqual([
      { title: 'Capa', notes: 'nota um' },
      { title: 'Segundo', notes: '' },
    ])
  })

  it('a deck with a single slide stays valid', () => {
    const html = buildDeckHtml({ title: 'Um', slides: [{ html: '<p>único</p>' }] })
    expect(readDeckSummary(html).slides).toHaveLength(1)
  })
})
