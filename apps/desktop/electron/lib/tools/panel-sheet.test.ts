import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createCanvas } from '@napi-rs/canvas'

const scripts: string[] = []
let responder: (script: string) => unknown = () => ({})
const saved: Array<{ buffer: Buffer; meta: Record<string, unknown> }> = []
const shots: number[] = []

vi.mock('../media', () => ({
  getMediaEntry: vi.fn(),
  mediaIdFromUrl: vi.fn(),
  saveMedia: async (buffer: Buffer, _ext: string, meta: Record<string, unknown>) => {
    saved.push({ buffer, meta })
    return `orbit-media://img_${saved.length}.webp`
  },
}))
vi.mock('../browser-script', () => ({ captureUrl: vi.fn() }))
vi.mock('../vision', () => ({ describeImage: vi.fn(async () => 'a pink burst on cream') }))
vi.mock('../panel-browser', () => ({
  PanelCaptureError: class extends Error {},
  panelClick: vi.fn(),
  panelConsole: vi.fn(),
  panelCurrentUrl: vi.fn(),
  panelDrag: vi.fn(),
  panelEval: vi.fn(),
  panelHover: vi.fn(),
  panelLastViewport: vi.fn(),
  panelNavigate: vi.fn(),
  panelRead: vi.fn(),
  panelResize: vi.fn(),
  panelType: vi.fn(),
  panelRunScript: async (_sid: string, script: string) => {
    scripts.push(script)
    return responder(script)
  },
  panelScreenshot: async () => {
    shots.push(Date.now())
    const c = createCanvas(320, 180)
    c.getContext('2d').fillRect(0, 0, 320, 180)
    return c.toBuffer('image/webp')
  },
}))

import { createPanelBrowserTools } from './panel-browser'

function jpegUrl(): string {
  const c = createCanvas(64, 36)
  c.getContext('2d').fillRect(0, 0, 64, 36)
  return `data:image/jpeg;base64,${c.toBuffer('image/jpeg').toString('base64')}`
}

type Out = string
async function sheet(input: Record<string, unknown>, ctx: Record<string, unknown> = {}): Promise<Out> {
  const tools = createPanelBrowserTools({ sessionId: 's1', directory: '/tmp/x', ...ctx } as never) as unknown as Record<string, { execute: (i: unknown, o: unknown) => Promise<Out> }>
  return tools.panel_sheet.execute(input, { toolCallId: 'call1', messages: [] })
}

/** A page with a 10 s video: the probe answers, the capture returns a frame per asked time. */
function videoPage(extra: Record<string, unknown> = {}) {
  responder = (script) => {
    if (script.includes('found: true')) return { found: true, duration: 10, width: 720, height: 720, paused: false, at: 0, src: 'blob', videos: 1 }
    const times = JSON.parse(/"times":(\[[^\]]*\])/.exec(script)![1]) as number[]
    return { frames: times.map(jpegUrl), actual: times, duration: 10, width: 720, height: 720, ...extra }
  }
}

beforeEach(() => {
  scripts.length = 0
  saved.length = 0
  shots.length = 0
})

