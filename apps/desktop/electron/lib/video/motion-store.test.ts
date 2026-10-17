import { mkdtemp, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

/** O handler que o módulo registrou: `protocol.handle` é mockado, mas guarda
 *  quem chegou — é por aqui que os testes chamam o scheme de verdade. */
const registered = vi.hoisted(() => ({
  handlers: new Map<string, (request: Request) => Promise<Response>>(),
}))

// O módulo toca em `app`/`protocol` (é do main). O índice cai numa pasta
// temporária e nenhum protocolo real é registrado.
vi.mock('electron', async () => {
  const nodePath = await import('node:path')
  const nodeOs = await import('node:os')
  return {
    app: { getPath: () => nodePath.join(nodeOs.tmpdir(), `orbit-motion-store-test-${process.pid}`) },
    BrowserWindow: { getAllWindows: () => [] },
    protocol: {
      handle: (scheme: string, handler: (request: Request) => Promise<Response>) => {
        registered.handlers.set(scheme, handler)
      },
    },
  }
})

const {
  deleteMotionComposition,
  getMotion,
  isMotionSourceChange,
  motionIdFor,
  motionIdForName,
  motionIdForPath,
  registerMotion,
  registerMotionProtocol,
  resolveMotionFile,
  unregisterMotion,
} = await import('./motion-store')

const tempRoot = path.join(os.tmpdir(), `orbit-motion-store-test-${process.pid}`)

afterAll(async () => {
  await rm(tempRoot, { recursive: true, force: true })
})

describe('resolveMotionFile', () => {
  const folder = path.join('C:', 'proj', 'edit', 'motion', 'title')

  it('resolves a file inside the composition folder', () => {
    expect(resolveMotionFile(folder, '/title.html')).toBe(path.resolve(folder, 'title.html'))
    expect(resolveMotionFile(folder, '/assets/gsap.min.js')).toBe(path.resolve(folder, 'assets', 'gsap.min.js'))
    // O pathname chega percent-encoded.
    expect(resolveMotionFile(folder, '/assets/fonte%20bold.woff2')).toBe(path.resolve(folder, 'assets', 'fonte bold.woff2'))
  })

  it('rejects `..` in any position, even percent-encoded', () => {
    expect(resolveMotionFile(folder, '../secret.html')).toBeNull()
    expect(resolveMotionFile(folder, '/../secret.html')).toBeNull()
    expect(resolveMotionFile(folder, '/assets/../../secret.html')).toBeNull()
    expect(resolveMotionFile(folder, '/..%2F..%2Fsecret.html')).toBeNull()
    expect(resolveMotionFile(folder, '/..\\..\\secret.html')).toBeNull()
  })

  it('rejects an absolute OS path and junk', () => {
    expect(resolveMotionFile(folder, 'C:/Windows/System32/evil.html')).toBeNull()
    expect(resolveMotionFile(folder, '/C:/Windows/evil.html')).toBeNull()
    expect(resolveMotionFile(folder, '/c:\\windows\\evil.html')).toBeNull()
    expect(resolveMotionFile(folder, '')).toBeNull()
    expect(resolveMotionFile(folder, '/')).toBeNull()
    expect(resolveMotionFile(folder, '/a%00b.html')).toBeNull()
  })
})

describe('isMotionSourceChange', () => {
  it('reloads for the composition sources and ignores renders and temp folders', () => {
    expect(isMotionSourceChange('index.html')).toBe(true)
    expect(isMotionSourceChange('assets\\font.woff2')).toBe(true)
    expect(isMotionSourceChange('hero.png')).toBe(true)
    expect(isMotionSourceChange(null)).toBe(true)
    expect(isMotionSourceChange('motion.mp4')).toBe(false)
    expect(isMotionSourceChange('final.MOV')).toBe(false)
    expect(isMotionSourceChange('.motion-abc123\\band_000.mp4')).toBe(false)
    expect(isMotionSourceChange('.motion-abc123/list.txt')).toBe(false)
  })
})

describe('motionIdForName — a peça da conversa, endereçada por nome', () => {
  it('encontra pela pasta que leva o slug do nome, dentro da sessão', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'orbit-motion-chat-'))
    const folder = path.join(root, 'intro-do-orbit')
    await mkdir(folder, { recursive: true })
    const file = path.join(folder, 'index.html')
    await writeFile(file, '<head></head>')
    const { id } = await registerMotion(folder, file, { sessionId: 'chat-a' })

    expect(await motionIdForName('chat-a', 'intro-do-orbit')).toBe(id)
    expect(await motionIdForName('chat-a', 'INTRO-DO-ORBIT')).toBe(id)
    // O mesmo nome em outra conversa é OUTRA peça: sem a sessão na chave, o card
    // de uma conversa abriria a composição da outra.
    expect(await motionIdForName('chat-b', 'intro-do-orbit')).toBeNull()
    expect(await motionIdForName('chat-a', 'outra')).toBeNull()
    expect(await motionIdForName('chat-a', '   ')).toBeNull()

    await unregisterMotion(id)
    await rm(root, { recursive: true, force: true })
  })
})

