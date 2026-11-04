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

const { MAX_FRAME_TIMES, CLIP_SHARE, describeEvals, evalScript, describeProbe, probeScript, describeFrameContent, frameLabel, framesFromTimes, renderFrameSheet, sheetCell, sheetColumns, sheetFileName, sheetLayout } =
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

describe('describeFrameContent', () => {
  const size = { width: 1080, height: 1920 }

  it('says plainly when a frame has no visible text, and how many blocks are hidden', () => {
    const line = describeFrameContent('0.50s · f15', { texts: [], hiddenTexts: 40, media: 1 }, size)
    expect(line).toBe('0.50s · f15: NO visible text — 1 image/video/canvas/svg visible; 40 text block(s) on the page are invisible here.')
  })

  it('words animated one by one read as one line', () => {
    const word = (text: string, x: number, width: number) => ({ text, x, y: 918, width, height: 62, opacity: 1 })
    const line = describeFrameContent('1.00s · f30', { texts: [word('gonna', 363, 139), word("Love's", 219, 143), word('get', 502, 73)], hiddenTexts: 0, media: 0 }, size)
    expect(line).toContain('"Love\'s gonna get" (middle-center, 356x62px)')
  })

  it('lists each text with its zone, size, faintness and framing', () => {
    const line = describeFrameContent(
      '2.00s · f60',
      {
        texts: [
          { text: 'PRIDE.', x: 340, y: 100, width: 400, height: 120, opacity: 1 },
          { text: 'Love\'s gonna get you', x: 900, y: 1500, width: 400, height: 60, opacity: 0.4 },
        ],
        hiddenTexts: 0,
        media: 0,
      },
      size,
    )
    expect(line).toContain('"PRIDE." (top-center, 400x120px)')
    expect(line).toContain('(bottom-right, 400x60px, opacity 0.4, partly off-frame)')
    expect(line).toContain('no image/video/canvas/svg visible')
  })
})

describe('probe', () => {
  it('builds a script that is valid JavaScript and carries the selectors as data', () => {
    const code = probeScript(['.w3', '[data-layer="title"]', 'a"b'])
    expect(() => new Function(code)).not.toThrow()
    expect(code).toContain('".w3"')
    expect(code).toContain('[data-layer=\\"title\\"]')
  })

  it('says opacity, scale, move and where the box is, per selector', () => {
    const text = describeProbe('1:17.25 (f2317)', [
      {
        selector: '.w3',
        count: 1,
        matches: [{ label: 'w3', opacity: 0.18, scale: 0.96, rotate: 0, x: 0, y: 24, z: 0, box: { x: 120, y: 640, width: 540, height: 96 }, frame: 'in' }],
      },
      { selector: '.gone', count: 0, matches: [] },
      { selector: '.bad[', count: 0, matches: [], error: 'not a valid selector' },
      {
        selector: '.fan',
        count: 6,
        matches: [
          { label: 'fan[0]', opacity: 0, scale: 1, rotate: 0, x: 0, y: 0, z: 0, box: { x: 0, y: 0, width: 0, height: 0 }, frame: 'hidden' },
          { label: 'fan[1]', opacity: 1, scale: 1.2, rotate: 4, x: 10, y: -5, z: 620, box: { x: -30, y: 10, width: 400, height: 90 }, frame: 'partly', filter: 'blur(3px)' },
        ],
      },
    ])
    expect(text).toContain('1:17.25 (f2317) probe:')
    expect(text).toContain('.w3 ×1: w3: opacity 0.18 · scale 0.96 · move 0, 24 · box 120,640 540x96 · inside the frame')
    expect(text).toContain('.gone: no element matches')
    expect(text).toContain('invalid selector (not a valid selector)')
    expect(text).toContain('fan[0]: not visible (opacity 0)')
    expect(text).toContain('rotate 4° · blur(3px)')
    expect(text).toContain('z 620')
    expect(text).toContain('PARTLY off-frame')
    expect(text).toContain('(+4 more)')
  })
})

