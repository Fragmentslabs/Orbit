import fsp from 'node:fs/promises'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/orbit-test-props', isPackaged: false },
  BrowserWindow: class {},
  protocol: { handle: () => {} },
}))

type RenderCall = { file: string; output: string; props?: Record<string, unknown> }
const renders: RenderCall[] = []
vi.mock('../video/motion', () => ({
  renderMotion: vi.fn(async (o: RenderCall) => {
    renders.push({ file: o.file, output: o.output, props: o.props })
    await fsp.mkdir(path.dirname(o.output), { recursive: true })
    await fsp.writeFile(o.output, 'video')
    return { duration: 2, width: 1080, height: 1920, fps: 30, frames: 60, warnings: [], metrics: null }
  }),
}))
const gallery: string[] = []
vi.mock('../video/video-gallery', () => ({
  addVideoToGallery: vi.fn(async (o: { name: string }) => {
    gallery.push(o.name)
    return { entry: { videoUrl: `orbit-video://${o.name}` } }
  }),
}))

const frameCalls: Array<Record<string, unknown>> = []
vi.mock('../video/motion-frame', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../video/motion-frame')>()),
  captureMotionFrames: vi.fn(async (req: Record<string, unknown>) => {
    frameCalls.push(req)
    return { image: Buffer.from('x'), name: 'promo', file: 'f', url: 'u', fps: 30, durationInFrames: 60, width: 1080, height: 1920, failedFonts: [], scriptErrors: [], cells: [] }
  }),
}))

const SESSION = 'PropsTestSession1'
const { createMotionTools, motionPiecesDir } = await import('./motion')

const folder = () => path.join(motionPiecesDir(SESSION), 'promo')

beforeAll(async () => {
  await fsp.mkdir(folder(), { recursive: true })
  await fsp.writeFile(path.join(folder(), 'index.html'), '<html><body>x</body></html>')
  await fsp.writeFile(
    path.join(folder(), 'props.json'),
    JSON.stringify({ title: { type: 'text', default: 'Black Friday' }, price: { type: 'number', default: 99, min: 0 } }),
  )
})
afterAll(() => fsp.rm('/tmp/orbit-test-props', { recursive: true, force: true }))
beforeEach(() => {
  renders.length = 0
  gallery.length = 0
})

type Out = { message: string; videoUrl?: string }
async function render(input: Record<string, unknown>): Promise<Out> {
  const tools = createMotionTools({ sessionId: SESSION, canRender: true, canShow: true } as never) as unknown as Record<
    string,
    { execute: (i: unknown, o: unknown) => Promise<Out> }
  >
  return tools.motion_render.execute({ name: 'promo', ...input }, { toolCallId: 't', messages: [], abortSignal: undefined })
}

describe('motion_render — props', () => {
  it('passes the props of one render to the renderer', async () => {
    const out = await render({ props: { title: 'Oferta A', price: 49 } })
    expect(renders).toHaveLength(1)
    expect(renders[0].props).toEqual({ title: 'Oferta A', price: 49 })
    expect(out.videoUrl).toBe('orbit-video://promo.mp4')
  })

  it('renders without props exactly as before', async () => {
    await render({})
    expect(renders[0].props).toBeUndefined()
  })

  it('refuses props together with variations', async () => {
    await expect(render({ props: { title: 'a' }, variations: [{ props: { title: 'b' } }] })).rejects.toThrow(/not both/)
    expect(renders).toHaveLength(0)
  })
})

describe('motion_render — variations (videos in bulk)', () => {
  it('renders the same piece once per variation, one file each, named after the variation', async () => {
    const out = await render({
      variations: [
        { name: 'Oferta A', props: { title: 'Oferta A', price: 49 } },
        { name: 'Oferta B', props: { title: 'Oferta B', price: 59 } },
        { props: { title: 'Sem nome' } },
      ],
    })
    expect(renders.map((r) => r.props)).toEqual([{ title: 'Oferta A', price: 49 }, { title: 'Oferta B', price: 59 }, { title: 'Sem nome' }])
    expect(renders.map((r) => path.basename(r.output))).toEqual(['promo-oferta-a.mp4', 'promo-oferta-b.mp4', 'promo-03.mp4'])
    expect(gallery).toEqual(['promo-oferta-a.mp4', 'promo-oferta-b.mp4', 'promo-03.mp4'])
    expect(out.message).toContain('Rendered 3 of 3 variations of "promo"')
    expect(out.message).toContain('1/3 promo-oferta-a.mp4')
    expect(out.videoUrl).toBeUndefined() // a batch is listed, not played one by one
  })

  it('checks EVERY variation before the first frame and names the bad one', async () => {
    await expect(
      render({
        variations: [
          { name: 'a', props: { title: 'ok' } },
          { name: 'b', props: { price: -1 } },
          { name: 'c', props: { titel: 'typo' } },
        ],
      }),
    ).rejects.toThrow(/variation 2 "b": price: -1 is below the minimum 0; variation 3 "c": titel: not declared/)
    expect(renders).toHaveLength(0) // not even the first one ran
    expect(gallery).toHaveLength(0)
  })

  it('two variations with the same name still get two files', async () => {
    await render({ variations: [{ name: 'x', props: {} }, { name: 'X', props: {} }] })
    expect(renders.map((r) => path.basename(r.output))).toEqual(['promo-x.mp4', 'promo-x-2.mp4'])
  })

  it('asks for at least one and at most 50', async () => {
    const tools = createMotionTools({ sessionId: SESSION, canRender: true, canShow: true } as never) as unknown as Record<string, { inputSchema: { safeParse: (v: unknown) => { success: boolean } } }>
    const schema = tools.motion_render.inputSchema
    expect(schema.safeParse({ name: 'p', variations: [] }).success).toBe(false)
    expect(schema.safeParse({ name: 'p', variations: Array.from({ length: 51 }, () => ({ props: {} })) }).success).toBe(false)
    expect(schema.safeParse({ name: 'p', variations: [{ props: { a: 1 } }] }).success).toBe(true)
  })
})

describe('motion_frame — props', () => {
  const frame = async (input: Record<string, unknown>) => {
    const tools = createMotionTools({ sessionId: SESSION, canRender: true, canShow: true } as never) as unknown as Record<string, { execute: (i: unknown, o: unknown) => Promise<unknown> }>
    return tools.motion_frame.execute({ name: 'promo', times: [1], ...input }, { toolCallId: 'f', messages: [], abortSignal: undefined })
  }

  it('looks at the piece with the props asked (the longest name, say), not the defaults', async () => {
    frameCalls.length = 0
    await frame({ props: { title: 'Um nome muito, muito comprido para caber' } })
    expect(frameCalls).toHaveLength(1)
    expect(frameCalls[0].props).toEqual({ title: 'Um nome muito, muito comprido para caber' })
  })

  it('refuses bad props before opening a window', async () => {
    frameCalls.length = 0
    await expect(frame({ props: { price: -5 } })).rejects.toThrow(/invalid props — props: price: -5 is below the minimum 0/)
    expect(frameCalls).toHaveLength(0)
  })

  it('without props it behaves as before', async () => {
    frameCalls.length = 0
    await frame({})
    expect(frameCalls[0].props).toBeUndefined()
  })
})
