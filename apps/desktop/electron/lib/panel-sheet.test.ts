import { describe, expect, it } from 'vitest'
import { createCanvas } from '@napi-rs/canvas'
import {
  MAX_FRAMES,
  composeSheet,
  dataUrlsToBuffers,
  describeSheet,
  planSheets,
  sampleTimes,
  seekScript,
  timeLabel,
  videoCaptureScript,
  videoProbeScript,
} from './panel-sheet'

function jpeg(color: string, w = 64, h = 36): Buffer {
  const c = createCanvas(w, h)
  const g = c.getContext('2d')
  g.fillStyle = color
  g.fillRect(0, 0, w, h)
  return c.toBuffer('image/jpeg')
}

describe('sampleTimes', () => {
  it('steps from..to inclusive and rounds to the millisecond', () => {
    expect(sampleTimes({ from: 0, to: 1, step: 0.25 })).toEqual([0, 0.25, 0.5, 0.75, 1])
    expect(sampleTimes({ from: 0.1, to: 0.4, step: 0.1 })).toEqual([0.1, 0.2, 0.3, 0.4])
  })
  it('count spreads evenly, both ends included, and wins over step', () => {
    expect(sampleTimes({ from: 2, to: 6, count: 5, step: 99 })).toEqual([2, 3, 4, 5, 6])
    expect(sampleTimes({ from: 3, to: 9, count: 1 })).toEqual([3])
  })
  it('defaults to the whole duration with about 24 frames', () => {
    const t = sampleTimes({ duration: 13.7 })
    expect(t[0]).toBe(0)
    expect(t.length).toBeGreaterThanOrEqual(24)
    expect(t.length).toBeLessThanOrEqual(25)
    expect(t[t.length - 1]).toBeLessThanOrEqual(13.7)
  })
  it('explains what is wrong', () => {
    expect(() => sampleTimes({})).toThrow(/give `to`/)
    expect(() => sampleTimes({ from: 5, to: 2 })).toThrow(/after/)
    expect(() => sampleTimes({ from: 0, to: 10, step: 0 })).toThrow(/step/)
    expect(() => sampleTimes({ from: 0, to: 100, step: 0.1 })).toThrow(new RegExp(`max ${MAX_FRAMES}`))
  })
})

describe('planSheets / timeLabel / describeSheet', () => {
  it('splits into sheets of at most perSheet frames', () => {
    const plan = planSheets(Array.from({ length: 50 }, (_, i) => i), 24)
    expect(plan.map((p) => p.length)).toEqual([24, 24, 2])
    expect(planSheets([1, 2, 3], 0)).toHaveLength(3)
  })
  it('labels in seconds with two decimals', () => {
    expect(timeLabel(3.2)).toBe('3.20s')
  })
  it('says how to read the sheet', () => {
    const text = describeSheet({ index: 2, total: 3, times: [4.8, 5, 5.2, 5.4], cols: 4, rows: 1, media: 'orbit-media://img_x.webp' })
    expect(text).toContain('Sheet 2/3: 4 frames, 4.80s–5.40s (every ~0.20 s)')
    expect(text).toContain('left to right, top to bottom')
    expect(text).toContain('orbit-media://img_x.webp')
  })
})

describe('composeSheet', () => {
  it('lays the frames in a grid sized from the tile, columns and aspect ratio', async () => {
    const frames = [jpeg('#f00'), jpeg('#0f0'), jpeg('#00f'), jpeg('#ff0'), jpeg('#0ff')]
    const sheet = await composeSheet(frames, ['0.00s', '0.20s', '0.40s', '0.60s', '0.80s'], { cols: 3, tile: 160 })
    expect([sheet.cols, sheet.rows]).toEqual([3, 2])
    // 16:9 tiles of 160 px → 90 px high; 3 columns and 2 rows with a 4 px gap around each
    expect(sheet.width).toBe(3 * 160 + 4 * 4)
    expect(sheet.height).toBe(2 * 90 + 3 * 4)
    expect(sheet.format).toBe('webp')
    expect(sheet.buffer.subarray(8, 12).toString('ascii')).toBe('WEBP')
  })

  it('never uses more columns than frames', async () => {
    const sheet = await composeSheet([jpeg('#f00'), jpeg('#0f0')], ['a', 'b'], { cols: 8, tile: 120 })
    expect(sheet.cols).toBe(2)
    expect(sheet.rows).toBe(1)
  })

  it('keeps the file under the byte limit when it can', async () => {
    const noisy = createCanvas(320, 180)
    const g = noisy.getContext('2d')
    for (let i = 0; i < 4000; i++) {
      g.fillStyle = `rgb(${(i * 37) % 256},${(i * 91) % 256},${(i * 53) % 256})`
      g.fillRect((i * 17) % 320, (i * 29) % 180, 6, 6)
    }
    const frame = noisy.toBuffer('image/jpeg')
    const free = await composeSheet(Array(12).fill(frame), Array(12).fill('t'), { cols: 4, tile: 240, maxBytes: 10_000_000 })
    const tight = await composeSheet(Array(12).fill(frame), Array(12).fill('t'), { cols: 4, tile: 240, maxBytes: 40_000 })
    expect(tight.buffer.length).toBeLessThan(free.buffer.length)
  })

  it('refuses an empty list', async () => {
    await expect(composeSheet([], [])).rejects.toThrow(/no frames/)
  })
})

describe('dataUrlsToBuffers', () => {
  it('decodes image data urls and rejects anything else', () => {
    const buf = jpeg('#abc')
    const [out] = dataUrlsToBuffers([`data:image/jpeg;base64,${buf.toString('base64')}`])
    expect(out.equals(buf)).toBe(true)
    expect(() => dataUrlsToBuffers(['data:text/html;base64,AAAA'])).toThrow(/frame 1/)
  })
})