describe('motionIdForPath — o caminho que a tool recebeu', () => {
  it('casa pelo fim do caminho quando ele vem relativo à pasta da sessão', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'orbit-motion-rel-'))
    const folder = path.join(root, 'edit', 'animations', 'orbit-apresentacao')
    await mkdir(folder, { recursive: true })
    const file = path.join(folder, 'index.html')
    await writeFile(file, '<head></head>')
    const { id } = await registerMotion(folder, file, { sessionId: 'chat-a' })

    // Absoluto: exato, como sempre.
    expect(await motionIdForPath(file)).toBe(id)
    expect(await motionIdForPath(folder)).toBe(id)
    // Relativo à pasta da sessão — o que o agente realmente passa à tool, e que
    // o main não tem como resolver (não conhece a pasta da sessão).
    expect(await motionIdForPath('edit/animations/orbit-apresentacao/index.html')).toBe(id)
    expect(await motionIdForPath('edit/animations/orbit-apresentacao')).toBe(id)
    // Um pedaço sem pasta nenhuma não identifica peça: nada de casar por nome
    // solto no meio de um caminho maior.
    expect(await motionIdForPath('presentacao')).toBeNull()

    await unregisterMotion(id)
    await rm(root, { recursive: true, force: true })
  })
})

describe('registro', () => {
  it('registers a composition, reuses it and releases it on unregister', async () => {
    const folder = await mkdtemp(path.join(os.tmpdir(), 'orbit-motion-comp-'))
    await mkdir(path.join(folder, 'assets'), { recursive: true })
    await writeFile(path.join(folder, 'title.html'), '<head></head>')
    await writeFile(path.join(folder, 'assets', 'gsap.min.js'), '')

    const { id, url } = await registerMotion(folder, path.join(folder, 'title.html'), { root: os.tmpdir() })
    expect(id).toMatch(/^mv_[a-z0-9]+$/)
    expect(url).toBe(`orbit-motion://${id}/title.html`)

    const entry = await getMotion(id)
    expect(entry?.folder).toBe(path.resolve(folder))
    expect(entry?.entry).toBe(path.resolve(folder, 'title.html'))
    expect(entry?.root).toBe(path.resolve(os.tmpdir()))

    // Mesma pasta + mesma sessão: reaproveita o id — inclusive quando só o
    // caminho da entrada é passado (o painel não sabe da pasta).
    const again = await registerMotion(folder, path.join(folder, 'title.html'), { root: os.tmpdir() })
    expect(again.id).toBe(id)
    const onlyEntry = await registerMotion(path.join(folder, 'title.html'), undefined, { root: os.tmpdir() })
    expect(onlyEntry.id).toBe(id)
    expect(onlyEntry.url).toBe(url)

    await unregisterMotion(id)
    expect(await getMotion(id)).toBeUndefined()
    await rm(folder, { recursive: true, force: true })
  })

  it('keeps the SAME id across sessions and only reports `created` the first time', async () => {
    // Era o 404 da aba: o render registrava a mesma composição, recebia o id do
    // preview e o liberava no fim. Agora o id vem da pasta + entrada, e quem não
    // criou o registro fica sabendo (created: false) para não liberá-lo.
    const folder = await mkdtemp(path.join(os.tmpdir(), 'orbit-motion-comp-'))
    const file = path.join(folder, 'index.html')
    await writeFile(file, '<head></head>')
    const first = await registerMotion(folder, file, { sessionId: 'chat-a' })
    expect(first.created).toBe(true)
    expect(first.id).toBe(motionIdFor(folder, file))
    const other = await registerMotion(file, undefined, { sessionId: 'chat-b', root: folder })
    expect(other.id).toBe(first.id)
    expect(other.created).toBe(false)
    expect((await getMotion(first.id))?.sessionId).toBe('chat-b')
    await unregisterMotion(first.id)
    await rm(folder, { recursive: true, force: true })
  })

  it('refuses an entry outside the composition folder and an unknown id', async () => {
    const folder = await mkdtemp(path.join(os.tmpdir(), 'orbit-motion-comp-'))
    await expect(registerMotion(folder, path.join(os.tmpdir(), 'outside.html'))).rejects.toThrow(/outside the composition/)
    expect(await getMotion('mv_inexistente')).toBeUndefined()
    expect(await getMotion('../etc/passwd')).toBeUndefined()
    await rm(folder, { recursive: true, force: true })
  })
})

