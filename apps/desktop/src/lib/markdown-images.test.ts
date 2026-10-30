import { describe, expect, it } from 'vitest'

import {
  isExternalSrc,
  markdownImageSources,
  withResolvedImages,
} from './markdown-images'

/**
 * The .md preview showed "Image not available" in every document
 * with a figure: the relative path resolved against the app's origin, not against the
 * file's folder. Finding what to ask for and swapping it afterwards is what these tests
 * protect — getting it wrong here breaks the figure again, and in silence.
 */
describe('markdownImageSources', () => {
  it('finds the three forms that appear in documentation', () => {
    const md = [
      '![screen](./images/production.png)',
      '![with title](../docs/flow.png "Flow")',
      '![with space](<folder with space/x.png>)',
      '<img src="assets/logo.svg" width="40">',
    ].join('\n\n')

    expect(markdownImageSources(md).sort()).toEqual([
      '../docs/flow.png',
      './images/production.png',
      'assets/logo.svg',
      'folder with space/x.png',
    ])
  })

  it('the title does not go into the path', () => {
    expect(markdownImageSources('![a](img/x.png "Uma legenda")')).toEqual(['img/x.png'])
  })

  it('does not repeat the same path', () => {
    expect(markdownImageSources('![a](img/x.png)\n\n![b](img/x.png)')).toEqual(['img/x.png'])
  })

  it('leaves alone what the renderer already loads by itself', () => {
    const md = [
      '![remota](https://exemplo.com/a.png)',
      '![embutida](data:image/png;base64,AAAA)',
      '![galeria](orbit-media://img_1.png)',
      '![sem protocolo](//cdn.exemplo.com/b.png)',
    ].join('\n\n')

    expect(markdownImageSources(md)).toEqual([])
  })

  it('does not confuse a link with a figure', () => {
    expect(markdownImageSources('[não é imagem](./doc.md)')).toEqual([])
  })
})

describe('isExternalSrc', () => {
  it('separates address from path', () => {
    expect(isExternalSrc('https://a/b.png')).toBe(true)
    expect(isExternalSrc('data:image/png;base64,AA')).toBe(true)
    expect(isExternalSrc('orbit-artifact://x.png')).toBe(true)
    expect(isExternalSrc('./a/b.png')).toBe(false)
    expect(isExternalSrc('../a/b.png')).toBe(false)
    expect(isExternalSrc('a/b.png')).toBe(false)
  })
})

describe('withResolvedImages', () => {
  it('replaces the path with the data URL, preserving the rest of the line', () => {
    const out = withResolvedImages('![screen](./images/x.png "Caption")', {
      './images/x.png': 'data:image/png;base64,AA',
    })

    expect(out).toBe('![screen](data:image/png;base64,AA "Caption")')
  })

  it('replaces in a path with spaces, without undoing the <>', () => {
    const out = withResolvedImages('![a](<folder with space/x.png>)', {
      'folder with space/x.png': 'data:image/png;base64,AA',
    })

    expect(out).toBe('![a](<data:image/png;base64,AA>)')
  })

  it('replaces it in the <img> too', () => {
    const out = withResolvedImages('<img src="assets/logo.svg" width="40">', {
      'assets/logo.svg': 'data:image/svg+xml;base64,BB',
    })

    expect(out).toBe('<img src="data:image/svg+xml;base64,BB" width="40">')
  })

  it('a figure that did not resolve stays as it was — that is how you see it is missing', () => {
    const out = withResolvedImages('![existe](a.png)\n\n![sumiu](b.png)', {
      'a.png': 'data:image/png;base64,AA',
    })

    expect(out).toContain('![existe](data:image/png;base64,AA)')
    expect(out).toContain('![sumiu](b.png)')
  })

  it('with nothing resolved, it returns the text intact', () => {
    const md = '![a](x.png)'

    expect(withResolvedImages(md, {})).toBe(md)
  })
})