// ---- the page scripts, against a fake DOM ------------------------------------------------------

type FakeVideo = ReturnType<typeof makeVideo>
function makeVideo(o: { id?: string; area?: [number, number]; duration?: number; paused?: boolean; at?: number; taint?: boolean } = {}) {
  const listeners: Record<string, Array<() => void>> = {}
  let time = o.at ?? 0
  const log: string[] = []
  const v = {
    id: o.id ?? 'v',
    tagName: 'VIDEO',
    readyState: 4,
    duration: o.duration ?? 13.74,
    videoWidth: 720,
    videoHeight: 720,
    paused: o.paused ?? false,
    currentSrc: 'blob:https://example.test/abc',
    log,
    seeks: [] as number[],
    get currentTime() {
      return time
    },
    set currentTime(t: number) {
      time = t
      v.seeks.push(t)
      setTimeout(() => (listeners.seeked ?? []).slice().forEach((fn) => fn()), 0)
    },
    pause() {
      v.paused = true
      log.push('pause')
    },
    play() {
      v.paused = false
      log.push('play')
    },
    addEventListener(type: string, fn: () => void) {
      ;(listeners[type] ??= []).push(fn)
    },
    removeEventListener(type: string, fn: () => void) {
      listeners[type] = (listeners[type] ?? []).filter((f) => f !== fn)
    },
    getBoundingClientRect() {
      const [w, h] = o.area ?? [400, 400]
      return { left: 0, top: 0, right: w, bottom: h }
    },
    taint: o.taint ?? false,
  }
  return v
}

async function runPage(script: string, videos: FakeVideo[]): Promise<Record<string, unknown>> {
  const drawn: number[] = []
  const document = {
    querySelectorAll: (sel: string) => (sel === 'video' ? videos : []),
    querySelector: (sel: string) => videos.find((v) => `#${v.id}` === sel) ?? null,
    createElement: () => {
      let current: FakeVideo | null = null
      return {
        width: 0,
        height: 0,
        getContext: () => ({
          drawImage: (v: FakeVideo) => {
            if (v.taint) throw new Error('Failed to execute toDataURL: Tainted canvases may not be exported.')
            current = v
            drawn.push(v.currentTime)
          },
        }),
        toDataURL: () => `data:image/jpeg;base64,${Buffer.from(String(current?.currentTime)).toString('base64')}`,
      }
    },
  }
  const fn = new Function('document', 'innerWidth', 'innerHeight', `return ${script}`)
  return (await fn(document, 1000, 800)) as Record<string, unknown>
}

describe('videoProbeScript', () => {
  it('finds the largest video on screen and reports duration and state', async () => {
    const small = makeVideo({ id: 'small', area: [100, 100], duration: 5 })
    const big = makeVideo({ id: 'big', area: [600, 500], duration: 13.74, paused: true })
    const out = await runPage(videoProbeScript(), [small, big])
    expect(out).toMatchObject({ found: true, duration: 13.74, width: 720, paused: true, src: 'blob', videos: 2 })
  })
  it('honours a selector and says when there is no video', async () => {
    const a = makeVideo({ id: 'a', duration: 3 })
    const b = makeVideo({ id: 'b', duration: 9 })
    expect(await runPage(videoProbeScript('#a'), [a, b])).toMatchObject({ duration: 3 })
    expect(await runPage(videoProbeScript(), [])).toEqual({ found: false, videos: 0 })
  })
})

describe('videoCaptureScript', () => {
  it('seeks to each time, returns one frame per time, and leaves the video as it was', async () => {
    const v = makeVideo({ paused: false, at: 7.5 })
    const out = (await runPage(videoCaptureScript({ times: [0, 0.2, 0.4], tile: 240 }), [v])) as { frames: string[]; actual: number[]; duration: number }
    expect(out.frames).toHaveLength(3)
    expect(out.actual).toEqual([0, 0.2, 0.4])
    expect(out.duration).toBe(13.74)
    expect(v.currentTime).toBe(7.5) // put back where it was…
    expect(v.log).toEqual(['pause', 'play']) // …and playing again
  })

  it('does not restart a video that was paused', async () => {
    const v = makeVideo({ paused: true })
    await runPage(videoCaptureScript({ times: [1], tile: 240 }), [v])
    expect(v.log).toEqual(['pause'])
  })

  it('never seeks past the end', async () => {
    const v = makeVideo({ duration: 10 })
    await runPage(videoCaptureScript({ times: [99], tile: 240 }), [v])
    expect(Math.max(...v.seeks)).toBeLessThan(10)
  })

  it('says "tainted" when the page does not let the frame out, and still restores the video', async () => {
    const v = makeVideo({ taint: true, at: 3, paused: false })
    const out = await runPage(videoCaptureScript({ times: [0, 1], tile: 240 }), [v])
    expect(out.error).toBe('tainted')
    expect(v.currentTime).toBe(3)
  })

  it('says there is no video instead of throwing', async () => {
    expect(await runPage(videoCaptureScript({ times: [0], tile: 240 }), [])).toEqual({ error: 'no-video' })
  })
})

describe('seekScript', () => {
  it('hands t and i to the caller code and awaits it', async () => {
    const seen: Array<[number, number]> = []
    const script = seekScript('window.__log(t, i); await Promise.resolve(); return t * 2', 1.5, 3)
    const fn = new Function('window', `return ${script}`)
    const out = await fn({ __log: (t: number, i: number) => seen.push([t, i]) })
    expect(out).toBe(3)
    expect(seen).toEqual([[1.5, 3]])
  })
})
