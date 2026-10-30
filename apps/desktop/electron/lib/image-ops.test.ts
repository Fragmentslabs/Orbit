import sharp from 'sharp'
import { describe, expect, it } from 'vitest'

import { editImage, imageInfo, parseColor, removeBackground } from './image-ops'

/** A rectangle of solid color. */
async function solid(width: number, height: number, color: string): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: color } }).png().toBuffer()
}

/**
 * Red subject centered on a background of the requested color — the case the
 * background cutout exists to solve.
 */
async function subjectOnBackground(background: string, subject = '#c81e1e'): Promise<Buffer> {
  return sharp({ create: { width: 60, height: 60, channels: 3, background } })
    .composite([{ input: await solid(20, 20, subject), top: 20, left: 20 }])
    .png()
    .toBuffer()
}

/** Alpha of a pixel — 0 is cut out, 255 is opaque. */
async function alphaAt(png: Buffer, x: number, y: number): Promise<number> {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  return data[(y * info.width + x) * 4 + 3]
}

describe('parseColor', () => {
  it('accepts the three forms used in practice', () => {
    expect(parseColor('#fff')).toEqual({ r: 255, g: 255, b: 255 })
    expect(parseColor('#1e40AF')).toEqual({ r: 30, g: 64, b: 175 })
    expect(parseColor('rgb(10, 20, 30)')).toEqual({ r: 10, g: 20, b: 30 })
  })

  it('rejects what it does not understand instead of silently going black', () => {
    // A silent error here would paint the image black and look like a bug
    // in the edit, not in the color the model wrote.
    expect(() => parseColor('blue-ish')).toThrow(/Invalid color/)
    expect(() => parseColor('#12345')).toThrow(/Invalid color/)
  })
})