describe('clipShare (overflow clipping, page script on a fake DOM)', () => {
  type Box = { left: number; top: number; right: number; bottom: number; width: number; height: number }
  type Node = { nodeType: 1; parentElement: Node | null; rect: Box; css: Record<string, string>; getBoundingClientRect(): Box }
  const box = (left: number, top: number, width: number, height: number): Box => ({ left, top, width, height, right: left + width, bottom: top + height })
  const node = (rect: Box, css: Record<string, string> = {}, parent: Node | null = null): Node => ({
    nodeType: 1,
    parentElement: parent,
    rect,
    css: { position: 'static', overflowX: 'visible', overflowY: 'visible', ...css },
    getBoundingClientRect() {
      return this.rect
    },
  })
  const clipShare = new Function('getComputedStyle', `${CLIP_SHARE}; return clipShare`)((n: Node) => n.css) as (el: Node, r: Box) => number

  it('is 1 when nothing clips, and 0 for a line a box that shows two lines cuts away', () => {
    const free = node(box(0, 0, 100, 20), {}, node(box(0, 0, 500, 500)))
    expect(clipShare(free, free.rect)).toBe(1)
    // a 2-line window (y 100..180); lines of 40 px stacked from y 100
    const window = node(box(0, 100, 300, 80), { overflowY: 'hidden' })
    const lines = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => node(box(0, 100 + i * 40, 300, 40), {}, window))
    expect(lines.map((l) => clipShare(l, l.rect))).toEqual([1, 1, 0, 0, 0, 0, 0, 0])
  })

  it('reports the share left when a line is cut in half', () => {
    const window = node(box(0, 100, 300, 80), { overflowY: 'hidden' })
    const half = node(box(0, 160, 300, 40), {}, window)
    expect(clipShare(half, half.rect)).toBe(0.5)
  })

  it('an overflow:visible parent does not clip, and an absolutely positioned child escapes a static clipper', () => {
    const clipper = node(box(0, 0, 100, 100), { overflowX: 'hidden', overflowY: 'hidden' })
    const out = node(box(200, 200, 50, 50), { position: 'absolute' }, clipper)
    expect(clipShare(out, out.rect)).toBe(1)
    // …but a positioned clipper IS its containing block, so it cuts the child
    clipper.css.position = 'relative'
    expect(clipShare(out, out.rect)).toBe(0)
  })
})

describe('what a frame shows when a parent clips', () => {
  it('says how much of a line is visible and how many blocks the clip cut away', () => {
    const text = describeFrameContent(
      '0:01',
      { texts: [{ text: 'half line', x: 0, y: 0, width: 200, height: 40, opacity: 1, visible: 0.5 }], hiddenTexts: 6, clippedTexts: 6, media: 0 },
      { width: 1080, height: 1920 },
    )
    expect(text).toContain('only 50% visible (clipped by a parent)')
    expect(text).toContain('6 text block(s) on the page are invisible here (6 of them cut away by a parent with overflow hidden)')
  })
  it('the probe calls an element clipped away by name', () => {
    const text = describeProbe('0:01', [
      { selector: '.line', count: 1, matches: [{ label: 'line[3]', opacity: 1, scale: 1, rotate: 0, x: 0, y: 0, z: 0, box: { x: 0, y: 400, width: 300, height: 40 }, frame: 'clipped' }] },
    ])
    expect(text).toContain('CLIPPED AWAY by a parent with overflow hidden')
  })
})

describe('evaluate (expressions read from the page)', () => {
  const run = (expr: string, globals: Record<string, unknown> = {}) =>
    new Function(...Object.keys(globals), `return ${evalScript(expr)}`)(...Object.values(globals)) as { ok: boolean; value?: string; error?: string }

  it('reads numbers, booleans, strings, undefined and objects as text', () => {
    expect(run('1 + 2')).toEqual({ ok: true, value: '3' })
    expect(run('p.on', { p: { on: undefined } })).toEqual({ ok: true, value: 'undefined' })
    expect(run('p.on', { p: { on: true } })).toEqual({ ok: true, value: 'true' })
    expect(run('"oi"')).toEqual({ ok: true, value: '"oi"' })
    expect(run('xs', { xs: [1, { a: 2 }] })).toEqual({ ok: true, value: '[1,{"a":2}]' })
    expect(run('f', { f: function pulse() {} })).toEqual({ ok: true, value: 'function pulse' })
  })

  it('says what an element is, and cuts a long value short', () => {
    expect(run('el', { el: { nodeType: 1, tagName: 'DIV', id: 'title', className: 'big hero' } }).value).toBe('<div#title.big>')
    const long = run('"x".repeat(900)').value!
    expect(long.length).toBeLessThan(260)
  })

  it('reports a thrown error instead of failing, with its name', () => {
    expect(run('missing.thing')).toMatchObject({ ok: false, error: expect.stringContaining('ReferenceError') })
    expect(run('null.x')).toMatchObject({ ok: false, error: expect.stringContaining('TypeError') })
  })

  it('does not hand the expression to eval: it is part of the script', () => {
    expect(evalScript('a + b')).not.toMatch(/\beval\b|new Function/)
  })

  it('groups one line per expression with the value at every instant', () => {
    const text = describeEvals([
      { label: '1:17.25', readings: [{ expr: 'p.on', ok: true, value: 'undefined' }, { expr: 'n', ok: true, value: '4' }] },
      { label: '1:20', readings: [{ expr: 'p.on', ok: false, error: 'ReferenceError: p is not defined' }, { expr: 'n', ok: true, value: '5' }] },
    ])
    expect(text).toContain('p.on: 1:17.25 → undefined · 1:20 → ERROR ReferenceError: p is not defined')
    expect(text).toContain('only globals are visible')
    expect(text).toContain('n: 1:17.25 → 4 · 1:20 → 5')
    expect(text.split('\n').filter((l) => l.includes('only globals'))).toHaveLength(1)
  })
})
