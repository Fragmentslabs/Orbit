import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { ToolContext } from './context'

/**
 * Slides — as mesmas tools nos dois modos: o deck mora no armazenamento do
 * Orbit e é escrito (slides ou html), editado, lido, mostrado, alimentado com
 * assets e excluído pelo nome. Espelha o mock de design.test.ts.
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
<section class="slide" data-title="Capa"><h1>Orbit</h1><aside class="notes">abre curto</aside></section>
<section class="slide"><h2>Problema</h2></section>
<section class="slide"><h2>Fim</h2></section>
</body></html>`

const deckFile = (session: string, slug: string) => path.join(userData, 'orbit-data', 'slides', session, slug, 'index.html')

afterAll(async () => {
  await fsp.rm(userData, { recursive: true, force: true })
})

describe('slides_write', () => {
  it('escreve o deck no armazenamento do Orbit e relata os slides', async () => {
    const tools = createSlidesTools({ sessionId: 'sess1' })
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

    const html = await fsp.readFile(deckFile('sess1', 'orbit-em-3-slides'), 'utf8')
    expect(html).toContain('<meta name="orbit-slides" content="width=1280,height=720">')
    expect(html.match(/<section class="slide"/g)).toHaveLength(3)
    // O deck é conteúdo: nada de script nele.
    expect(html).not.toContain('<script')
  })

  it('o mesmo título reescreve o MESMO deck', async () => {
    const tools = createSlidesTools({ sessionId: 'sess1' })
    await run(tools, 'slides_write', { title: 'Reescrito', slides: [{ html: '<h1>A</h1>' }] })
    const second = await run(tools, 'slides_write', { title: 'Reescrito', slides: [{ html: '<h1>B</h1>' }] })

    expect(second).toContain('with 1 slide')
    const html = await fsp.readFile(deckFile('sess1', 'reescrito'), 'utf8')
    expect(html).toContain('<h1>B</h1>')
    expect(html).not.toContain('<h1>A</h1>')
    // Um deck só na pasta.
    const folders = await fsp.readdir(path.join(userData, 'orbit-data', 'slides', 'sess1'))
    expect(folders.filter((name) => name === 'reescrito')).toHaveLength(1)
  })

  it('aceita o documento inteiro (tema próprio) no lugar dos slides', async () => {
    const tools = createSlidesTools({ sessionId: 'sess1' })
    const report = await run(tools, 'slides_write', { title: 'Pitch', html: deck })
    expect(report).toContain('with 3 slides')
    expect(report).toContain('1 of them have presenter notes')
    expect(await fsp.readFile(deckFile('sess1', 'pitch'), 'utf8')).toBe(deck)
  })

  it('recusa os dois formatos juntos, nenhum, ou um deck sem <section class="slide">', async () => {
    const tools = createSlidesTools({ sessionId: 'sess1' })
    await expect(run(tools, 'slides_write', { title: 'X', html: deck, slides: [{ html: '<h1>A</h1>' }] })).rejects.toThrow(/exactly one/)
    await expect(run(tools, 'slides_write', { title: 'X' })).rejects.toThrow(/exactly one/)
    await expect(run(tools, 'slides_write', { title: 'X', html: '<html><body><h1>nada</h1></body></html>' })).rejects.toThrow(
      /no <section class="slide">/,
    )
  })
})

describe('slides_edit / slides_read / slides_preview', () => {
  it('troca um trecho exato e o deck continua com os mesmos slides', async () => {
    const tools = createSlidesTools({ sessionId: 'sess2' })
    await run(tools, 'slides_write', { title: 'Pitch', html: deck })
    const report = await run(tools, 'slides_edit', { name: 'Pitch', edits: [{ oldText: '<h2>Problema</h2>', newText: '<h2>Dor</h2>' }] })
    expect(report).toContain('1 edit applied')
    expect(report).toContain('"Dor"')
    expect(await run(tools, 'slides_read', { name: 'Pitch' })).toContain('<h2>Dor</h2>')
  })

  it('recusa um edit que deixaria o deck sem slides, sem gravar nada', async () => {
    const tools = createSlidesTools({ sessionId: 'sess2' })
    const before = await run(tools, 'slides_read', { name: 'Pitch' })
    await expect(
      run(tools, 'slides_edit', { name: 'Pitch', edits: [{ oldText: 'class="slide"', newText: 'class="x"', replaceAll: true }] }),
    ).rejects.toThrow(/no <section class="slide">/)
    expect(await run(tools, 'slides_read', { name: 'Pitch' })).toBe(before)
  })

  it('slides_preview reabre um deck que existe e recusa um que não existe', async () => {
    const tools = createSlidesTools({ sessionId: 'sess2' })
    expect(await run(tools, 'slides_preview', { name: 'Pitch' })).toContain('is open in the Slides tab')
    await expect(run(tools, 'slides_preview', { name: 'Nenhum' })).rejects.toThrow(/no deck named "nenhum"/)
  })
})

describe('slides_asset / slides_delete / modo plano', () => {
  it('no código, copia um arquivo da pasta de trabalho para dentro do deck', async () => {
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

  it('no chat, `path` não existe — o material entra pela referência do anexo', async () => {
    const tools = createSlidesTools({ sessionId: 'sess3' })
    await expect(run(tools, 'slides_asset', { name: 'Relatorio', path: 'docs/grafico.png' })).rejects.toThrow(/needs a working folder/)
  })

  it('slides_delete apaga a pasta do deck', async () => {
    const tools = createSlidesTools({ sessionId: 'sess3' })
    const report = await run(tools, 'slides_delete', { name: 'Relatorio' })
    expect(report).toContain('deleted')
    await expect(fsp.stat(path.dirname(deckFile('sess3', 'relatorio')))).rejects.toThrow()
  })

  it('modo plano: só ler e mostrar', () => {
    const tools = createSlidesTools({ sessionId: 'sess3', readOnly: true })
    expect(Object.keys(tools).sort()).toEqual(['slides_preview', 'slides_read'])
  })
})
