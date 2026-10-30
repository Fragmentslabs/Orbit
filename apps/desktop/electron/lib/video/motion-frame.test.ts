import { describe, expect, it, vi } from 'vitest'

// The module opens a window to capture (it is from the main) and registers the composition in
// motion-store, which touches `app`/`protocol`. No test here opens a window: only the
// pure parts and the sheet assembly (canvas, no Electron) are exercised.
vi.mock('electron', async () => {
  const nodePath = await import('node:path')
  const nodeOs = await import('node:os')
  return {
    app: { getPath: () => nodePath.join(nodeOs.tmpdir(), `orbit-motion-frame-test-${process.pid}`) },
    BrowserWindow: { getAllWindows: () => [] },
    protocol: { handle: () => {} },
  }
})

const { MAX_FRAME_TIMES, frameLabel, framesFromTimes, renderFrameSheet, sheetCell, sheetColumns, sheetFileName, sheetLayout } =
  await import('./motion-frame')

/** A fake "frame": any PNG works, the sheet only draws. */
async function shot(): Promise<Buffer> {
  const { createCanvas } = await import('@napi-rs/canvas')
  const canvas = createCanvas(320, 180)
  const g = canvas.getContext('2d')
  g.fillStyle = '#204060'
  g.fillRect(0, 0, 320, 180)
  return canvas.toBuffer('image/png')
}

describe('time → frame conversion', () => {
  it('converts seconds at the composition fps, to the nearest frame', () => {
    expect(framesFromTimes([0.5, 1, 2.4], { fps: 30 })).toEqual([15, 30, 72])
    expect(framesFromTimes([0.5, 1], { fps: 60 })).toEqual([30, 60])
    expect(framesFromTimes([1 / 30], { fps: 30 })).toEqual([1])
    // The guide case: a word said at 2.4 s in a 30 fps overlay = frame 72.
    expect(framesFromTimes([2.4], { fps: 30 })[0]).toBe(72)
  })

  it('rounds to the nearest frame and preserves the requested order', () => {
    // 2.41 s at 30 fps falls on frame 72 (2.40 s) — the label shows the REQUESTED time.
    expect(framesFromTimes([2.41], { fps: 30 })).toEqual([72])
    expect(frameLabel(2410, 72)).toBe('2.41s · f72')
    expect(framesFromTimes([2, 0.5, 2], { fps: 30 })).toEqual([60, 15, 60])
  })

  it('pins the clip end on the last frame', () => {
    // 4 s at 30 fps = 120 frames (0…119): the exact end is the LAST frame.
    expect(framesFromTimes([4], { fps: 30, durationInFrames: 120 })).toEqual([119])
    expect(framesFromTimes([3.999], { fps: 30, durationInFrames: 120 })).toEqual([119])
    // A one-frame clip: no valid instant escapes it (the maximum is
    // 1/30 s, and frame 1 it would round to is clamped to the last one, 0).
    expect(framesFromTimes([0.02], { fps: 30, durationInFrames: 1 })).toEqual([0])
    expect(() => framesFromTimes([1], { fps: 30, durationInFrames: 1 })).toThrow(/past the end/)
  })
})

