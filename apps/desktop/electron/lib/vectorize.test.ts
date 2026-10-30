import sharp from 'sharp'
import { describe, expect, it } from 'vitest'

import { vectorizeImage } from './vectorize'
import { svgInfo } from './svg-ops'

/**
 * Vectorizing "works" far too easily: anything that returns a valid
 * `<svg>` passes as success. What decides whether it was worth it is the drawing
 * staying the same — so the central test here RASTERIZES THE RESULT
 * BACK and compares it with the source, pixel by pixel.
 */

async function solid(width: number, height: number, color: string): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: color } }).png().toBuffer()
}

/** Fraction of pixels that differ between two images of the same size. */
async function difference(a: Buffer, b: Buffer): Promise<number> {
  const [ra, rb] = await Promise.all([
    sharp(a).removeAlpha().raw().toBuffer({ resolveWithObject: true }),
    sharp(b).removeAlpha().raw().toBuffer({ resolveWithObject: true }),
  ])
  let diff = 0
  const total = ra.info.width * ra.info.height
  for (let i = 0; i < total; i++) {
    const at = i * ra.info.channels
    const d =
      Math.abs(ra.data[at] - rb.data[at]) +
      Math.abs(ra.data[at + 1] - rb.data[at + 1]) +
      Math.abs(ra.data[at + 2] - rb.data[at + 2])
    if (d > 90) diff++
  }
  return diff / total
}

/** Red square on white — the flat-logo case. */
async function makeMark(): Promise<Buffer> {
  return sharp({ create: { width: 120, height: 120, channels: 3, background: '#ffffff' } })
    .composite([{ input: await solid(60, 60, '#c81e1e'), top: 30, left: 30 }])
    .png()
    .toBuffer()
}

