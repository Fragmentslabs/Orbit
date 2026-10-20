import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

/**
 * Design no MODO CHAT, sem pasta: o canvas mora no armazenamento do app e
 * entra na galeria — espelha video-chat.test.ts (o mock de 'electron' é o
 * mesmo molde, sem ffmpeg nenhum envolvido aqui).
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

// design_asset copia um ANEXO para a pasta do canvas — o resolvedor de
// referências (e o ffmpeg, que ele alcança para vídeo) é o mesmo do
// motion-asset.test.ts, mockado aqui do mesmo jeito.
const resolved: Record<string, { kind: string; id: string; file: string; name: string }> = {}
vi.mock('../attachment-ref', () => ({
  resolveAttachmentRef: async (ref: string) => resolved[ref.replace(/^ref\s+/, '')] ?? null,
}))
vi.mock('../video/ffmpeg', () => ({
  probeMedia: async () => {
    throw new Error('no ffmpeg in this test')
  },
}))

const { chatDesignDir, createChatDesignTools, designSlug } = await import('./design-chat')

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

describe('chatDesignDir', () => {
  it('refuses a session id that could escape the folder', () => {
    expect(() => chatDesignDir('../outro')).toThrow(/invalid session/)
    expect(chatDesignDir('sess1')).toContain('sess1')
  })
})

describe('createChatDesignTools — design_write / design_read / design_edit', () => {
  const tools = createChatDesignTools({ sessionId: 'sess1' })
  const folder = path.join(chatDesignDir('sess1'), 'landing')

  it('design_write creates the canvas.json and each artboard file', async () => {
    const report = await run(tools, 'design_write', {
      name: 'Landing',
      title: 'Landing page',
      boards: [
        { file: 'Main.html', title: 'Hero', x: 0, y: 0, w: 1280, h: 800, html: '<!doctype html><title>Hero</title><body>Hi</body>' },
        { file: 'Pricing.html', x: 1360, y: 0, w: 1280, h: 800, html: '<!doctype html><title>Pricing</title><body>$9</body>' },
      ],
    })
    // O relatório usa o SLUG da pasta (como o motion), não a grafia original.
    expect(report).toContain('Design "landing" is open in the Design tab')
    expect(report).toContain('with 2 artboards')
    // "Main.html" tem título ("Hero"), então aparece como "Hero" (Main.html, …).
    expect(report).toContain('"Hero" (Main.html,')
    expect(report).toContain('"Pricing.html" (Pricing.html,')

    const canvas = JSON.parse(await fsp.readFile(path.join(folder, 'canvas.json'), 'utf8'))
    expect(canvas.order).toEqual(['Main.html', 'Pricing.html'])
    expect(canvas.boards['Main.html']).toMatchObject({ title: 'Hero', x: 0, y: 0, w: 1280, h: 800 })
    expect(await fsp.readFile(path.join(folder, 'Main.html'), 'utf8')).toContain('Hi')
  })

  it('rejects an artboard file name that is not a plain .html name', async () => {
    await expect(
      run(tools, 'design_write', {
        name: 'Bad',
        boards: [{ file: '../escape.html', x: 0, y: 0, w: 100, h: 100, html: '<html></html>' }],
      }),
    ).rejects.toThrow(/invalid artboard file name/)
  })

  it('design_read returns the layout, and one artboard\'s HTML', async () => {
    const layout = await run(tools, 'design_read', { name: 'Landing' })
    expect(JSON.parse(layout).order).toEqual(['Main.html', 'Pricing.html'])

    const html = await run(tools, 'design_read', { name: 'Landing', file: 'Main.html' })
    expect(html).toContain('Hi')
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

describe('createChatDesignTools — design_asset', () => {
  it('copies an attached photo into the canvas folder and hints the relative src', async () => {
    const source = path.join(userData, 'orig.png')
    await fsp.writeFile(source, 'PNG')
    resolved['img_ab1.png'] = { kind: 'image', id: 'img_ab1.png', file: source, name: 'Foto da equipe.png' }

    const tools = createChatDesignTools({ sessionId: 'sess1' })
    const report = await run(tools, 'design_asset', { ref: 'img_ab1.png', name: 'Moodboard' })

    expect(report).toContain('Copied: image "Foto da equipe.png" → Foto-da-equipe.png')
    expect(report).toContain('<img src="Foto-da-equipe.png">')
    const folder = path.join(chatDesignDir('sess1'), 'moodboard')
    expect(await fsp.readFile(path.join(folder, 'Foto-da-equipe.png'), 'utf8')).toBe('PNG')
  })

  it('design_asset refuses a ref that is not an attachment', async () => {
    const tools = createChatDesignTools({ sessionId: 'sess1' })
    await expect(run(tools, 'design_asset', { ref: 'img_naoexiste.png', name: 'Moodboard' })).rejects.toThrow(
      /attachment not found/,
    )
  })
})
