import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { ToolContext } from './context'

/**
 * Slides nas duas portas: `slides_preview` (modo código, aponta para um arquivo
 * que o agente já escreveu) e `slides_write` (modo chat, o conteúdo vem na
 * chamada). Espelha o mock de design.test.ts.
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
const { createChatSlidesTools } = await import('./slides-chat')

type Exec = (input: unknown, options: unknown) => Promise<unknown>
const run = (tools: Record<string, unknown>, name: string, input: unknown) =>
  (tools[name] as { execute: Exec }).execute(input, {
    toolCallId: 'call1',
    messages: [],
    abortSignal: undefined,
  }) as Promise<string>

const deck = `<!doctype html><html><head><title>Pitch</title></head><body>
<section class="slide" data-title="Capa"><h1>Orbit</h1><aside class="notes">abre curto</aside></section>
<section class="slide"><h2>Problema</h2></section>
<section class="slide"><h2>Fim</h2></section>
</body></html>`

afterAll(async () => {
  await fsp.rm(userData, { recursive: true, force: true })
})

describe('slides_preview (modo código)', () => {
  it('registra, abre a pasta e relata os slides pelo título', async () => {
    const directory = path.join(userData, 'proj')
    const folder = path.join(directory, 'slides', 'pitch')
    await fsp.mkdir(folder, { recursive: true })
    await fsp.writeFile(path.join(folder, 'index.html'), deck, 'utf8')

    const ctx: ToolContext = { sessionId: 'sess1', directory, extraDirectories: [], abort: new AbortController().signal }
    const tools = createSlidesTools(ctx, { sessionId: 'sess1' })

    const report = await run(tools, 'slides_preview', { path: 'slides/pitch' })
    expect(report).toContain('is open in the Slides tab')
    expect(report).toContain('with 3 slides')
    expect(report).toContain('"Capa" (has notes)')
    expect(report).toContain('1. "Capa"')
    expect(report).toContain('1 of them have presenter notes')
  })

  it('aceita o arquivo em vez da pasta', async () => {
    const directory = path.join(userData, 'proj-file')
    const folder = path.join(directory, 'slides', 'so-um')
    await fsp.mkdir(folder, { recursive: true })
    await fsp.writeFile(path.join(folder, 'deck.html'), deck, 'utf8')

    const ctx: ToolContext = { sessionId: 'sess1', directory, extraDirectories: [], abort: new AbortController().signal }
    const tools = createSlidesTools(ctx, { sessionId: 'sess1' })
    const report = await run(tools, 'slides_preview', { path: 'slides/so-um/deck.html' })
    expect(report).toContain('with 3 slides')
  })

  it('avisa quando o arquivo não tem <section class="slide">', async () => {
    const directory = path.join(userData, 'proj-empty')
    const folder = path.join(directory, 'slides', 'vazio')
    await fsp.mkdir(folder, { recursive: true })
    await fsp.writeFile(path.join(folder, 'index.html'), '<html><body><h1>nada</h1></body></html>', 'utf8')

    const ctx: ToolContext = { sessionId: 'sess1', directory, extraDirectories: [], abort: new AbortController().signal }
    const tools = createSlidesTools(ctx, { sessionId: 'sess1' })
    const report = await run(tools, 'slides_preview', { path: 'slides/vazio' })
    expect(report).toContain('NO slides')
  })

  it('recusa caminho fora da pasta de trabalho', async () => {
    const directory = path.join(userData, 'proj3')
    await fsp.mkdir(directory, { recursive: true })
    const ctx: ToolContext = { sessionId: 'sess1', directory, extraDirectories: [], abort: new AbortController().signal }
    const tools = createSlidesTools(ctx, { sessionId: 'sess1' })
    await expect(run(tools, 'slides_preview', { path: '../../etc' })).rejects.toThrow(/Access denied/)
  })
})

describe('slides_write (modo chat)', () => {
  it('escreve o deck no armazenamento do Orbit e relata os slides', async () => {
    const tools = createChatSlidesTools({ sessionId: 'sess1' })
    const report = await run(tools, 'slides_write', {
      title: 'Orbit em 3 slides',
      slides: [
        { title: 'Capa', html: '<h1>Orbit</h1>', notes: 'abertura' },
        { html: '<h2>Um</h2>' },
        { html: '<h2>Dois</h2>' },
      ],
    })

    expect(report).toContain('with 3 slides')
    expect(report).toContain('"Capa" (has notes)')
    expect(report).toContain('"Um"')

    const file = path.join(userData, 'orbit-data', 'slides', 'sess1', 'orbit-em-3-slides', 'index.html')
    const html = await fsp.readFile(file, 'utf8')
    expect(html).toContain('<meta name="orbit-slides" content="width=1280,height=720">')
    expect(html.match(/<section class="slide"/g)).toHaveLength(3)
    // O deck é conteúdo: nada de script nele.
    expect(html).not.toContain('<script')
  })

  it('o mesmo título reescreve o MESMO deck', async () => {
    const tools = createChatSlidesTools({ sessionId: 'sess1' })
    await run(tools, 'slides_write', { title: 'Reescrito', slides: [{ html: '<h1>A</h1>' }] })
    const second = await run(tools, 'slides_write', { title: 'Reescrito', slides: [{ html: '<h1>B</h1>' }] })

    expect(second).toContain('with 1 slide')
    const file = path.join(userData, 'orbit-data', 'slides', 'sess1', 'reescrito', 'index.html')
    const html = await fsp.readFile(file, 'utf8')
    expect(html).toContain('<h1>B</h1>')
    expect(html).not.toContain('<h1>A</h1>')
    // Um deck só na pasta.
    const folders = await fsp.readdir(path.join(userData, 'orbit-data', 'slides', 'sess1'))
    expect(folders.filter((name) => name === 'reescrito')).toHaveLength(1)
  })
})