describe('vectorizeImage', () => {
  it('returns a valid SVG, with a viewBox', async () => {
    const out = await vectorizeImage(await makeMark())
    expect(out.svg).toMatch(/^<svg /)
    const info = svgInfo(out.svg)
    expect(info.viewBox).toBe('0 0 120 120')
    expect(out.paths).toBeGreaterThan(0)
  })

  it('the drawing SURVIVES the round trip', async () => {
    // The test that matters: vectorize, rasterize again at the same size and
    // check that it is the same image. A wrong tracing passes everything else.
    const source = await makeMark()
    const out = await vectorizeImage(source)
    const roundTrip = await sharp(Buffer.from(out.svg)).resize(120, 120).png().toBuffer()
    // Some difference is expected at the edge (the tracing walks along the pixel
    // border), but the drawing has to be the same.
    expect(await difference(source, roundTrip)).toBeLessThan(0.02)
  })

  it('recognizes the colors that exist in the drawing', async () => {
    const out = await vectorizeImage(await makeMark())
    // The red has to be among the traced colors, not an approximation
    // distant from it.
    const red = out.colors.find((c) => c.startsWith('#c') || c.startsWith('#b'))
    expect(red).toBeDefined()
  })

  it('HOLLOWS the middle of a ring instead of covering it', async () => {
    // The case that separates a correct tracer from a wrong one: the inner outline
    // has the opposite direction to the outer one, and it is the fill-rule that makes the hole exist.
    // Without it, the ring becomes a disc.
    const ring = await sharp({ create: { width: 100, height: 100, channels: 3, background: '#ffffff' } })
      .composite([
        { input: await solid(80, 80, '#000000'), top: 10, left: 10 },
        { input: await solid(40, 40, '#ffffff'), top: 30, left: 30 },
      ])
      .png()
      .toBuffer()

    const out = await vectorizeImage(ring)
    const roundTrip = await sharp(Buffer.from(out.svg)).resize(100, 100).png().toBuffer()
    const { data, info } = await sharp(roundTrip).removeAlpha().raw().toBuffer({ resolveWithObject: true })
    const at = (50 * info.width + 50) * info.channels
    // The center of the ring has to stay light.
    expect(data[at]).toBeGreaterThan(200)
  })

  it('dropBackground cuts the background instead of leaving a rectangle', async () => {
    const withBackground = await vectorizeImage(await makeMark())
    const withoutBackground = await vectorizeImage(await makeMark(), { dropBackground: true })
    expect(withoutBackground.paths).toBe(withBackground.paths - 1)
    expect(withoutBackground.colors).not.toContain('#ffffff')
  })

  it('scales without losing sharpness — the point of vectorizing', async () => {
    // 120 at the source, 600 at the output: in a raster that would be blur.
    const out = await vectorizeImage(await makeMark())
    const large = await sharp(Buffer.from(out.svg)).resize(600, 600).png().toBuffer()
    const { data, info } = await sharp(large).removeAlpha().raw().toBuffer({ resolveWithObject: true })
    // The transition from white to red happens in a few pixels: a
    // raster upscale would spread that over dozens.
    const line = 300
    let transitions = 0
    for (let x = 1; x < info.width; x++) {
      const a = (line * info.width + x - 1) * info.channels
      const b = (line * info.width + x) * info.channels
      if (Math.abs(data[a] - data[b]) > 40) transitions++
    }
    expect(transitions).toBeLessThanOrEqual(4)
  })

  it('simplifies: a straight edge does not become one point per pixel', async () => {
    const out = await vectorizeImage(await makeMark())
    // A square has 4 corners. Without simplification it would be ~240 points.
    expect(out.points).toBeLessThan(40)
  })

  it('warns when the result looks like a photograph', async () => {
    // Noise has no flat region at all: it is the worst case, and the report
    // has to say so instead of delivering silently.
    const noise = Buffer.alloc(300 * 300 * 3)
    for (let i = 0; i < noise.length; i++) noise[i] = Math.floor(Math.random() * 256)
    const photo = await sharp(noise, { raw: { width: 300, height: 300, channels: 3 } }).png().toBuffer()

    const out = await vectorizeImage(photo, { colors: 16 })
    expect(out.warnings.join(' ')).toMatch(/photograph/)
  })

  it('does NOT report anti-aliased art as a photograph', async () => {
    // Regression of a real false positive. A logo with softened edges gains
    // a mixture color in the quantization, and it forms one-pixel rings that
    // shatter into hundreds of blobs. Counting HEADS, the warning fired
    // on a perfect tracing; counting AREA, those crumbs are negligible.
    const softMark = await sharp(
      Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300">
           <rect width="300" height="300" fill="#ffffff"/>
           <circle cx="150" cy="150" r="110" fill="#1d4ed8"/>
           <circle cx="150" cy="150" r="66" fill="#ffffff"/>
           <circle cx="150" cy="150" r="22" fill="#dc2626"/>
         </svg>`,
      ),
    )
      .png()
      .toBuffer()

    const out = await vectorizeImage(softMark, { colors: 5 })
    expect(out.warnings.join(' ')).not.toMatch(/photograph|flat colors/)
    // And the drawing has to remain recognizable: the red core, the white
    // ring and the blue around it, each one in its place.
    const roundTrip = await sharp(Buffer.from(out.svg)).resize(300, 300).png().toBuffer()
    const { data, info } = await sharp(roundTrip).removeAlpha().raw().toBuffer({ resolveWithObject: true })
    const color = (x: number, y: number) => {
      const at = (y * info.width + x) * info.channels
      return [data[at], data[at + 1], data[at + 2]]
    }
    expect(color(150, 150)[0]).toBeGreaterThan(150) // red center
    expect(color(150, 60)[2]).toBeGreaterThan(150) // blue ring at the top
  })

  it('the SVG of flat art comes out SMALLER than the raster', async () => {
    // It is the concrete gain of vectorizing art: fewer bytes and infinite scaling.
    const source = await makeMark()
    const out = await vectorizeImage(source)
    expect(Buffer.byteLength(out.svg)).toBeLessThan(source.length)
  })

  it('removes the edge ink and PRESERVES a small accent', async () => {
    // The two halves of the same rule, and that is why they are in the same test.
    //
    // The mixture between two tones (the gray born between a dark stroke and a
    // light background) has to vanish: it is what draws the ghost outline. But
    // it is SMALL, and a legitimate brand accent is too — if the rule were
    // by size, the red dot would die along with it. What separates the two is the
    // mixture falling on the line that links the two colors it came from.
    const dark = '#1a2b4a'
    const light = '#f2f0ea'
    const middle = '#8a8d9a' // the average of the two: the edge ink
    const accent = '#e11d48' // red: outside the line between the other two

    const scene = await sharp({ create: { width: 200, height: 200, channels: 3, background: light } })
      .composite([
        { input: await solid(140, 140, dark), top: 30, left: 30 },
        { input: await solid(120, 120, light), top: 40, left: 40 },
        // Mixture frame following the stroke.
        { input: await solid(140, 3, middle), top: 28, left: 30 },
        { input: await solid(140, 3, middle), top: 170, left: 30 },
        // The accent, as small as the mixture.
        { input: await solid(18, 18, accent), top: 90, left: 90 },
      ])
      .png()
      .toBuffer()

    const out = await vectorizeImage(scene, { colors: 4 })
    const near = (hex: string, target: string, limit = 40) => {
      const p = (h: string, i: number) => parseInt(h.slice(1 + i * 2, 3 + i * 2), 16)
      return Math.hypot(p(hex, 0) - p(target, 0), p(hex, 1) - p(target, 1), p(hex, 2) - p(target, 2)) < limit
    }
    expect(out.colors.some((c) => near(c, accent))).toBe(true)
    expect(out.colors.some((c) => near(c, middle, 25))).toBe(false)
  })

  it('chooses by itself how many colors to use, and says which one it chose', async () => {
    const out = await vectorizeImage(await makeMark())
    expect(out.usedColors).toBeGreaterThanOrEqual(3)
    expect(out.usedColors).toBeLessThanOrEqual(6)
    // An explicit request is still honored to the letter.
    expect((await vectorizeImage(await makeMark(), { colors: 3 })).usedColors).toBe(3)
  })

  it('opens no seam between two neighboring colors', async () => {
    // Tracing each color with its own pixels, the boundary between two regions
    // is walked TWICE, one on each side, and the simplification pushes one
    // tracing away from the other — opening a thread of nothing between them. The layers are
    // stacked (each one carries what comes on top) so that there is no
    // shared boundary that could drift apart.
    //
    // The boundary has to be WAVY: on a straight line both tracings fall in the same
    // place and there is no divergence at all to open a gap.
    const twoColors = await sharp(
      Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200">
           <rect width="200" height="200" fill="#1d4ed8"/>
           <path d="M0 60 C 50 20, 90 120, 140 70 S 190 40, 200 80 L200 200 L0 200 Z" fill="#dc2626"/>
         </svg>`,
      ),
    )
      .png()
      .toBuffer()

    const out = await vectorizeImage(twoColors, { colors: 2 })
    // Composited OVER magenta: whatever shows that color is a hole in the tracing.
    const overMagenta = await sharp({
      create: { width: 200, height: 200, channels: 3, background: '#ff00ff' },
    })
      .composite([{ input: await sharp(Buffer.from(out.svg)).resize(200, 200).png().toBuffer() }])
      .png()
      .toBuffer()

    const { data, info } = await sharp(overMagenta)
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
    let leaking = 0
    // Only the CORE: the image's outer border has half a pixel of slack by
    // construction and is not a seam.
    for (let y = 4; y < info.height - 4; y++) {
      for (let x = 4; x < info.width - 4; x++) {
        const at = (y * info.width + x) * info.channels
        if (data[at] > 180 && data[at + 1] < 90 && data[at + 2] > 180) leaking++
      }
    }
    expect(leaking).toBe(0)
  })

  it('a large image is downscaled first, and says so', async () => {
    const large = await solid(2400, 1200, '#334155')
    const out = await vectorizeImage(large)
    expect(out.width).toBeLessThanOrEqual(1000)
    expect(out.warnings.join(' ')).toMatch(/downscaled/)
  })
})