describe('imageInfo', () => {
  it('reports format, size and dominant color', async () => {
    const info = await imageInfo(await solid(40, 25, '#2563eb'))
    expect(info.format).toBe('png')
    expect(info.width).toBe(40)
    expect(info.height).toBe(25)
    // Approximate on purpose: sharp's dominant comes from a binned histogram,
    // so it returns the bin's center and not the exact color. It serves as a
    // background guess, which is what it is used for — not as a measurement.
    expect(info.dominant).toMatch(/^#[0-9a-f]{6}$/)
    const { r, g, b } = parseColor(info.dominant)
    expect(Math.abs(r - 0x25)).toBeLessThan(16)
    expect(Math.abs(g - 0x63)).toBeLessThan(16)
    expect(Math.abs(b - 0xeb)).toBeLessThan(16)
  })
})

describe('removeBackground', () => {
  it('guesses the background from the corners and cuts only it', async () => {
    const result = await removeBackground(await subjectOnBackground('#ffffff'))
    expect(result.color).toBe('#ffffff')
    expect(await alphaAt(result.png, 1, 1)).toBe(0) // corner: background
    expect(await alphaAt(result.png, 30, 30)).toBe(255) // center: subject
    // 60x60 with a 20x20 subject — ~89% of background is left.
    expect(result.removed).toBeGreaterThan(0.85)
    expect(result.removed).toBeLessThan(0.93)
  })

  it('does NOT punch a hole in the subject of the same color as the background', async () => {
    // The case that separates edge-flooding from chroma key: a white square
    // inside the subject. The chroma key would erase both whites.
    const image = await sharp({ create: { width: 60, height: 60, channels: 3, background: '#ffffff' } })
      .composite([
        { input: await solid(30, 30, '#c81e1e'), top: 15, left: 15 },
        { input: await solid(8, 8, '#ffffff'), top: 26, left: 26 },
      ])
      .png()
      .toBuffer()

    const result = await removeBackground(image)
    expect(await alphaAt(result.png, 1, 1)).toBe(0) // outer background: gone
    expect(await alphaAt(result.png, 30, 30)).toBe(255) // inner white: kept
  })

  it('accepts an explicit background color', async () => {
    const result = await removeBackground(await subjectOnBackground('#00ff00'), {
      color: '#00ff00',
    })
    expect(result.color).toBe('#00ff00')
    expect(await alphaAt(result.png, 1, 1)).toBe(0)
  })

  it('zero tolerance does not cut a background that does not match exactly', async () => {
    const result = await removeBackground(await subjectOnBackground('#ffffff'), {
      color: '#000000',
      tolerance: 0,
    })
    expect(result.removed).toBe(0)
    expect(await alphaAt(result.png, 1, 1)).toBe(255)
  })

  it('the tolerance reaches a slightly irregular background', async () => {
    // Almost white background, as it comes out of a scan.
    const noisy = await sharp({ create: { width: 40, height: 40, channels: 3, background: '#f4f4f5' } })
      .composite([{ input: await solid(10, 10, '#111111'), top: 15, left: 15 }])
      .png()
      .toBuffer()
    const tight = await removeBackground(noisy, { color: '#ffffff', tolerance: 1 })
    const loose = await removeBackground(noisy, { color: '#ffffff', tolerance: 10 })
    expect(tight.removed).toBe(0)
    expect(loose.removed).toBeGreaterThan(0.9)
  })

  it('separates by HUE, not by brightness: a lit green screen does not eat skin', async () => {
    // The case that really broke. A real green screen is lit from one
    // side: the background varies from (100,164,77) to (124,201,115), which in RGB is
    // more than halfway to a skin tone — no threshold separates the
    // two. In LAB the variation is almost all luminosity, and the margin comes back.
    const gradient = Buffer.alloc(80 * 80 * 3)
    for (let y = 0; y < 80; y++) {
      for (let x = 0; x < 80; x++) {
        const at = (y * 80 + x) * 3
        const t = x / 79
        gradient[at] = Math.round(100 + t * 24)
        gradient[at + 1] = Math.round(164 + t * 37)
        gradient[at + 2] = Math.round(77 + t * 38)
      }
    }
    const skin = await sharp({
      create: { width: 30, height: 30, channels: 3, background: '#c69473' },
    })
      .png()
      .toBuffer()
    const scene = await sharp(gradient, { raw: { width: 80, height: 80, channels: 3 } })
      .composite([{ input: skin, top: 25, left: 25 }])
      .png()
      .toBuffer()

    const result = await removeBackground(scene)
    expect(await alphaAt(result.png, 2, 40)).toBe(0) // dark background: gone
    expect(await alphaAt(result.png, 77, 40)).toBe(0) // light background: also
    expect(await alphaAt(result.png, 40, 40)).toBe(255) // skin: kept
  })

  it('the automatic tolerance comes from the spread of the frame itself', async () => {
    // Whoever calls has no way of knowing the right number — it depends on the photo.
    const smooth = await removeBackground(await subjectOnBackground('#ffffff'))
    const irregular = await sharp({
      create: { width: 60, height: 60, channels: 3, background: '#cfe8cf' },
    })
      .composite([
        { input: await solid(20, 20, '#c81e1e'), top: 20, left: 20 },
        // Blotch on the frame: the background is not uniform, and the automatic one has to
        // open more than it would on a flat background.
        { input: await solid(60, 4, '#a8d0a8'), top: 0, left: 0 },
      ])
      .png()
      .toBuffer()
    const measured = await removeBackground(irregular)

    expect(measured.limit).toBeGreaterThan(smooth.limit)
    expect(await alphaAt(measured.png, 1, 1)).toBe(0)
    expect(await alphaAt(measured.png, 30, 30)).toBe(255)
  })

  it('despill removes the green stuck to the subject edge', async () => {
    // A real edge is a MIXTURE of subject and background, so next to a green
    // screen the outline comes out greenish. It is what makes a cut look cut out.
    const gray = await sharp({
      create: { width: 60, height: 60, channels: 3, background: '#00c000' },
    })
      .composite([
        { input: await solid(24, 24, '#8a8a8a'), top: 18, left: 18 },
        // The mixture frame around the subject.
        { input: await solid(28, 2, '#4a9a4a'), top: 16, left: 16 },
      ])
      .png()
      .toBuffer()

    const greenish = async (png: Buffer) => {
      const { data } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
      let n = 0
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] < 128) continue
        if (data[i + 1] > data[i] + 18 && data[i + 1] > data[i + 2] + 18) n++
      }
      return n
    }

    const noSpill = await removeBackground(gray, { despill: false })
    const withSpill = await removeBackground(gray)
    expect(await greenish(withSpill.png)).toBeLessThan(await greenish(noSpill.png))
  })

  it('despill does not erase the color of a neutral background', async () => {
    // A white or gray background has no hue to spill. "Correcting" there would only take
    // color away from those who legitimately have it.
    const out = await removeBackground(await subjectOnBackground('#ffffff', '#1e9e1e'))
    const { data } = await sharp(out.png).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    const at = (30 * 60 + 30) * 4
    expect(data[at + 1]).toBeGreaterThan(data[at] + 18) // the subject's green stayed
  })

  it('feather softens the edge instead of leaving it jagged', async () => {
    const hard = await removeBackground(await subjectOnBackground('#ffffff'))
    const soft = await removeBackground(await subjectOnBackground('#ffffff'), { feather: 2 })
    // The hard cut only has 0 and 255; the smoothing creates values in between.
    const alphas = async (png: Buffer) => {
      const { data } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
      let partials = 0
      for (let i = 3; i < data.length; i += 4) if (data[i] > 0 && data[i] < 255) partials++
      return partials
    }
    expect(await alphas(hard.png)).toBe(0)
    expect(await alphas(soft.png)).toBeGreaterThan(0)
  })

  it('feather does NOT offset or list the alpha', async () => {
    // Regression of a real bug: the blur over a 1-channel raw returns 3, and reading
    // the result as 1 channel advances a third of what is needed per pixel. The alpha
    // came out compressed horizontally and in bands — the subject became stripes, and the
    // image looked like a rendering defect instead of a wrong cut.
    const hard = await removeBackground(await subjectOnBackground('#ffffff'))
    const soft = await removeBackground(await subjectOnBackground('#ffffff'), { feather: 1 })

    // The core of the subject stays opaque: an offset would perforate it.
    expect(await alphaAt(soft.png, 30, 30)).toBe(255)
    // And the corner stays cut out.
    expect(await alphaAt(soft.png, 1, 1)).toBe(0)

    // Smoothing changes the EDGE, not the area: the two versions cover almost the same.
    const opaques = async (png: Buffer) => {
      const { data } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
      let n = 0
      for (let i = 3; i < data.length; i += 4) if (data[i] > 128) n++
      return n
    }
    const a = await opaques(hard.png)
    const b = await opaques(soft.png)
    expect(Math.abs(a - b)).toBeLessThan(a * 0.2)
  })
})

