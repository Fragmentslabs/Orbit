import { describe, expect, it } from 'vitest'

import { assertSafeSvg, normalizeColor, recolorSvg, resizeSvg, svgInfo } from './svg-ops'

/**
 * What is protected here is the drawing.
 *
 * Swapping the color in an SVG is only worth it if the result is still the same icon: the expensive
 * mistake is not getting the color wrong, it is losing the outline, filling what was hollow
 * or breaking the scale. Each test below is one of those.
 */

const ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">
  <rect x="2" y="2" width="20" height="20" fill="#FF0000" stroke="#00f"/>
  <circle cx="12" cy="12" r="5" fill="none" stroke="#ff0000"/>
  <path d="M0 0h4v4H0z" style="fill:#ff0000;stroke:currentColor"/>
</svg>`

describe('normalizeColor', () => {
  it('matches shapes that are the same color', () => {
    expect(normalizeColor('#F00')).toBe('#ff0000')
    expect(normalizeColor('#ff0000')).toBe('#ff0000')
    expect(normalizeColor('rgb(255, 0, 0)')).toBe('#ff0000')
  })

  it('does not invent a name-to-hex translation', () => {
    // Translating the 147 CSS names would bring more error than accuracy; `white`
    // matches `white`, and that is predictable.
    expect(normalizeColor('White')).toBe('white')
  })
})

describe('svgInfo', () => {
  it('reports size, viewBox and the colors that exist in there', () => {
    const info = svgInfo(ICON)
    expect(info.width).toBe(24)
    expect(info.height).toBe(24)
    expect(info.viewBox).toBe('0 0 24 24')
    // Normalized and without repetition: it is what allows asking for the swap without opening the
    // file to find out what is inside.
    expect(info.colors).toEqual(['#0000ff', '#ff0000'])
  })

  it('does not count what is not a color', () => {
    // `none` is the absence of paint and `currentColor` is the page's inheritance.
    expect(svgInfo(ICON).colors).not.toContain('none')
    expect(svgInfo(ICON).colors).not.toContain('currentcolor')
  })

  it('rejects what is not an SVG instead of returning empty', () => {
    expect(() => svgInfo('<html><body>hi</body></html>')).toThrow(/Not an SVG/)
  })
})

describe('recolorSvg', () => {
  it('swaps the requested color and leaves the others', () => {
    const { markup, changed } = recolorSvg(ICON, { map: { '#f00': '#00ff00' } })
    // It matches the three forms in which red appears: uppercase attribute,
    // lowercase attribute and inside the style.
    expect(changed).toBe(3)
    expect(markup).not.toMatch(/#FF0000|#ff0000/i)
    expect(markup).toContain('#00f') // the blue was not touched
  })

  it('does NOT fill what was only outline', () => {
    // `fill="none"` is what makes the circle a ring. Painting it would turn
    // the icon into another drawing.
    const { markup } = recolorSvg(ICON, { all: '#123456' })
    expect(markup).toContain('fill="none"')
  })

  it('does NOT resolve currentColor', () => {
    // It is what lets an icon be recolored by the page that uses it; resolving it
    // here would destroy an icon's most useful property.
    const { markup } = recolorSvg(ICON, { all: '#123456' })
    expect(markup).toContain('currentColor')
  })

  it('all paints everything — the monochrome variant', () => {
    const { markup, changed } = recolorSvg(ICON, { all: '#111111' })
    expect(changed).toBe(4)
    expect(markup).not.toContain('#00f')
    expect(svgInfo(markup).colors).toEqual(['#111111'])
  })

  it('a map that matches nothing returns zero instead of faking success', () => {
    const { changed } = recolorSvg(ICON, { map: { '#abcdef': '#000000' } })
    expect(changed).toBe(0)
  })

  it('a request with no color at all is an error, not a silent copy', () => {
    expect(() => recolorSvg(ICON, {})).toThrow(/map.*all|all.*map/s)
  })
})

describe('resizeSvg', () => {
  it('changes the size and preserves the viewBox', () => {
    // The viewBox is the coordinate system: touching it would crop the drawing.
    const out = resizeSvg(ICON, { width: 512 })
    const info = svgInfo(out)
    expect(info.width).toBe(512)
    expect(info.viewBox).toBe('0 0 24 24')
  })

  it('one side only keeps the proportion', () => {
    const wide = `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="10" viewBox="0 0 40 10"><rect width="40" height="10" fill="#000"/></svg>`
    const info = svgInfo(resizeSvg(wide, { width: 400 }))
    expect(info.width).toBe(400)
    expect(info.height).toBe(100)
  })

  it('an SVG without a viewBox gets one, otherwise the content would stretch', () => {
    const withoutViewBox = `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="20"><rect width="10" height="20" fill="#000"/></svg>`
    expect(svgInfo(resizeSvg(withoutViewBox, { width: 100 })).viewBox).toBe('0 0 10 20')
  })

  it('a request with no measurement is an error', () => {
    expect(() => resizeSvg(ICON, {})).toThrow(/width/)
  })
})

describe('assertSafeSvg', () => {
  it('accepts a plain SVG', () => {
    expect(() => assertSafeSvg(ICON)).not.toThrow()
  })

  it('rejects script and event handler', () => {
    // It does not run where we show it (image/svg+xml inside <img>), but it
    // goes along with the file the person downloads and takes elsewhere.
    expect(() =>
      assertSafeSvg('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
    ).toThrow(/script/i)
    expect(() =>
      assertSafeSvg('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>'),
    ).toThrow(/event handler/i)
  })

  it('rejects what is not an SVG', () => {
    expect(() => assertSafeSvg('just some text')).toThrow(/Not an SVG/)
  })
})