describe('protocolo', () => {
  /** Uma composição registrada e o handler do scheme já na mão. */
  async function serve(files: Record<string, string | Buffer>) {
    const folder = await mkdtemp(path.join(os.tmpdir(), 'orbit-motion-comp-'))
    for (const [name, content] of Object.entries(files)) await writeFile(path.join(folder, name), content)
    const { id } = await registerMotion(folder, path.join(folder, 'index.html'), { root: os.tmpdir() })
    registerMotionProtocol()
    const handler = registered.handlers.get('orbit-motion')
    if (!handler) throw new Error('o scheme orbit-motion não foi registrado')
    return { folder, handler, url: (file: string) => `orbit-motion://${id}/${file}` }
  }

  it('serve o áudio da peça com faixa — é o que deixa o preview reposicionar', async () => {
    const bytes = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
    const { folder, handler, url } = await serve({ 'index.html': '<head></head>', 'voz.wav': bytes })

    const whole = await handler(new Request(url('voz.wav')))
    expect(whole.status).toBe(200)
    // Sem este cabeçalho o Chromium trata o áudio como NÃO-buscável: o som toca
    // na minutagem certa, mas `currentTime` vira sugestão e pausar no meio
    // recomeça o arquivo do zero.
    expect(whole.headers.get('accept-ranges')).toBe('bytes')
    expect(whole.headers.get('content-length')).toBe('10')
    expect(new Uint8Array(await whole.arrayBuffer())).toEqual(new Uint8Array(bytes))

    // A faixa do seek: só o pedaço, com 206 e o intervalo declarado.
    const piece = await handler(new Request(url('voz.wav'), { headers: { range: 'bytes=2-5' } }))
    expect(piece.status).toBe(206)
    expect(piece.headers.get('content-range')).toBe('bytes 2-5/10')
    expect(piece.headers.get('accept-ranges')).toBe('bytes')
    expect(piece.headers.get('content-length')).toBe('4')
    expect(new Uint8Array(await piece.arrayBuffer())).toEqual(new Uint8Array([2, 3, 4, 5]))

    // Aberta (`bytes=4-`) e sufixo (`bytes=-3`): é como um player pergunta a
    // duração de um formato sem cabeçalho.
    const open = await handler(new Request(url('voz.wav'), { headers: { range: 'bytes=4-' } }))
    expect(new Uint8Array(await open.arrayBuffer())).toEqual(new Uint8Array([4, 5, 6, 7, 8, 9]))
    const suffix = await handler(new Request(url('voz.wav'), { headers: { range: 'bytes=-3' } }))
    expect(new Uint8Array(await suffix.arrayBuffer())).toEqual(new Uint8Array([7, 8, 9]))

    const past = await handler(new Request(url('voz.wav'), { headers: { range: 'bytes=50-60' } }))
    expect(past.status).toBe(416)
    expect(past.headers.get('content-range')).toBe('bytes */10')

    await rm(folder, { recursive: true, force: true })
  })

  it('com o runtime injetado, o HTML deixa de ser o arquivo — e faixa não se aplica', async () => {
    const { folder, handler, url } = await serve({ 'index.html': '<html><head></head></html>' })

    const res = await handler(new Request(url('index.html'), { headers: { range: 'bytes=0-4' } }))
    expect(res.status).toBe(200)
    // O runtime entra como <script src> no <head> — o marcador é o que prova a
    // injeção (e é o que a faixa do HTML não pode deslocar).
    expect(await res.text()).toContain('data-orbit-motion-runtime')

    await rm(folder, { recursive: true, force: true })
  })

  it('mídia sai sem `no-store`; o código da composição continua sem cache', async () => {
    const { folder, handler, url } = await serve({
      'index.html': '<head></head>',
      'voz.wav': Buffer.from([1, 2, 3, 4]),
      'app.js': 'export const a = 1',
    })

    // O <audio> precisa poder guardar o que já baixou: sem isso ele refaz o
    // pedido a cada reposicionamento, descarta o buffer, e o som picota em vez
    // de tocar. É o que o video/store.ts e o audio-store.ts sempre fizeram.
    const media = await handler(new Request(url('voz.wav')))
    expect(media.status).toBe(200)
    expect(media.headers.get('cache-control')).toBeNull()
    expect(media.headers.get('accept-ranges')).toBe('bytes')

    // O JS é pedido pela MESMA URL a cada recarga — cache aqui serviria a versão
    // antiga, e a edição ao vivo não apareceria.
    const code = await handler(new Request(url('app.js')))
    expect(code.headers.get('cache-control')).toBe('no-store')

    await rm(folder, { recursive: true, force: true })
  })
})

