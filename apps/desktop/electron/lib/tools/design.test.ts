import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

/**
 * Design — the same tools in both modes: the canvas lives in the app's storage and
 * enters the gallery — mirrors video-chat.test.ts (the 'electron' mock is the
 * same mold, with no ffmpeg involved here).
 */

const userData = path.join(os.tmpdir(), `orbit-design-chat-${process.pid}`)

vi.mock('electron', () => ({
  app: { getPath: () => userData, getAppPath: () => userData, isPackaged: false },
  BrowserWindow: { getAllWindows: () => [] },
  net: {},
  protocol: { handle: () => {}, registerSchemesAsPrivileged: () => {} },
  session: {},
  dialog: {},
}))

// design_asset copies an ATTACHMENT into the canvas folder — the reference
// resolver (and ffmpeg, which it reaches for video) is the same as
// motion-asset.test.ts, mocked here the same way.
const resolved: Record<string, { kind: string; id: string; file: string; name: string }> = {}
vi.mock('../attachment-ref', () => ({
  resolveAttachmentRef: async (ref: string) => resolved[ref.replace(/^ref\s+/, '')] ?? null,
}))
vi.mock('../video/ffmpeg', () => ({
  probeMedia: async () => {
    throw new Error('no ffmpeg in this test')
  },
}))

const { designPiecesDir, createDesignTools, designSlug } = await import('./design')

type Exec = (input: unknown, options: unknown) => Promise<unknown>
const run = (tools: Record<string, unknown>, name: string, input: unknown) =>
  (tools[name] as { execute: Exec }).execute(input, { toolCallId: 'call1', messages: [], abortSignal: undefined }) as Promise<string>

afterAll(async () => {
  await fsp.rm(userData, { recursive: true, force: true })
})

describe('designSlug', () => {
  it('turns any name into a short, safe folder name', () => {
    expect(designSlug('Landing page v2')).toBe('landing-page-v2')
    expect(designSlug('  Apresentação — Orbit 2.0  ')).toBe('apresentacao-orbit-2-0')
    expect(designSlug('../../etc')).toBe('etc')
    expect(designSlug('***')).toBe('design')
  })
})

describe('designPiecesDir', () => {
  it('refuses a session id that could escape the folder', () => {
    expect(() => designPiecesDir('../other')).toThrow(/invalid session/)
    expect(designPiecesDir('sess1')).toContain('sess1')
  })
})