describe('instant validation', () => {
  it('refuses an empty list, above the ceiling, zero, negative and non-number', () => {
    expect(() => framesFromTimes([], { fps: 30 })).toThrow(/at least one instant/)
    const tooMany = Array.from({ length: MAX_FRAME_TIMES + 1 }, (_, i) => (i + 1) / 30)
    expect(() => framesFromTimes(tooMany, { fps: 30 })).toThrow(new RegExp(`at most ${MAX_FRAME_TIMES}`))
    expect(() => framesFromTimes([0], { fps: 30 })).toThrow(/invalid instant/)
    expect(() => framesFromTimes([-1], { fps: 30 })).toThrow(/invalid instant/)
    expect(() => framesFromTimes([Number.NaN], { fps: 30 })).toThrow(/invalid instant/)
    expect(() => framesFromTimes([Number.POSITIVE_INFINITY], { fps: 30 })).toThrow(/invalid instant/)
    // The ceiling itself is accepted.
    expect(framesFromTimes(tooMany.slice(0, MAX_FRAME_TIMES), { fps: 30 })).toHaveLength(MAX_FRAME_TIMES)
  })

  it('refuses an instant beyond the composition end, citing the maximum', () => {
    expect(() => framesFromTimes([4.5], { fps: 30, durationInFrames: 120 })).toThrow(/past the end of the composition \(4\.00s max/)
    // Inside the clip it passes; with no known duration, nothing is refused for time.
    expect(framesFromTimes([3.5], { fps: 30, durationInFrames: 120 })).toEqual([105])
    expect(framesFromTimes([100], { fps: 30 })).toEqual([3000])
  })

  it('refuses an invalid fps', () => {
    expect(() => framesFromTimes([1], { fps: 0 })).toThrow(/invalid fps/)
    expect(() => framesFromTimes([1], { fps: Number.NaN })).toThrow(/invalid fps/)
  })
})

describe('sheet geometry', () => {
  it('picks the columns by the number of instants', () => {
    expect(sheetColumns(1)).toBe(1)
    expect(sheetColumns(2)).toBe(2)
    expect(sheetColumns(4)).toBe(2)
    expect(sheetColumns(5)).toBe(4)
    expect(sheetColumns(MAX_FRAME_TIMES)).toBe(4)
  })

  it('fits the width and grows with the rows', () => {
    const one = sheetLayout({ count: 1, width: 1600, aspect: 16 / 9 })
    const two = sheetLayout({ count: 2, width: 1600, aspect: 16 / 9 })
    const five = sheetLayout({ count: 5, width: 1600, aspect: 16 / 9 })
    expect(one.columns).toBe(1)
    expect(two.rows).toBe(1)
    expect(five.rows).toBe(2)
    // Same sheet width: the cell shrinks when one more column enters, and
    // the sheet gets taller when one more row enters.
    expect(one.cellWidth).toBeGreaterThan(two.cellWidth)
    expect(two.height).toBeLessThan(five.height)
    // With no declared width, the sheet has video_timeline's default width.
    expect(sheetLayout({ count: 2 }).width).toBe(1600)
    // An invalid aspect falls back to 16:9.
    expect(sheetLayout({ count: 1, aspect: 0 }).cellHeight).toBeCloseTo(sheetLayout({ count: 1, aspect: 16 / 9 }).cellHeight, 5)
    // A degenerate count does not generate a zero-cell sheet.
    expect(sheetLayout({ count: 0 }).rows).toBe(1)
    expect(sheetLayout({ count: 0 }).columns).toBe(1)
  })

  it('puts each cell inside the sheet, without overlap', () => {
    const geometry = sheetLayout({ count: 5, width: 1600, aspect: 16 / 9 })
    const cells = Array.from({ length: 5 }, (_, i) => sheetCell(geometry, i))
    for (const cell of cells) {
      expect(cell.x).toBeGreaterThanOrEqual(geometry.pad)
      expect(cell.x + cell.width).toBeLessThanOrEqual(geometry.width - geometry.pad + 1)
      expect(cell.y).toBeGreaterThanOrEqual(geometry.pad + geometry.header - 1)
      expect(cell.y + cell.height).toBeLessThanOrEqual(geometry.height - geometry.pad + 1)
    }
    // The second column sits to the right of the first; the second row, below.
    expect(cells[1].x).toBeGreaterThan(cells[0].x + cells[0].width)
    expect(cells[4].y).toBeGreaterThan(cells[0].y + cells[0].height)
    // The first four instants share the top row.
    expect(cells[3].y).toBe(cells[0].y)
  })

  it('lays the instant ceiling out in two rows of four', () => {
    const geometry = sheetLayout({ count: MAX_FRAME_TIMES, width: 1600, aspect: 16 / 9 })
    expect(geometry.columns).toBe(4)
    expect(geometry.rows).toBe(2)
    const cells = Array.from({ length: MAX_FRAME_TIMES }, (_, i) => sheetCell(geometry, i))
    // The fifth cell opens the bottom row, aligned with the first.
    expect(cells[4].y).toBeGreaterThan(cells[3].y)
    expect(cells[4].x).toBe(cells[0].x)
    // No cell escapes the sheet.
    for (const cell of cells) {
      expect(cell.x + cell.width).toBeLessThanOrEqual(geometry.width)
      expect(cell.y + cell.height).toBeLessThanOrEqual(geometry.height)
    }
  })

  it('names the sheet from the composition folder', () => {
    expect(sheetFileName('title')).toBe('title.webp')
    expect(sheetFileName('lower third')).toBe('lower-third.webp')
    expect(sheetFileName('')).toBe('motion.webp')
    expect(sheetFileName('../../etc')).toBe('etc.webp')
    // Repeated separators become one, and nothing starts/ends with a dot or a hyphen.
    expect(sheetFileName('aaa   bbb')).toBe('aaa-bbb.webp')
    expect(sheetFileName('..')).toBe('motion.webp')
    expect(sheetFileName('shot.')).toBe('shot.webp')
  })

  it('labels the cell with the time and the frame', () => {
    expect(frameLabel(2400, 72)).toBe('2.40s · f72')
    expect(frameLabel(500, 15)).toBe('0.50s · f15')
  })
})

describe('sheet assembly (canvas, no Electron)', () => {
  it('draws a webp with the grid size', async () => {
    const png = await shot()
    const shots = [
      { png, timeMs: 0, frame: 0 },
      { png, timeMs: 1200, frame: 36 },
      { png, timeMs: 2400, frame: 72 },
    ]
    const image = await renderFrameSheet({ title: 'title', fps: 30, durationInFrames: 120, shots })
    expect(image.subarray(0, 4).toString()).toBe('RIFF')
    expect(image.subarray(8, 12).toString()).toBe('WEBP')
    const { loadImage } = await import('@napi-rs/canvas')
    const decoded = await loadImage(image)
    const geometry = sheetLayout({ count: shots.length, aspect: 320 / 180 })
    expect(decoded.width).toBe(geometry.width)
    expect(decoded.height).toBe(geometry.height)
  })

  it('a single cell fills the whole sheet', async () => {
    const png = await shot()
    const image = await renderFrameSheet({ title: 'title', fps: 30, shots: [{ png, timeMs: 1000, frame: 30 }] })
    const { loadImage } = await import('@napi-rs/canvas')
    const decoded = await loadImage(image)
    const geometry = sheetLayout({ count: 1, aspect: 320 / 180 })
    expect(decoded.width).toBe(geometry.width)
    expect(decoded.height).toBe(geometry.height)
  })

  it('with no frame at all, it is an error (never an empty sheet)', async () => {
    await expect(renderFrameSheet({ title: 'title', fps: 30, shots: [] })).rejects.toThrow(/no frames/)
  })
})
