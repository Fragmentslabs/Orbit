import { mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

/** Espelha design-store.test.ts: `protocol.handle` é mockado, mas guarda quem
 *  chegou — é por aqui que o teste chama o scheme de verdade. */
const registered = vi.hoisted(() => ({
  handlers: new Map<string, (request: Request) => Promise<Response>>(),
}))

vi.mock('electron', async () => {
  const nodePath = await import('node:path')
  const nodeOs = await import('node:os')
  return {
    app: { getPath: () => nodePath.join(nodeOs.tmpdir(), `orbit-slides-store-test-${process.pid}`) },
    BrowserWindow: { getAllWindows: () => [] },
    protocol: {
      handle: (scheme: string, handler: (request: Request) => Promise<Response>) => {
        registered.handlers.set(scheme, handler)
      },
    },
  }
})

const {
  slidesPiecesDir,
  slidesPiecesRoot,
  deleteSlidesDeck,
  getSlides,
  isSlidesSourceChange,
  registerSlides,
  registerSlidesProtocol,
  resolveSlidesFile,
  slidesIdFor,
  slidesIdForName,
  slidesIdForPath,
  unregisterSlides,
} = await import('./slides-store')
const { SLIDES_RUNTIME_PATH, injectSlidesRuntime } = await import('./slides-runtime')

const tempRoot = path.join(os.tmpdir(), `orbit-slides-store-test-${process.pid}`)

afterAll(async () => {
  await rm(tempRoot, { recursive: true, force: true })
})

describe('resolveSlidesFile', () => {
  const folder = path.join('C:', 'orbit-data', 'slides', 'sess1', 'deck')

  it('resolve um arquivo dentro da pasta do deck', () => {
    expect(resolveSlidesFile(folder, '/index.html')).toBe(path.resolve(folder, 'index.html'))
    expect(resolveSlidesFile(folder, '/assets/fundo%20final.png')).toBe(path.resolve(folder, 'assets', 'fundo final.png'))
  })

  it('recusa `..` em qualquer posição, inclusive percent-encoded', () => {
    expect(resolveSlidesFile(folder, '../secret.html')).toBeNull()
    expect(resolveSlidesFile(folder, '/../secret.html')).toBeNull()
    expect(resolveSlidesFile(folder, '/..%2F..%2Fsecret.html')).toBeNull()
  })

  it('recusa caminho absoluto do sistema e lixo', () => {
    expect(resolveSlidesFile(folder, 'C:/Windows/System32/evil.html')).toBeNull()
    expect(resolveSlidesFile(folder, '')).toBeNull()
    expect(resolveSlidesFile(folder, '/')).toBeNull()
    expect(resolveSlidesFile(folder, '/a%00b.html')).toBeNull()
  })
})

describe('slidesIdFor', () => {
  it('é determinístico para a mesma pasta + entrada', () => {
    const a = slidesIdFor('C:/proj/slides/deck', 'C:/proj/slides/deck/index.html')
    const b = slidesIdFor('C:/proj/slides/deck', 'C:/proj/slides/deck/index.html')
    expect(a).toBe(b)
    expect(a).toMatch(/^sld_[a-z0-9]+$/)
  })

  it('difere para pastas diferentes', () => {
    expect(slidesIdFor('C:/proj/a', 'C:/proj/a/index.html')).not.toBe(
      slidesIdFor('C:/proj/b', 'C:/proj/b/index.html'),
    )
  })
})

describe('registerSlides / getSlides / unregisterSlides', () => {
  it('pasta vira o index.html dela, e a entrada pode ser explícita', async () => {
    const folder = path.join(tempRoot, 'sess1', 'deck-a')
    await mkdir(folder, { recursive: true })
    await writeFile(path.join(folder, 'index.html'), '<section class="slide"><h1>A</h1></section>', 'utf8')
    await writeFile(path.join(folder, 'outro.html'), '<section class="slide"><h1>B</h1></section>', 'utf8')

    const reg = await registerSlides(folder, { sessionId: 'sess1' })
    expect(reg.created).toBe(true)
    expect(reg.entry).toBe(path.join(folder, 'index.html'))
    expect(reg.url).toMatch(/^orbit-slides:\/\/sld_[a-z0-9]+\/index\.html$/)

    const entry = await getSlides(reg.id)
    expect(entry?.folder).toBe(path.resolve(folder))
    expect(entry?.sessionId).toBe('sess1')

    // Só o .html, quando é o arquivo que o agente apontou.
    const other = await registerSlides(path.join(folder, 'outro.html'), { sessionId: 'sess1' })
    expect(other.entry).toBe(path.join(folder, 'outro.html'))
    expect(other.id).not.toBe(reg.id)

    // Idempotente.
    const again = await registerSlides(folder, { sessionId: 'sess1' })
    expect(again.id).toBe(reg.id)
    expect(again.created).toBe(false)

    await unregisterSlides(reg.id)
    expect(await getSlides(reg.id)).toBeUndefined()
  })

  it('recusa entrada fora da pasta', async () => {
    const folder = path.join(tempRoot, 'sess1', 'deck-fora')
    await mkdir(folder, { recursive: true })
    await expect(registerSlides(folder, { entry: path.join(tempRoot, 'alheio.html') })).rejects.toThrow(/outside/)
  })
})

describe('slidesIdForName / slidesIdForPath', () => {
  it('acha pelo nome na sessão e pelo caminho, inclusive pelo fim do caminho', async () => {
    const folder = path.join(tempRoot, 'proj', 'slides', 'pitch')
    await mkdir(folder, { recursive: true })
    await writeFile(path.join(folder, 'index.html'), '<section class="slide"><h1>P</h1></section>', 'utf8')
    const { id } = await registerSlides(folder, { root: path.join(tempRoot, 'proj'), sessionId: 'sess9' })

    expect(await slidesIdForName('sess9', 'pitch')).toBe(id)
    expect(await slidesIdForName('sess9', 'outro')).toBeNull()
    expect(await slidesIdForName('sess2', 'pitch')).toBeNull()

    expect(await slidesIdForPath(folder)).toBe(id)
    expect(await slidesIdForPath(path.join(folder, 'index.html'))).toBe(id)
    expect(await slidesIdForPath('slides/pitch')).toBe(id)
    expect(await slidesIdForPath('slides/nada')).toBeNull()
  })

  it('o TÍTULO do card acha a pasta pelo slug (chat)', async () => {
    const folder = path.join(tempRoot, 'sess-titulo', 'orbit-em-12-slides')
    await mkdir(folder, { recursive: true })
    await writeFile(path.join(folder, 'index.html'), '<section class="slide"><h1>T</h1></section>', 'utf8')
    const { id } = await registerSlides(folder, { sessionId: 'sessT' })

    // O card manda o título como o usuário o escreveu; a pasta é o slug.
    expect(await slidesIdForName('sessT', 'Orbit em 12 slides')).toBe(id)
    expect(await slidesIdForName('sessT', 'Orbit em 12 Slides')).toBe(id)
    expect(await slidesIdForName('sessT', 'Outro deck')).toBeNull()
  })
})

describe('injectSlidesRuntime', () => {
  it('põe o runtime antes do conteúdo, uma vez só, e não toca no body', () => {
    const html = '<!doctype html><html><head><title>t</title></head><body><h1>Oi</h1></body></html>'
    const out = injectSlidesRuntime(html)
    expect(out.indexOf(SLIDES_RUNTIME_PATH)).toBeLessThan(out.indexOf('<title>'))
    expect(out).toContain('<body><h1>Oi</h1></body>')
    expect(injectSlidesRuntime(out)).toBe(out)
  })

  it('cria o <head> quando falta, e cobre o fragmento solto', () => {
    expect(injectSlidesRuntime('<html><body>x</body></html>')).toMatch(/^<html><head><script [^>]+><\/script><\/head><body>x/)
    expect(injectSlidesRuntime('<div>x</div>')).toMatch(/^<script [^>]+><\/script><div>x<\/div>$/)
  })
})

describe('registerSlidesProtocol', () => {
  it('serve o deck com o runtime e devolve o fonte cru em ?raw', async () => {
    const folder = path.join(tempRoot, 'sess1', 'proto-deck')
    await mkdir(folder, { recursive: true })
    await writeFile(path.join(folder, 'index.html'), '<!doctype html><title>t</title><body>slide</body>', 'utf8')

    registerSlidesProtocol()
    const handler = registered.handlers.get('orbit-slides')
    expect(handler).toBeTypeOf('function')

    const { id } = await registerSlides(folder, { sessionId: 'sess1' })

    const served = await handler!(new Request(`orbit-slides://${id}/index.html`))
    expect(served.status).toBe(200)
    expect(served.headers.get('Content-Type')).toContain('text/html')
    expect(await served.text()).toContain(SLIDES_RUNTIME_PATH)

    const raw = await handler!(new Request(`orbit-slides://${id}/index.html?raw=1`))
    expect(raw.status).toBe(200)
    expect(await raw.text()).toBe('<!doctype html><title>t</title><body>slide</body>')

    const runtime = await handler!(new Request(`orbit-slides://${id}${SLIDES_RUNTIME_PATH}`))
    expect(runtime.status).toBe(200)
    expect(runtime.headers.get('Content-Type')).toContain('javascript')
    expect(await runtime.text()).toContain('orbit-slides')

    // Id que não existe e escape de pasta: 404, nunca o arquivo.
    expect((await handler!(new Request('orbit-slides://sld_nope/index.html'))).status).toBe(404)
    expect((await handler!(new Request(`orbit-slides://${id}/../secret.html`))).status).toBe(404)
  })
})

describe('isSlidesSourceChange', () => {
  it('ignora exportações e temporários, aceita o que é fonte', () => {
    expect(isSlidesSourceChange('index.html')).toBe(true)
    expect(isSlidesSourceChange('assets/fundo.png')).toBe(true)
    expect(isSlidesSourceChange('deck.pdf')).toBe(false)
    expect(isSlidesSourceChange('render.mp4')).toBe(false)
    expect(isSlidesSourceChange('.slides-tmp/index.html')).toBe(false)
    expect(isSlidesSourceChange(null)).toBe(true)
  })
})

describe('slidesPiecesDir / deleteSlidesDeck', () => {
  const stat = async (target: string) => (await import('node:fs/promises')).stat(target)

  async function deckAt(folder: string, opts: { root?: string } = {}) {
    await mkdir(folder, { recursive: true })
    await writeFile(path.join(folder, 'index.html'), '<section class="slide"><h1>X</h1></section>', 'utf8')
    return registerSlides(folder, { ...opts, sessionId: 'sess-del' })
  }

  it('a pasta do chat fica sob a raiz do app, com o id da sessão validado', () => {
    expect(slidesPiecesDir('sess-del')).toBe(path.join(slidesPiecesRoot(), 'sess-del'))
    expect(() => slidesPiecesDir('../fuga')).toThrow(/invalid session id/)
  })

  it('apaga a pasta de um deck do chat, e o registro vai junto', async () => {
    const reg = await deckAt(slidesPiecesDir('sess-del'))
    const out = await deleteSlidesDeck(reg.id)
    expect(out.removedFolder).toBe(true)
    expect(await getSlides(reg.id)).toBeUndefined()
    await expect(stat(reg.folder)).rejects.toBeTruthy()
  })

  it('apaga a pasta do deck DENTRO do projeto, nunca o projeto', async () => {
    const project = path.join(tempRoot, 'projeto')
    const reg = await deckAt(path.join(project, 'slides', 'deck'), { root: project })
    expect((await deleteSlidesDeck(reg.id)).removedFolder).toBe(true)
    // O projeto continua de pé — é o que separa "liberar espaço" de "destruir".
    expect((await stat(project)).isDirectory()).toBe(true)
  })

  it('recusa apagar a raiz do projeto, mas esquece o registro', async () => {
    const project = path.join(tempRoot, 'projeto-raiz')
    await mkdir(project, { recursive: true })
    await writeFile(path.join(project, 'index.html'), '<section class="slide"><h1>X</h1></section>', 'utf8')
    const reg = await registerSlides(project, { root: project, sessionId: 'sess-del' })
    const out = await deleteSlidesDeck(reg.id)
    expect(out.removedFolder).toBe(false)
    expect(out.keptBecause).toContain('project itself')
    expect((await stat(project)).isDirectory()).toBe(true)
    expect(await getSlides(reg.id)).toBeUndefined()
  })

  it('deck fora do registro não apaga nada', async () => {
    expect(await deleteSlidesDeck('sld_nada')).toEqual({ removedFolder: false, keptBecause: 'not registered' })
  })
})