describe('panel_sheet — video mode', () => {
  it('reads the video of the page, builds sheets of 24 frames and saves them to the gallery', async () => {
    videoPage()
    const text = await sheet({ from: 0, to: 9.8, step: 0.2 }) // 50 frames
    expect(text).toContain('50 frames in 3 sheet(s)')
    expect(text).toContain('Sheet 1/3: 24 frames, 0.00s–4.60s')
    expect(text).toContain('Sheet 3/3: 2 frames, 9.60s–9.80s')
    expect(saved).toHaveLength(3)
    expect(saved[0].meta).toMatchObject({ source: 'screenshot', sessionId: 's1' })
    // the capture goes in batches of 24 → 1 probe + 3 captures
    expect(scripts).toHaveLength(4)
  })

  it('defaults to the whole video with about 24 frames', async () => {
    videoPage()
    const text = await sheet({})
    expect(text).toMatch(/2[45] frames in (1|2) sheet/)
  })

  it('respects perSheet, cols and tile', async () => {
    videoPage()
    const text = await sheet({ count: 8, perSheet: 4, cols: 2, tile: 200 })
    expect(text).toContain('8 frames in 2 sheet(s)')
    expect(text).toContain('2 columns × 2 rows')
  })

  it('does not load images into the context unless see is true', async () => {
    videoPage()
    const text = await sheet({ count: 4 })
    expect(text).not.toContain('loaded into your context')
  })

  it('with see and a vision-capable model, loads the sheets (at most 3)', async () => {
    videoPage()
    const text = await sheet({ from: 0, to: 9.8, step: 0.2, see: true }, { modelVision: true })
    expect(text).toContain('3 sheet(s) loaded into your context')
  })

  it('with a vision model configured, loads descriptions instead of images', async () => {
    videoPage()
    const text = await sheet({ count: 4, see: true }, { visionModel: { modelId: 'vis-1' } })
    expect(text).toContain('Description of 1 sheet(s)')
  })

  it('says so when the page has no video, and points to seek mode', async () => {
    responder = () => ({ found: false, videos: 0 })
    const text = await sheet({})
    expect(text).toContain('No <video> in the page')
    expect(text).toContain('seekCode')
  })

  it('explains a video the page does not let out (tainted) and what to do', async () => {
    responder = (s) => (s.includes('found: true') ? { found: true, duration: 10, videos: 1 } : { error: 'tainted', message: 'Tainted canvases may not be exported' })
    const text = await sheet({ count: 4 })
    expect(text).toContain('does not let its video be read')
    expect(text).toContain('mode "seek"')
    expect(saved).toHaveLength(0)
  })

  it('reports a page that did not answer', async () => {
    responder = () => ({ __error: 'the page did not answer within 30 s' })
    expect(await sheet({ count: 4 })).toContain('Could not read the page')
  })

  it('refuses a request that would be too many frames, with the reason', async () => {
    videoPage()
    expect(await sheet({ step: 0.01 })).toMatch(/max 120/)
  })

  it('warns when the video is only a moment long (an ad)', async () => {
    responder = (s) => (s.includes('found: true') ? { found: true, duration: 0.6, videos: 1 } : { frames: [jpegUrl(), jpegUrl()], actual: [0, 0.5], duration: 0.6 })
    expect(await sheet({ count: 2 })).toContain('reports only 0.60 s')
  })
})

describe('panel_sheet — seek mode', () => {
  it('needs seekCode and a `to`', async () => {
    expect(await sheet({ mode: 'seek' })).toContain('needs seekCode')
    expect(await sheet({ seekCode: 'await 1', step: 1 })).toMatch(/give `to`/)
  })

  it('positions the page at each time with the caller code, then screenshots', async () => {
    responder = () => undefined
    const text = await sheet({ seekCode: 'await window.orbitMotion.seek(Math.round(t * 30))', from: 0, to: 1, step: 0.25, settleMs: 0 })
    expect(shots).toHaveLength(5)
    expect(scripts).toHaveLength(5)
    expect(scripts[1]).toContain('Math.round(t * 30)')
    expect(scripts[1]).toContain('(0.25, 1)')
    expect(text).toContain('by seeking the page with your seekCode')
    expect(text).toContain('Sheet 1/1: 5 frames, 0.00s–1.00s')
  })

  it('stops at the frame where the caller code fails and says which', async () => {
    responder = (s) => (s.includes('(0.5, 2)') ? { __error: 'ReferenceError: anim is not defined' } : undefined)
    const text = await sheet({ seekCode: 'anim.goToAndStop(t * 1000)', from: 0, to: 1, step: 0.25, settleMs: 0 })
    expect(text).toContain('seekCode failed at t=0.5 s (frame 3)')
    expect(text).toContain('anim is not defined')
    expect(saved).toHaveLength(0)
  })
})

describe('panel_sheet — schema', () => {
  it('hides `see` from the model when there is no vision at all', () => {
    const withVision = createPanelBrowserTools({ sessionId: 's', directory: '/tmp', modelVision: true } as never) as unknown as Record<string, { inputSchema: { shape: Record<string, unknown> } }>
    const without = createPanelBrowserTools({ sessionId: 's', directory: '/tmp' } as never) as unknown as Record<string, { inputSchema: { shape: Record<string, unknown> } }>
    expect(Object.keys(withVision.panel_sheet.inputSchema.shape)).toContain('see')
    expect(Object.keys(without.panel_sheet.inputSchema.shape)).not.toContain('see')
  })
})
