import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { ToolContext } from './context'

/**
 * Slides — the same tools in both modes: the deck lives in Orbit's
 * storage and is written (slides or html), edited, read, shown, fed with
 * assets and deleted by name. Mirrors design.test.ts's mock.
 */

const userData = path.join(os.tmpdir(), `orbit-slides-tools-${process.pid}`)

vi.mock('electron', () => ({
  app: { getPath: () => userData, getAppPath: () => userData, isPackaged: false },
  BrowserWindow: { getAllWindows: () => [] },
  net: {},
  protocol: { handle: () => {}, registerSchemesAsPrivileged: () => {} },
  session: {},
  dialog: {},
}))

const { createSlidesTools } = await import('./slides')

type Exec = (input: unknown, options: unknown) => Promise<unknown>
const run = (tools: Record<string, unknown>, name: string, input: unknown) =>
  (tools[name] as { execute: Exec }).execute(input, {
    toolCallId: 'call1',
    messages: [],
    abortSignal: undefined,
  }) as Promise<string>

const deck = `<!doctype html><html><head><title>Pitch</title><style>h1{color:red}</style></head><body>
<section class="slide" data-title="Cover"><h1>Orbit</h1><aside class="notes">opens short</aside></section>
<section class="slide"><h2>Problema</h2></section>
<section class="slide"><h2>End</h2></section>
</body></html>`

const deckFile = (session: string, slug: string) => path.join(userData, 'orbit-data', 'slides', session, slug, 'index.html')

afterAll(async () => {
  await fsp.rm(userData, { recursive: true, force: true })
})

describe('slides_write', () => {
  it('writes the deck into Orbit storage and reports the slides', async () => {
    const tools = createSlidesTools({ sessionId: 'sess1' })
    const report = await run(tools, 'slides_write', {
      title: 'Orbit em 3 slides',
      slides: [
        { title: 'Capa', html: '<h1>Orbit</h1>', notes: 'abertura' },
        { html: '<h2>One</h2>' },
        { html: '<h2>Dois</h2>' },
      ],
    })

    expect(report).toContain('with 3 slides')
    expect(report).toContain('"Capa" (has notes)')
    expect(report).toContain('"One"')

    const html = await fsp.readFile(deckFile('sess1', 'orbit-em-3-slides'), 'utf8')
    expect(html).toContain('<meta name="orbit-slides" content="width=1280,height=720">')
    expect(html.match(/<section class="slide"/g)).toHaveLength(3)
    // The deck is content: no script in it.
    expect(html).not.toContain('<script')
  })

  it('the same title rewrites the SAME deck', async () => {
    const tools = createSlidesTools({ sessionId: 'sess1' })
    await run(tools, 'slides_write', { title: 'Reescrito', slides: [{ html: '<h1>A</h1>' }] })
    const second = await run(tools, 'slides_write', { title: 'Reescrito', slides: [{ html: '<h1>B</h1>' }] })

    expect(second).toContain('with 1 slide')
    const html = await fsp.readFile(deckFile('sess1', 'reescrito'), 'utf8')
    expect(html).toContain('<h1>B</h1>')
    expect(html).not.toContain('<h1>A</h1>')
    // A single deck in the folder.
    const folders = await fsp.readdir(path.join(userData, 'orbit-data', 'slides', 'sess1'))
    expect(folders.filter((name) => name === 'reescrito')).toHaveLength(1)
  })

  it('accepts the whole document (its own theme) instead of the slides', async () => {
    const tools = createSlidesTools({ sessionId: 'sess1' })
    const report = await run(tools, 'slides_write', { title: 'Pitch', html: deck })
    expect(report).toContain('with 3 slides')
    expect(report).toContain('1 of them have presenter notes')
    expect(await fsp.readFile(deckFile('sess1', 'pitch'), 'utf8')).toBe(deck)
  })

  it('refuses both formats together, none at all, or a deck without <section class="slide">', async () => {
    const tools = createSlidesTools({ sessionId: 'sess1' })
    await expect(run(tools, 'slides_write', { title: 'X', html: deck, slides: [{ html: '<h1>A</h1>' }] })).rejects.toThrow(/exactly one/)
    await expect(run(tools, 'slides_write', { title: 'X' })).rejects.toThrow(/exactly one/)
    await expect(run(tools, 'slides_write', { title: 'X', html: '<html><body><h1>nada</h1></body></html>' })).rejects.toThrow(
      /no <section class="slide">/,
    )
  })
})