describe('createDesignTools — design_write / design_read / design_edit', () => {
  const tools = createDesignTools({ sessionId: 'sess1' })
  const folder = path.join(designPiecesDir('sess1'), 'landing')

  it('design_write creates the canvas.json, the shared stylesheet and each artboard file', async () => {
    const report = await run(tools, 'design_write', {
      name: 'Landing',
      title: 'Landing page',
      boards: [
        { file: 'Main.html', title: 'Hero', x: 0, y: 0, w: 1280, h: 800, html: '<!doctype html><title>Hero</title><body>Hi</body>' },
        { file: 'Pricing.html', x: 1360, y: 0, w: 1280, h: 800, html: '<!doctype html><title>Pricing</title><body>$9</body>' },
      ],
      styles: [{ file: 'base.css', css: ':root{--gap:8px} body{margin:0}' }],
    })
    // The report uses the folder's SLUG (like motion), not the original spelling.
    expect(report).toContain('Design "landing" is open in the Design tab')
    expect(report).toContain('with 2 artboards')
    // "Main.html" has a title ("Hero"), so it appears as "Hero" (Main.html, …).
    expect(report).toContain('"Hero" (Main.html,')
    expect(report).toContain('"Pricing.html" (Pricing.html,')
    // The shared sheet is not in canvas.json: the report names it so the
    // model does not repeat the CSS inside each document.
    expect(report).toContain('Shared stylesheets: base.css')

    const canvas = JSON.parse(await fsp.readFile(path.join(folder, 'canvas.json'), 'utf8'))
    expect(canvas.order).toEqual(['Main.html', 'Pricing.html'])
    expect(canvas.boards['Main.html']).toMatchObject({ title: 'Hero', x: 0, y: 0, w: 1280, h: 800 })
    expect(await fsp.readFile(path.join(folder, 'Main.html'), 'utf8')).toContain('Hi')
    expect(await fsp.readFile(path.join(folder, 'base.css'), 'utf8')).toContain('--gap')
  })

  it('rejects an artboard file name that is not a plain .html name', async () => {
    await expect(
      run(tools, 'design_write', {
        name: 'Bad',
        boards: [{ file: '../escape.html', x: 0, y: 0, w: 100, h: 100, html: '<html></html>' }],
      }),
    ).rejects.toThrow(/invalid artboard file name/)
  })

  it('design_read returns the layout (with the stylesheets), and one file\'s content', async () => {
    const layout = await run(tools, 'design_read', { name: 'Landing' })
    expect(JSON.parse(layout).order).toEqual(['Main.html', 'Pricing.html'])
    // canvas.json is only the arrangement; the sheets come in on read.
    expect(JSON.parse(layout).styles).toEqual(['base.css'])

    const html = await run(tools, 'design_read', { name: 'Landing', file: 'Main.html' })
    expect(html).toContain('Hi')

    const css = await run(tools, 'design_read', { name: 'Landing', file: 'base.css' })
    expect(css).toContain('--gap')
  })

  it('design_read refuses a file that is neither an artboard nor a stylesheet', async () => {
    await expect(run(tools, 'design_read', { name: 'Landing', file: '../secret.txt' })).rejects.toThrow(
      /invalid file name/,
    )
  })

  it('design_edit applies exact text edits to the shared stylesheet', async () => {
    const report = await run(tools, 'design_edit', {
      name: 'Landing',
      style: { file: 'base.css', edits: [{ oldText: '--gap:8px', newText: '--gap:16px' }] },
    })
    expect(report).toContain('updated "base.css"')
    const css = await fsp.readFile(path.join(folder, 'base.css'), 'utf8')
    expect(css).toContain('--gap:16px')
    expect(css).toContain('body{margin:0}')
  })

  it('design_edit refuses to edit a stylesheet that does not exist without its css', async () => {
    await expect(run(tools, 'design_edit', { name: 'Landing', style: { file: 'tokens.css', edits: [{ oldText: 'a', newText: 'b' }] } })).rejects.toThrow(
      /does not exist yet/,
    )
  })

  it('design_write refuses a stylesheet name that is not a plain .css name', async () => {
    await expect(
      run(tools, 'design_write', {
        name: 'Bad',
        boards: [{ file: 'Main.html', x: 0, y: 0, w: 100, h: 100, html: '<html></html>' }],
        styles: [{ file: '../base.css', css: 'body{}' }],
      }),
    ).rejects.toThrow(/invalid stylesheet file name/)
  })

  it('design_write refuses more than four artboards in one call (write one, add the rest with design_edit)', async () => {
    const boards = Array.from({ length: 5 }, (_, i) => ({
      file: `S${i}.html`,
      x: i * 100,
      y: 0,
      w: 400,
      h: 300,
      html: '<!doctype html><title>x</title><body>x</body>',
    }))
    await expect(run(tools, 'design_write', { name: 'TooMany', boards })).rejects.toThrow(/at most 4 artboards/)
  })

  it('design_edit applies exact text edits to an artboard', async () => {
    const report = await run(tools, 'design_edit', {
      name: 'Landing',
      file: 'Main.html',
      edits: [{ oldText: 'Hi', newText: 'Hello there' }],
    })
    expect(report).toContain('updated "Main.html"')
    expect(await fsp.readFile(path.join(folder, 'Main.html'), 'utf8')).toContain('Hello there')
  })

  it('design_edit moves/resizes an artboard without touching its HTML', async () => {
    await run(tools, 'design_edit', { name: 'Landing', file: 'Main.html', x: 40, y: 40, w: 1000, h: 700 })
    const canvas = JSON.parse(await fsp.readFile(path.join(folder, 'canvas.json'), 'utf8'))
    expect(canvas.boards['Main.html']).toMatchObject({ x: 40, y: 40, w: 1000, h: 700 })
    expect(await fsp.readFile(path.join(folder, 'Main.html'), 'utf8')).toContain('Hello there')
  })

  it('design_edit adds a brand-new artboard', async () => {
    await run(tools, 'design_edit', {
      name: 'Landing',
      file: 'Footer.html',
      html: '<!doctype html><title>Footer</title><body>© Orbit</body>',
      x: 0,
      y: 900,
      w: 1280,
      h: 200,
    })
    const canvas = JSON.parse(await fsp.readFile(path.join(folder, 'canvas.json'), 'utf8'))
    expect(canvas.order).toContain('Footer.html')
    expect(await fsp.readFile(path.join(folder, 'Footer.html'), 'utf8')).toContain('Orbit')
  })

  it('design_edit reorders the stack', async () => {
    await run(tools, 'design_edit', { name: 'Landing', order: ['Footer.html', 'Pricing.html', 'Main.html'] })
    const canvas = JSON.parse(await fsp.readFile(path.join(folder, 'canvas.json'), 'utf8'))
    expect(canvas.order).toEqual(['Footer.html', 'Pricing.html', 'Main.html'])
  })

  it('design_edit removes an artboard and deletes its file', async () => {
    await run(tools, 'design_edit', { name: 'Landing', file: 'Footer.html', remove: true })
    const canvas = JSON.parse(await fsp.readFile(path.join(folder, 'canvas.json'), 'utf8'))
    expect(canvas.order).not.toContain('Footer.html')
    expect(canvas.boards['Footer.html']).toBeUndefined()
    await expect(fsp.stat(path.join(folder, 'Footer.html'))).rejects.toThrow()
  })

  it('design_edit refuses editing a canvas that does not exist', async () => {
    await expect(run(tools, 'design_edit', { name: 'Nope', file: 'Main.html', html: '<html></html>' })).rejects.toThrow(
      /no design canvas named/,
    )
  })

  it('design_read refuses a missing artboard with a helpful error', async () => {
    await expect(run(tools, 'design_read', { name: 'Landing', file: 'Missing.html' })).rejects.toThrow(/not found/)
  })
})

