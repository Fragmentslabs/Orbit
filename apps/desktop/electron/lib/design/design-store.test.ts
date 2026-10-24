import { mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

/** Espelha motion-store.test.ts: `protocol.handle` é mockado, mas guarda quem
 *  chegou — é por aqui que o teste chama o scheme de verdade. `windows` são as
 *  janelas que recebem o design:changed (o teste do watcher põe uma e lê o
 *  payload que a aba Design usa para recarregar só o artboard que mudou). */
const registered = vi.hoisted(() => ({
  handlers: new Map<string, (request: Request) => Promise<Response>>(),
  windows: [] as Array<{ isDestroyed: () => boolean; webContents: { send: (channel: string, payload: unknown) => void } }>,
}))

// O módulo toca em `app`/`protocol`/`BrowserWindow` (é do main). O índice cai
// numa pasta temporária e nenhum protocolo real é registrado.
vi.mock('electron', async () => {
  const nodePath = await import('node:path')
  const nodeOs = await import('node:os')
  return {
    app: { getPath: () => nodePath.join(nodeOs.tmpdir(), `orbit-design-store-test-${process.pid}`) },
    BrowserWindow: { getAllWindows: () => registered.windows },
    protocol: {
      handle: (scheme: string, handler: (request: Request) => Promise<Response>) => {
        registered.handlers.set(scheme, handler)
      },
    },
  }
})

const {
  designIdFor,
  designIdForName,
  designIdForPath,
  getDesign,
  readDesignBoard,
  registerDesign,
  registerDesignProtocol,
  resolveDesignFile,
  unregisterDesign,
  updateDesignBoard,
  writeDesignBoard,
} = await import('./design-store')
const { DESIGN_RUNTIME_PATH, injectDesignRuntime } = await import('./design-runtime')

const tempRoot = path.join(os.tmpdir(), `orbit-design-store-test-${process.pid}`)

afterAll(async () => {
  await rm(tempRoot, { recursive: true, force: true })
})

describe('resolveDesignFile', () => {
  const folder = path.join('C:', 'orbit-data', 'design', 'sess1', 'landing')

  it('resolves a file inside the canvas folder', () => {
    expect(resolveDesignFile(folder, '/canvas.json')).toBe(path.resolve(folder, 'canvas.json'))
    expect(resolveDesignFile(folder, '/Main.html')).toBe(path.resolve(folder, 'Main.html'))
    expect(resolveDesignFile(folder, '/assets/logo%20final.svg')).toBe(path.resolve(folder, 'assets', 'logo final.svg'))
  })

  it('rejects `..` in any position, even percent-encoded', () => {
    expect(resolveDesignFile(folder, '../secret.html')).toBeNull()
    expect(resolveDesignFile(folder, '/../secret.html')).toBeNull()
    expect(resolveDesignFile(folder, '/..%2F..%2Fsecret.html')).toBeNull()
  })

  it('rejects an absolute OS path and junk', () => {
    expect(resolveDesignFile(folder, 'C:/Windows/System32/evil.html')).toBeNull()
    expect(resolveDesignFile(folder, '')).toBeNull()
    expect(resolveDesignFile(folder, '/')).toBeNull()
    expect(resolveDesignFile(folder, '/a%00b.html')).toBeNull()
  })
})

describe('designIdFor', () => {
  it('é determinístico e estável para a mesma pasta', () => {
    const a = designIdFor('C:/proj/design/landing')
    const b = designIdFor('C:/proj/design/landing')
    expect(a).toBe(b)
    expect(a).toMatch(/^dsg_[a-z0-9]+$/)
  })

  it('difere para pastas diferentes', () => {
    expect(designIdFor('C:/proj/design/a')).not.toBe(designIdFor('C:/proj/design/b'))
  })
})

describe('registerDesign / getDesign / designIdForName / unregisterDesign', () => {
  it('registra, encontra pelo nome na sessão e desfaz', async () => {
    const folder = path.join(tempRoot, 'sess1', 'landing-page')
    await mkdir(folder, { recursive: true })
    await writeFile(path.join(folder, 'canvas.json'), '{"v":1,"boards":{},"order":[]}', 'utf8')

    const { id, created } = await registerDesign(folder, { sessionId: 'sess1' })
    expect(created).toBe(true)
    expect(id).toBe(designIdFor(folder))

    const entry = await getDesign(id)
    expect(entry?.folder).toBe(path.resolve(folder))
    expect(entry?.sessionId).toBe('sess1')

    const foundId = await designIdForName('sess1', 'landing-page')
    expect(foundId).toBe(id)
    // Outra sessão não acha o mesmo canvas.
    expect(await designIdForName('sess2', 'landing-page')).toBeNull()

    // Registrar de novo é idempotente: mesmo id.
    const again = await registerDesign(folder, { sessionId: 'sess1' })
    expect(again.id).toBe(id)
    expect(again.created).toBe(false)

    await unregisterDesign(id)
    expect(await getDesign(id)).toBeUndefined()
  })
})

describe('designIdForPath', () => {
  it('encontra pelo caminho exato, e pelo fim do caminho quando o exato não resolve', async () => {
    const folder = path.join(tempRoot, 'proj', 'design', 'logo')
    await mkdir(folder, { recursive: true })
    await writeFile(path.join(folder, 'canvas.json'), '{"v":1,"boards":{},"order":[]}', 'utf8')
    const { id } = await registerDesign(folder, { root: path.join(tempRoot, 'proj') })

    expect(await designIdForPath(folder)).toBe(id)
    // Caminho relativo que não resolve contra o cwd do app: cai no fim do caminho.
    expect(await designIdForPath('design/logo')).toBe(id)
    expect(await designIdForPath('design/outro')).toBeNull()
  })
})

describe('injectDesignRuntime', () => {
  it('põe a ponte no <head> sem tocar no <body>, uma vez só', () => {
    const html = '<!doctype html><html><head><title>t</title></head><body><h1>Oi</h1></body></html>'
    const out = injectDesignRuntime(html)
    expect(out.indexOf(DESIGN_RUNTIME_PATH)).toBeLessThan(out.indexOf('<title>'))
    expect(out).toContain('<body><h1>Oi</h1></body>')
    expect(injectDesignRuntime(out)).toBe(out)
  })

  it('cria o <head> quando falta, e cobre o fragmento solto', () => {
    expect(injectDesignRuntime('<html><body>x</body></html>')).toMatch(/^<html><head><script [^>]+><\/script><\/head><body>x/)
    expect(injectDesignRuntime('<div>x</div>')).toMatch(/^<script [^>]+><\/script><div>x<\/div>$/)
  })
})

describe('writeDesignBoard / readDesignBoard / updateDesignBoard', () => {
  it('grava o artboard e o arranjo, com as travas de nome e de limites', async () => {
    const folder = path.join(tempRoot, 'sess1', 'edit-canvas')
    await mkdir(folder, { recursive: true })
    await writeFile(
      path.join(folder, 'canvas.json'),
      JSON.stringify({ v: 1, boards: { 'Main.html': { x: 0, y: 0, w: 800, h: 600 } }, order: ['Main.html'] }),
      'utf8',
    )
    await writeFile(path.join(folder, 'Main.html'), '<p>a</p>', 'utf8')
    const { id } = await registerDesign(folder, { sessionId: 'sess1' })

    await writeDesignBoard(id, 'Main.html', '<p>b</p>')
    expect(await readDesignBoard(id, 'Main.html')).toBe('<p>b</p>')
    await expect(writeDesignBoard(id, '../escape.html', 'x')).rejects.toThrow(/invalid artboard/)
    await expect(writeDesignBoard('dsg_nope', 'Main.html', 'x')).rejects.toThrow(/unknown design/)

    await updateDesignBoard(id, 'Main.html', { x: 120.4, y: -40, w: 10, h: 99_999, title: 'Hero' })
    const { readDesignCanvas } = await import('./design-canvas')
    const canvas = await readDesignCanvas(folder)
    // w/h presos aos limites do canvas (40–8000), posição arredondada.
    expect(canvas.boards['Main.html']).toEqual({ x: 120, y: -40, w: 40, h: 8000, title: 'Hero' })
    await expect(updateDesignBoard(id, 'Other.html', { x: 1 })).rejects.toThrow(/not in canvas.json/)
  })
})

describe('registerDesignProtocol', () => {
  it('serve canvas.json e um artboard, e recusa o que está fora da pasta', async () => {
    const folder = path.join(tempRoot, 'sess1', 'proto-canvas')
    await mkdir(folder, { recursive: true })
    await writeFile(path.join(folder, 'canvas.json'), '{"v":1,"boards":{"Main.html":{"x":0,"y":0,"w":800,"h":600}},"order":["Main.html"]}', 'utf8')
    await writeFile(path.join(folder, 'Main.html'), '<!doctype html><title>t</title><body>hi</body>', 'utf8')
    // Folha compartilhada: um <link rel="stylesheet" href="base.css"> dentro do
    // artboard resolve aqui, com o tipo certo.
    await writeFile(path.join(folder, 'base.css'), ':root{--gap:8px}', 'utf8')

    registerDesignProtocol()
    const handler = registered.handlers.get('orbit-design')
    expect(handler).toBeTypeOf('function')

    const { id } = await registerDesign(folder, { sessionId: 'sess1' })

    const indexRes = await handler!(new Request(`orbit-design://${id}/canvas.json`))
    expect(indexRes.status).toBe(200)
    expect(await indexRes.text()).toContain('"Main.html"')

    const cssRes = await handler!(new Request(`orbit-design://${id}/base.css`))
    expect(cssRes.status).toBe(200)
    expect(cssRes.headers.get('Content-Type')).toContain('text/css')
    expect(await cssRes.text()).toBe(':root{--gap:8px}')

    const boardRes = await handler!(new Request(`orbit-design://${id}/Main.html`))
    expect(boardRes.status).toBe(200)
    expect(boardRes.headers.get('Content-Type')).toContain('text/html')
    const served = await boardRes.text()
    expect(served).toContain('hi')
    // O artboard sai com a ponte do editor; `?raw` é o fonte como está no disco.
    // O URL da ponte leva a versão dela (é o que deixa o cache ser imutável).
    expect(served).toContain(`${DESIGN_RUNTIME_PATH}?v=`)

    // ETag + revalidação: remontar um artboard sem mudança vira 304 sem corpo.
    const etag = boardRes.headers.get('ETag')
    expect(etag).toBeTruthy()
    expect(boardRes.headers.get('Cache-Control')).toBe('no-cache')
    const notModified = await handler!(new Request(`orbit-design://${id}/Main.html`, { headers: { 'If-None-Match': etag! } }))
    expect(notModified.status).toBe(304)

    const raw = await (await handler!(new Request(`orbit-design://${id}/Main.html?raw=1`))).text()
    expect(raw).not.toContain(DESIGN_RUNTIME_PATH)
    expect(raw).toBe('<!doctype html><title>t</title><body>hi</body>')

    // Mudou o arquivo: o etag antigo não vale mais e o corpo novo vem inteiro.
    await writeFile(path.join(folder, 'Main.html'), '<!doctype html><title>t</title><body>hi 2</body>', 'utf8')
    const changed = await handler!(new Request(`orbit-design://${id}/Main.html`, { headers: { 'If-None-Match': etag! } }))
    expect(changed.status).toBe(200)
    expect(await changed.text()).toContain('hi 2')

    const runtime = await handler!(new Request(`orbit-design://${id}${DESIGN_RUNTIME_PATH}`))
    expect(runtime.status).toBe(200)
    expect(runtime.headers.get('Content-Type')).toContain('javascript')
    // A ponte é constante do build e o URL dela carrega a versão.
    expect(runtime.headers.get('Cache-Control')).toContain('immutable')
    expect(await runtime.text()).toContain('orbit-design')

    const missing = await handler!(new Request(`orbit-design://${id}/nope.html`))
    expect(missing.status).toBe(404)

    const unknownId = await handler!(new Request('orbit-design://dsg_doesnotexist/canvas.json'))
    expect(unknownId.status).toBe(404)
  })
})

describe('watcher', () => {
  it('avisa a janela com os ARQUIVOS que mudaram (a aba recarrega só eles)', async () => {
    const folder = path.join(tempRoot, 'sess1', 'watch-canvas')
    await mkdir(folder, { recursive: true })
    await writeFile(path.join(folder, 'canvas.json'), '{"v":1,"boards":{},"order":[]}', 'utf8')
    const { id } = await registerDesign(folder, { sessionId: 'sess1' })

    const sent: Array<{ id: string; files?: string[] }> = []
    registered.windows.push({
      isDestroyed: () => false,
      webContents: { send: (_channel, payload) => sent.push(payload as { id: string; files?: string[] }) },
    })
    try {
      await writeFile(path.join(folder, 'Main.html'), '<p>a</p>', 'utf8')
      // O debounce do watcher é 150 ms (teto de 400 numa rajada): espera o
      // payload CHEGAR em vez de dormir um valor fixo — o fs.watch pode atrasar
      // sob carga e uma espera curta deixa o teste instável.
      const deadline = Date.now() + 3000
      while (Date.now() < deadline && !sent.some((item) => item.id === id)) {
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
    } finally {
      registered.windows.length = 0
    }

    const payload = sent.find((item) => item.id === id)
    expect(payload?.files).toContain('Main.html')
  })
})