describe('deleteMotionComposition', () => {
  const exists = (target: string) =>
    stat(target).then(
      () => true,
      () => false,
    )

  async function project(): Promise<string> {
    return mkdtemp(path.join(os.tmpdir(), 'orbit-motion-delete-'))
  }

  async function composition(folder: string): Promise<string> {
    await mkdir(path.join(folder, 'assets'), { recursive: true })
    const entry = path.join(folder, 'index.html')
    await writeFile(entry, '<html></html>')
    await writeFile(path.join(folder, 'assets', 'clip.mp4'), 'video-bytes')
    return entry
  }

  it('apaga a pasta da composição inteira (com o que foi copiado para ela) e tira do registro', async () => {
    const root = await project()
    const folder = path.join(root, 'edit', 'animations', 'intro')
    const entry = await composition(folder)
    const renders = path.join(root, 'edit', 'renders')
    await mkdir(renders, { recursive: true })
    await writeFile(path.join(renders, 'intro.mp4'), 'render')
    const { id } = await registerMotion(folder, entry, { root })

    const result = await deleteMotionComposition(id)

    expect(result).toEqual({ removedFolder: true })
    expect(await exists(folder)).toBe(false)
    expect(await getMotion(id)).toBeUndefined()
    // O que o usuário renderizou fica fora da pasta da composição e não é tocado.
    expect(await readdir(renders)).toEqual(['intro.mp4'])
    await rm(root, { recursive: true, force: true })
  })

  it('uma composição que É o projeto (index.html na raiz) sai do registro, mas a pasta fica', async () => {
    const root = await project()
    const entry = await composition(root)
    await writeFile(path.join(root, 'package.json'), '{}')
    const { id } = await registerMotion(root, entry, { root })

    const result = await deleteMotionComposition(id)

    expect(result.removedFolder).toBe(false)
    expect(result.keptBecause).toMatch(/project itself/)
    expect(await exists(path.join(root, 'package.json'))).toBe(true)
    expect(await getMotion(id)).toBeUndefined()
    await rm(root, { recursive: true, force: true })
  })

  it('a pasta do modo chat é do Orbit: apaga mesmo sem pasta de trabalho registrada', async () => {
    const folder = path.join(tempRoot, 'orbit-data', 'motion', 'sess1', 'minha-peca')
    const entry = await composition(folder)
    const { id } = await registerMotion(folder, entry)

    expect(await deleteMotionComposition(id)).toEqual({ removedFolder: true })
    expect(await exists(folder)).toBe(false)
  })

  it('fora de qualquer lugar que o app pode limpar, a pasta fica', async () => {
    const root = await project()
    const elsewhere = await project()
    const entry = await composition(elsewhere)
    const { id } = await registerMotion(elsewhere, entry, { root })

    const result = await deleteMotionComposition(id)

    expect(result.removedFolder).toBe(false)
    expect(await exists(entry)).toBe(true)
    expect(await getMotion(id)).toBeUndefined()
    await rm(root, { recursive: true, force: true })
    await rm(elsewhere, { recursive: true, force: true })
  })

  it('sem composição de verdade na pasta (entrada sumiu), nada é apagado', async () => {
    const root = await project()
    const folder = path.join(root, 'edit', 'animations', 'vazia')
    const entry = await composition(folder)
    const { id } = await registerMotion(folder, entry, { root })
    await rm(entry)
    await writeFile(path.join(folder, 'notas-do-usuario.txt'), 'importante')

    const result = await deleteMotionComposition(id)

    expect(result.keptBecause).toMatch(/entry/)
    expect(await exists(path.join(folder, 'notas-do-usuario.txt'))).toBe(true)
    await rm(root, { recursive: true, force: true })
  })

  it('id desconhecido não faz nada', async () => {
    expect(await deleteMotionComposition('mv_000000000000dead')).toEqual({ removedFolder: false, keptBecause: 'not registered' })
  })
})
