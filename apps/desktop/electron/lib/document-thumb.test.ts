import sharp from 'sharp'
import { describe, expect, it } from 'vitest'

import { pageThumb, textThumb, THUMB_HEIGHT, THUMB_WIDTH } from './document-thumb'

/**
 * The thumbnail is decoration, so what these tests protect is not the looks —
 * it is that it never brings the sources list down and never comes out blank pretending
 * to be a cover.
 */

/**
 * Pixels with ink in the MIDDLE of the sheet — the frame stays out.
 *
 * It measures this way, and not "dark pixels", because the cover has two possible
 * drawings: the text (dark) when the font resolves and the bars (light gray)
 * when it does not. Counting only the dark ones would take the sheet for empty on a machine
 * without an installed font, which is a legitimate environment and not a failure.
 */
async function inkPixels(webp: Buffer): Promise<number> {
  const margin = 3
  const { data } = await sharp(webp)
    .extract({
      left: margin,
      top: margin,
      width: THUMB_WIDTH - margin * 2,
      height: THUMB_HEIGHT - margin * 2,
    })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true })
  let ink = 0
  for (let i = 0; i < data.length; i++) if (data[i] < 240) ink++
  return ink
}

describe('textThumb', () => {
  it('draws a sheet at the agreed size', async () => {
    const thumb = await textThumb('Service agreement\nClause four — on the term')
    expect(thumb).not.toBeNull()
    const meta = await sharp(thumb!).metadata()
    expect(meta.format).toBe('webp')
    expect(meta.width).toBe(THUMB_WIDTH)
    expect(meta.height).toBe(THUMB_HEIGHT)
  })

  it('the sheet comes out with content, and not blank', async () => {
    const thumb = await textThumb('First line of the document\nSecond line of the document')
    // The frame is out of the count, so any ink here is content.
    expect(await inkPixels(thumb!)).toBeGreaterThan(100)
  })

  it('two different texts generate different covers — that is the point of existing', async () => {
    const a = await textThumb('Minutes of the March 12 meeting, agenda and follow-ups')
    const b = await textThumb('Shopping list: coffee, sugar, flour')
    expect(Buffer.compare(a!, b!)).not.toBe(0)
  })

  it('empty text or only spaces does not become a cover (the row keeps the icon)', async () => {
    expect(await textThumb('')).toBeNull()
    expect(await textThumb('   \n\n  \t ')).toBeNull()
  })

  it('a markup character in the text does not break the SVG', async () => {
    // A loose `<` would invalidate the XML and sharp would refuse the whole image.
    const thumb = await textThumb('if (a < b && c > d) { return "x" }\nsecond line')
    expect(thumb).not.toBeNull()
    expect(await inkPixels(thumb!)).toBeGreaterThan(100)
  })

  it('a very long line does not leak out of the sheet', async () => {
    // If the line were not cut, the SVG would render text outside the frame —
    // the size stays the same, so what is verified is that it did not fail.
    const thumb = await textThumb('x'.repeat(4000))
    const meta = await sharp(thumb!).metadata()
    expect(meta.width).toBe(THUMB_WIDTH)
  })

  it('a double-spaced document uses the whole sheet', async () => {
    // Blank lines skipped: otherwise half of the cover would be empty.
    const spaced = Array.from({ length: 12 }, (_, i) => `line ${i}\n`).join('\n')
    const compact = Array.from({ length: 12 }, (_, i) => `line ${i}`).join('\n')
    expect(await inkPixels((await textThumb(spaced))!)).toBe(
      await inkPixels((await textThumb(compact))!),
    )
  })
})

describe('pageThumb', () => {
  it('fits the page in the frame without cropping the top', async () => {
    // A "tall" page with a black band at the top: with `cover` it would be cropped.
    const page = await sharp({
      create: { width: 600, height: 900, channels: 3, background: '#ffffff' },
    })
      .composite([
        {
          input: await sharp({
            create: { width: 600, height: 60, channels: 3, background: '#000000' },
          })
            .png()
            .toBuffer(),
          top: 0,
          left: 0,
        },
      ])
      .png()
      .toBuffer()

    const thumb = await pageThumb(page)
    const meta = await sharp(thumb!).metadata()
    expect(meta.width).toBe(THUMB_WIDTH)
    expect(meta.height).toBe(THUMB_HEIGHT)
    expect(await inkPixels(thumb!)).toBeGreaterThan(400)
  })

  it('bytes that are not an image return null instead of blowing up', async () => {
    expect(await pageThumb(Buffer.from('not even close to a png'))).toBeNull()
  })
})