describe('editImage', () => {
  it('resizes keeping the proportion', async () => {
    const out = await editImage(await solid(400, 200, '#334155'), { resize: { width: 100 } })
    expect(out.width).toBe(100)
    expect(out.height).toBe(50)
  })

  it('does not upscale by default — upscaling only produces a bigger blur', async () => {
    const out = await editImage(await solid(50, 50, '#334155'), { resize: { width: 500 } })
    expect(out.width).toBe(50)
    const forced = await editImage(await solid(50, 50, '#334155'), {
      resize: { width: 500, enlarge: true },
    })
    expect(forced.width).toBe(500)
  })

  it('crops by the requested rectangle', async () => {
    const out = await editImage(await solid(100, 100, '#334155'), {
      crop: { left: 10, top: 20, width: 30, height: 40 },
    })
    expect(out.width).toBe(30)
    expect(out.height).toBe(40)
  })

  it('a crop outside the image explains what is wrong', async () => {
    await expect(
      editImage(await solid(50, 50, '#334155'), {
        crop: { left: 40, top: 0, width: 30, height: 10 },
      }),
    ).rejects.toThrow(/falls outside the image, which is 50x50/)
  })

  it('trim removes the uniform frame', async () => {
    const withFrame = await sharp({
      create: { width: 100, height: 100, channels: 3, background: '#ffffff' },
    })
      .composite([{ input: await solid(40, 30, '#c81e1e'), top: 35, left: 30 }])
      .png()
      .toBuffer()
    const out = await editImage(withFrame, { trim: {} })
    expect(out.width).toBe(40)
    expect(out.height).toBe(30)
  })

  it('rotates and mirrors', async () => {
    const out = await editImage(await solid(60, 20, '#334155'), { rotate: 90 })
    expect(out.width).toBe(20)
    expect(out.height).toBe(60)
  })

  it('desaturates down to gray', async () => {
    const out = await editImage(await solid(20, 20, '#c81e1e'), { saturation: 0 })
    const { r, g, b } = (await sharp(out.bytes).stats()).dominant
    expect(Math.abs(r - g)).toBeLessThan(6)
    expect(Math.abs(g - b)).toBeLessThan(6)
  })

  it('lightens and darkens through brightness', async () => {
    const base = await solid(20, 20, '#808080')
    const light = await editImage(base, { brightness: 1.5 })
    const dark = await editImage(base, { brightness: 0.5 })
    expect((await sharp(light.bytes).stats()).dominant.r).toBeGreaterThan(128)
    expect((await sharp(dark.bytes).stats()).dominant.r).toBeLessThan(128)
  })

  it('contrast pivots around mid gray, not black', async () => {
    // A medium gray is the fixed point: more contrast cannot lighten it.
    const out = await editImage(await solid(20, 20, '#808080'), { contrast: 2 })
    expect((await sharp(out.bytes).stats()).dominant.r).toBeGreaterThan(118)
    expect((await sharp(out.bytes).stats()).dominant.r).toBeLessThan(138)
  })

  it('converts format', async () => {
    const out = await editImage(await solid(30, 30, '#334155'), { format: 'jpeg', quality: 70 })
    expect(out.format).toBe('jpeg')
  })

  it('maxBytes reduces until it fits and accounts for what it did', async () => {
    // Noise compresses badly: it is what forces the search to go down the steps.
    const noise = Buffer.alloc(600 * 600 * 3)
    for (let i = 0; i < noise.length; i++) noise[i] = Math.floor(Math.random() * 256)
    const source = await sharp(noise, { raw: { width: 600, height: 600, channels: 3 } })
      .png()
      .toBuffer()

    const out = await editImage(source, { format: 'jpeg', maxBytes: 20_000 })
    expect(out.bytes.length).toBeLessThanOrEqual(20_000)
    expect(out.compression).toBeTruthy()
  })

  it('a generous maxBytes does not touch the quality', async () => {
    const out = await editImage(await solid(40, 40, '#334155'), {
      format: 'jpeg',
      maxBytes: 5_000_000,
    })
    expect(out.compression).toBeUndefined()
  })

  it('cutting the background without asking for a format delivers PNG, so the alpha is not lost', async () => {
    const out = await editImage(await subjectOnBackground('#ffffff'), { removeBackground: {} })
    expect(out.format).toBe('png')
    expect(out.backgroundColor).toBe('#ffffff')
    expect(out.backgroundRemoved).toBeGreaterThan(0.8)
  })

  it('cuts the background and resizes in the same pass', async () => {
    const out = await editImage(await subjectOnBackground('#ffffff'), {
      removeBackground: {},
      resize: { width: 30 },
    })
    expect(out.width).toBe(30)
    expect(await alphaAt(out.bytes, 1, 1)).toBe(0)
  })

  it('draws on the image without changing its size', async () => {
    const base = await solid(300, 200, '#334155')
    const out = await editImage(base, { text: [{ content: 'Legenda' }] })
    expect(out.width).toBe(300)
    expect(out.height).toBe(200)
    expect(Buffer.compare(out.bytes, base)).not.toBe(0)
  })

  it('long text wraps and stays INSIDE the photo', async () => {
    // The error nobody forgives in a finished image is the caption leaking
    // through the edge. The width per character varies almost four times depending on the
    // letters, so this only works by measuring the text for real.
    const base = await solid(400, 300, '#ffffff')
    const out = await editImage(base, {
      text: [
        {
          content:
            'WIDE UPPERCASE AND LONG WORDS THAT NEED TO WRAP ACROSS SEVERAL LINES TO FIT',
          position: 'top',
          color: '#000000',
          outline: null,
        },
      ],
    })

    // Bounding box of what was painted: everything that stopped being white.
    const { data, info } = await sharp(out.bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    let minX = info.width
    let maxX = -1
    // It counts BANDS of text (groups of painted lines separated by white), and
    // not pixel lines: the number of pixel lines depends on the height of the
    // letters, which changes with the font installed on the machine.
    let bands = 0
    let withinRange = false
    for (let y = 0; y < info.height; y++) {
      let paintedOnLine = false
      for (let x = 0; x < info.width; x++) {
        const at = (y * info.width + x) * 4
        if (data[at] < 200) {
          paintedOnLine = true
          if (x < minX) minX = x
          if (x > maxX) maxX = x
        }
      }
      if (paintedOnLine && !withinRange) bands++
      withinRange = paintedOnLine
    }
    expect(maxX).toBeGreaterThan(0) // painted something
    expect(minX).toBeGreaterThanOrEqual(0)
    expect(maxX).toBeLessThan(info.width)
    expect(bands).toBeGreaterThan(1) // broke into more than one line
  })

  it('each anchor puts the text in its corner', async () => {
    const base = await solid(400, 300, '#ffffff')
    const centerAt = async (position: 'top-left' | 'bottom-right') => {
      const out = await editImage(base, {
        text: [{ content: 'X', position, color: '#000000', outline: null, size: 40 }],
      })
      const { data, info } = await sharp(out.bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
      let sumX = 0
      let sumY = 0
      let n = 0
      for (let i = 0; i < info.width * info.height; i++) {
        if (data[i * 4] < 200) {
          sumX += i % info.width
          sumY += (i / info.width) | 0
          n++
        }
      }
      return { x: sumX / n, y: sumY / n }
    }
    const top = await centerAt('top-left')
    const bottom = await centerAt('bottom-right')
    expect(top.x).toBeLessThan(200)
    expect(top.y).toBeLessThan(150)
    expect(bottom.x).toBeGreaterThan(200)
    expect(bottom.y).toBeGreaterThan(150)
  })

  it('the outline comes with the fill', async () => {
    // Without an outline, the white caption vanishes on the first light background.
    const out = await editImage(await solid(300, 150, '#808080'), {
      text: [{ content: 'Outline', color: '#ffffff', outline: '#000000', size: 48 }],
    })
    const { data } = await sharp(out.bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    let whites = 0
    let blacks = 0
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] > 230 && data[i + 1] > 230) whites++
      if (data[i] < 30 && data[i + 1] < 30) blacks++
    }
    expect(whites).toBeGreaterThan(50)
    expect(blacks).toBeGreaterThan(50)
  })

  it('the text goes in AFTER the color — the caption does not turn gray with the photo', async () => {
    // The caption is an annotation, it is not part of the photo being adjusted.
    const out = await editImage(await solid(300, 150, '#334155'), {
      saturation: 0,
      text: [{ content: 'Color', color: '#ff0000', outline: null, size: 60 }],
    })
    const { data } = await sharp(out.bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    let reds = 0
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] > 180 && data[i + 1] < 90 && data[i + 2] < 90) reds++
    }
    expect(reds).toBeGreaterThan(30)
  })

  it('empty text does not change the image, and markup does not break the drawing', async () => {
    const base = await solid(200, 120, '#334155')
    const empty = await editImage(base, { text: [{ content: '   ' }] })
    expect(empty.width).toBe(200)

    // A dangling `<` would invalidate the SVG and bring the whole edit down.
    const marked = await editImage(base, {
      text: [{ content: 'if (a < b && c > d) "x"', size: 20 }],
    })
    expect(Buffer.compare(marked.bytes, base)).not.toBe(0)
  })

  it('several texts in the same pass', async () => {
    const out = await editImage(await solid(400, 300, '#ffffff'), {
      text: [
        { content: 'A', position: 'top-left', color: '#ff0000', outline: null, size: 40 },
        { content: 'B', position: 'bottom-right', color: '#0000ff', outline: null, size: 40 },
      ],
    })
    const { data } = await sharp(out.bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    let red = 0
    let blue = 0
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] > 180 && data[i + 2] < 90) red++
      if (data[i + 2] > 180 && data[i] < 90) blue++
    }
    expect(red).toBeGreaterThan(20)
    expect(blue).toBeGreaterThan(20)
  })

  it('flatten flattens the transparency over the requested color', async () => {
    const withoutBackground = await editImage(await subjectOnBackground('#ffffff'), { removeBackground: {} })
    const flattened = await editImage(withoutBackground.bytes, { flatten: '#000000', format: 'jpeg' })
    expect(await alphaAt(flattened.bytes, 1, 1)).toBe(255)
    const { data } = await sharp(flattened.bytes).raw().toBuffer({ resolveWithObject: true })
    expect(data[0]).toBeLessThan(20) // the corner turned black
  })
})