describe('createDesignTools — design_asset', () => {
  it('copies an attached photo into the canvas folder and hints the relative src', async () => {
    const source = path.join(userData, 'orig.png')
    await fsp.writeFile(source, 'PNG')
    resolved['img_ab1.png'] = { kind: 'image', id: 'img_ab1.png', file: source, name: 'Team photo.png' }

    const tools = createDesignTools({ sessionId: 'sess1' })
    const report = await run(tools, 'design_asset', { ref: 'img_ab1.png', name: 'Moodboard' })

    expect(report).toContain('Copied: image "Team photo.png" → Team-photo.png')
    expect(report).toContain('<img src="Team-photo.png">')
    const folder = path.join(designPiecesDir('sess1'), 'moodboard')
    expect(await fsp.readFile(path.join(folder, 'Team-photo.png'), 'utf8')).toBe('PNG')
  })

  it('design_asset refuses a ref that is not an attachment', async () => {
    const tools = createDesignTools({ sessionId: 'sess1' })
    await expect(run(tools, 'design_asset', { ref: 'img_naoexiste.png', name: 'Moodboard' })).rejects.toThrow(
      /attachment not found/,
    )
  })
})

describe('createDesignTools — design_preview / design_delete / code / plan mode', () => {
  it('design_preview reopens an existing canvas and refuses a missing one', async () => {
    const tools = createDesignTools({ sessionId: 'sess2' })
    await run(tools, 'design_write', { name: 'Logo', boards: [{ file: 'Main.html', x: 0, y: 0, w: 400, h: 400, html: '<html></html>' }] })
    expect(await run(tools, 'design_preview', { name: 'Logo' })).toContain('with 1 artboard')
    await expect(run(tools, 'design_preview', { name: 'None' })).rejects.toThrow(/no design canvas named "none"/)
  })

  it('design_delete deletes the canvas folder', async () => {
    const tools = createDesignTools({ sessionId: 'sess2' })
    expect(await run(tools, 'design_delete', { name: 'Logo' })).toContain('deleted')
    await expect(fsp.stat(path.join(designPiecesDir('sess2'), 'logo'))).rejects.toThrow()
  })

  it('in code mode the canvas lives in Orbit, and a project file comes in through design_asset({ path })', async () => {
    const directory = path.join(userData, 'proj')
    await fsp.mkdir(path.join(directory, 'public'), { recursive: true })
    await fsp.writeFile(path.join(directory, 'public', 'logo.svg'), '<svg/>')
    const project = { sessionId: 'sess4', directory, extraDirectories: [], abort: new AbortController().signal }
    const tools = createDesignTools({ sessionId: 'sess4', project })
    await run(tools, 'design_write', { name: 'Site', boards: [{ file: 'Home.html', x: 0, y: 0, w: 1280, h: 800, html: '<html></html>' }] })
    const report = await run(tools, 'design_asset', { name: 'Site', path: 'public/logo.svg' })

    expect(report).toContain('<img src="logo.svg">')
    expect(await fsp.readFile(path.join(designPiecesDir('sess4'), 'site', 'logo.svg'), 'utf8')).toBe('<svg/>')
    // Nothing was written to the project.
    expect(await fsp.readdir(directory)).toEqual(['public'])
  })

  it('plan mode: read and show only', () => {
    const tools = createDesignTools({ sessionId: 'sess4', readOnly: true })
    expect(Object.keys(tools).sort()).toEqual(['design_preview', 'design_read'])
  })
})
