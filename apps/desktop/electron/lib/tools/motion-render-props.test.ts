import fsp from 'node:fs/promises'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/orbit-test-props', isPackaged: false },
  BrowserWindow: class {},
  protocol: { handle: () => {} },
}))

const activity: string[] = []
vi.mock('../panel-browser', () => ({
  panelActivity: (label: string) => activity.push(label),
  panelMotionPreview: vi.fn(),
}))
type RenderCall = { file: string; output: string; props?: Record<string, unknown> }
const renders: RenderCall[] = []
/** Titles that make the fake renderer fail, to prove one bad video does not sink the batch. */
const failOn = new Set<string>()
let abortAfter: { controller: AbortController; n: number } | null = null
vi.mock('../video/motion', () => ({
  renderMotion: vi.fn(async (o: RenderCall) => {
    if (failOn.has(String(o.props?.title))) throw new Error('capture window crashed')
    renders.push({ file: o.file, output: o.output, props: o.props })
    if (abortAfter && renders.length >= abortAfter.n) abortAfter.controller.abort()
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
const PROJECT = '/tmp/orbit-test-props-project'
const { createMotionTools, motionPiecesDir } = await import('./motion')

const folder = () => path.join(motionPiecesDir(SESSION), 'promo')

beforeAll(async () => {
  await fsp.mkdir(folder(), { recursive: true })
  await fsp.writeFile(path.join(folder(), 'index.html'), '<html><body>x</body></html>')
  await fsp.writeFile(
    path.join(folder(), 'props.json'),
    JSON.stringify({
      title: { type: 'text', default: 'Black Friday' },
      price: { type: 'number', default: 99, min: 0 },
      photo: { type: 'image', default: 'logo.png' },
    }),
  )
  await fsp.writeFile(path.join(folder(), 'logo.png'), 'LOGO')
  await fsp.mkdir(path.join(PROJECT, 'fotos'), { recursive: true })
  await fsp.writeFile(path.join(PROJECT, 'fotos', 'a.png'), 'PHOTO-A')
  await fsp.writeFile(path.join(PROJECT, 'fotos', 'b.png'), 'PHOTO-B')
})
afterAll(async () => {
  await fsp.rm('/tmp/orbit-test-props', { recursive: true, force: true })
  await fsp.rm(PROJECT, { recursive: true, force: true })
})
beforeEach(() => {
  renders.length = 0
  gallery.length = 0
  activity.length = 0
  failOn.clear()
  abortAfter = null
})

type Out = { message: string; videoUrl?: string }
const projectCtx = () => ({ sessionId: SESSION, directory: PROJECT, extraDirectories: [], abort: new AbortController().signal })
async function render(input: Record<string, unknown>, opts: { project?: boolean; signal?: AbortSignal } = {}): Promise<Out> {
  const tools = createMotionTools({ sessionId: SESSION, canRender: true, canShow: true, ...(opts.project ? { project: projectCtx() } : {}) } as never) as unknown as Record<
    string,
    { execute: (i: unknown, o: unknown) => Promise<Out> }
  >
  return tools.motion_render.execute({ name: 'promo', ...input }, { toolCallId: 't', messages: [], abortSignal: opts.signal })
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

  it('asks for at least one and at most 200', async () => {
    const tools = createMotionTools({ sessionId: SESSION, canRender: true, canShow: true } as never) as unknown as Record<string, { inputSchema: { safeParse: (v: unknown) => { success: boolean } } }>
    const schema = tools.motion_render.inputSchema
    expect(schema.safeParse({ name: 'p', variations: [] }).success).toBe(false)
    expect(schema.safeParse({ name: 'p', variations: Array.from({ length: 201 }, () => ({ props: {} })) }).success).toBe(false)
    expect(schema.safeParse({ name: 'p', variations: Array.from({ length: 200 }, () => ({ props: {} })) }).success).toBe(true)
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

describe('motion_render — a table of videos (variationsFrom)', () => {
  it('renders one video per row of a CSV, the header being the props, the file column naming them', async () => {
    const out = await render({ variationsFrom: { data: 'file,title,price\nsp,Oferta SP,49\nrj,Oferta RJ,\n' } })
    expect(renders.map((r) => r.props)).toEqual([{ title: 'Oferta SP', price: '49' }, { title: 'Oferta RJ' }])
    expect(renders.map((r) => path.basename(r.output))).toEqual(['promo-sp.mp4', 'promo-rj.mp4'])
    expect(out.message).toContain('Rendered 2 of 2 variations')
  })

  it('accepts JSON and a semicolon CSV with a decimal comma', async () => {
    await render({ variationsFrom: { data: '[{"title":"A"},{"title":"B"}]' } })
    expect(renders.map((r) => r.props?.title)).toEqual(['A', 'B'])
    renders.length = 0
    await render({ variationsFrom: { data: 'title;price\nA;12,5' } })
    expect(renders[0].props).toEqual({ title: 'A', price: '12.5' })
  })

  it('reads the table from a file of the project in code mode', async () => {
    await fsp.writeFile(path.join(PROJECT, 'ofertas.csv'), 'title\nUm\nDois\n')
    await render({ variationsFrom: { path: 'ofertas.csv' } }, { project: true })
    expect(renders.map((r) => r.props?.title)).toEqual(['Um', 'Dois'])
    await expect(render({ variationsFrom: { path: 'ofertas.csv' } })).rejects.toThrow(/needs a working folder/)
  })

  it('refuses a table with a column that is not a prop, with nothing rendered', async () => {
    await expect(render({ variationsFrom: { data: 'titel,price\nA,1' } })).rejects.toThrow(/column "titel" is not declared/)
    expect(renders).toHaveLength(0)
  })

  it('refuses a cell of the wrong type naming the row', async () => {
    await expect(render({ variationsFrom: { data: 'title,price\nA,10\nB,-3' } })).rejects.toThrow(/row 3 \("B"\): price: -3 is below the minimum 0/)
    expect(renders).toHaveLength(0)
  })

  it('does not take a table together with variations or props, nor an empty one', async () => {
    await expect(render({ variationsFrom: { data: 'title\nA' }, variations: [{ props: {} }] })).rejects.toThrow(/not both/)
    await expect(render({ variationsFrom: { data: 'title\nA' }, props: { title: 'x' } })).rejects.toThrow(/not both/)
    await expect(render({ variationsFrom: {} })).rejects.toThrow(/needs `data`/)
  })
})

describe('motion_render — images per variation', () => {
  it('copies a project photo into the piece and renders with its relative path', async () => {
    await render({ variations: [{ name: 'a', props: { photo: 'fotos/a.png' } }, { name: 'b', props: { photo: 'fotos/b.png' } }] }, { project: true })
    const paths = renders.map((r) => r.props?.photo as string)
    expect(paths[0]).toMatch(/^props-assets\/[0-9a-f]{10}-a\.png$/)
    expect(paths[1]).toMatch(/^props-assets\/[0-9a-f]{10}-b\.png$/)
    expect(await fsp.readFile(path.join(folder(), paths[0]), 'utf8')).toBe('PHOTO-A')
  })

  it('works from a table column too, and for a single render', async () => {
    await render({ variationsFrom: { data: 'title,photo\nA,fotos/a.png' } }, { project: true })
    expect(renders[0].props?.photo).toMatch(/^props-assets\//)
    renders.length = 0
    await render({ props: { photo: 'fotos/b.png' } }, { project: true })
    expect(renders[0].props?.photo).toMatch(/^props-assets\/.*-b\.png$/)
  })

  it('names the variation whose photo is nowhere, and renders nothing', async () => {
    await expect(render({ variations: [{ name: 'ok', props: { photo: 'fotos/a.png' } }, { name: 'ruim', props: { photo: 'fotos/zzz.png' } }] }, { project: true })).rejects.toThrow(
      /variation 2 "ruim": photo: the image "fotos\/zzz.png" was not found/,
    )
    expect(renders).toHaveLength(0)
  })
})

describe('motion_render — a long batch', () => {
  it('one video that fails does not sink the others, and the failure is reported with its name', async () => {
    failOn.add('Ruim')
    const out = await render({ variations: [{ name: 'a', props: { title: 'Bom 1' } }, { name: 'b', props: { title: 'Ruim' } }, { name: 'c', props: { title: 'Bom 2' } }] })
    expect(renders.map((r) => r.props?.title)).toEqual(['Bom 1', 'Bom 2'])
    expect(out.message).toContain('Rendered 2 of 3 variations')
    expect(out.message).toMatch(/FAILED \(1\) — the others were not affected: 2 "b": capture window crashed/)
  })

  it('stops cleanly when the user cancels, saying how many were done', async () => {
    const controller = new AbortController()
    abortAfter = { controller, n: 2 }
    const out = await render({ variations: Array.from({ length: 5 }, (_, i) => ({ name: `v${i}`, props: { title: `T${i}` } })) }, { signal: controller.signal })
    expect(renders).toHaveLength(2)
    expect(out.message).toContain('Rendered 2 of 5')
    expect(out.message).toContain('Stopped by the user after 2 of 5; the rest were NOT rendered.')
  })

  it('announces its progress to the UI, with the time left once it can know it', async () => {
    await render({ variations: [{ props: { title: 'a' } }, { props: { title: 'b' } }, { props: { title: 'c' } }] })
    expect(activity).toHaveLength(3)
    expect(activity[0]).toMatch(/1\/3/)
    expect(activity[0]).not.toMatch(/left|faltam/)
    expect(activity[2]).toMatch(/3\/3/)
    expect(activity[2]).toMatch(/left|faltam/)
  })
})