describe('slides_edit / slides_read / slides_preview', () => {
  it('swaps an exact snippet and the deck keeps the same slides', async () => {
    const tools = createSlidesTools({ sessionId: 'sess2' })
    await run(tools, 'slides_write', { title: 'Pitch', html: deck })
    const report = await run(tools, 'slides_edit', { name: 'Pitch', edits: [{ oldText: '<h2>Problema</h2>', newText: '<h2>Dor</h2>' }] })
    expect(report).toContain('1 edit applied')
    expect(report).toContain('"Dor"')
    expect(await run(tools, 'slides_read', { name: 'Pitch' })).toContain('<h2>Dor</h2>')
  })

  it('refuses an edit that would leave the deck without slides, writing nothing', async () => {
    const tools = createSlidesTools({ sessionId: 'sess2' })
    const before = await run(tools, 'slides_read', { name: 'Pitch' })
    await expect(
      run(tools, 'slides_edit', { name: 'Pitch', edits: [{ oldText: 'class="slide"', newText: 'class="x"', replaceAll: true }] }),
    ).rejects.toThrow(/no <section class="slide">/)
    expect(await run(tools, 'slides_read', { name: 'Pitch' })).toBe(before)
  })

  it('slides_preview reopens an existing deck and refuses a missing one', async () => {
    const tools = createSlidesTools({ sessionId: 'sess2' })
    expect(await run(tools, 'slides_preview', { name: 'Pitch' })).toContain('is open in the Slides tab')
    await expect(run(tools, 'slides_preview', { name: 'None' })).rejects.toThrow(/no deck named "none"/)
  })
})

describe('slides_asset / slides_delete / plan mode', () => {
  it('in code mode, copies a file from the working folder into the deck', async () => {
    const directory = path.join(userData, 'proj')
    await fsp.mkdir(path.join(directory, 'docs'), { recursive: true })
    await fsp.writeFile(path.join(directory, 'docs', 'grafico.png'), 'PNG')
    const project: ToolContext = { sessionId: 'sess3', directory, extraDirectories: [], abort: new AbortController().signal }
    const tools = createSlidesTools({ sessionId: 'sess3', project })
    await run(tools, 'slides_write', { title: 'Relatorio', slides: [{ html: '<h1>A</h1>' }] })

    const report = await run(tools, 'slides_asset', { name: 'Relatorio', path: 'docs/grafico.png' })
    expect(report).toContain('<img src="grafico.png">')
    expect(await fsp.readFile(path.join(path.dirname(deckFile('sess3', 'relatorio')), 'grafico.png'), 'utf8')).toBe('PNG')
    await expect(run(tools, 'slides_asset', { name: 'Relatorio', path: '../../etc/passwd' })).rejects.toThrow(/Access denied/)
  })

  it('in chat, `path` does not exist — material comes in by the attachment ref', async () => {
    const tools = createSlidesTools({ sessionId: 'sess3' })
    await expect(run(tools, 'slides_asset', { name: 'Relatorio', path: 'docs/grafico.png' })).rejects.toThrow(/needs a working folder/)
  })

  it('slides_delete deletes the deck folder', async () => {
    const tools = createSlidesTools({ sessionId: 'sess3' })
    const report = await run(tools, 'slides_delete', { name: 'Relatorio' })
    expect(report).toContain('deleted')
    await expect(fsp.stat(path.dirname(deckFile('sess3', 'relatorio')))).rejects.toThrow()
  })

  it('plan mode: read and show only', () => {
    const tools = createSlidesTools({ sessionId: 'sess3', readOnly: true })
    expect(Object.keys(tools).sort()).toEqual(['slides_preview', 'slides_read'])
  })
})
