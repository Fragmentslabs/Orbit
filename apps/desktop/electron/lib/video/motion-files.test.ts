import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * O card da peça precisa saber três coisas de cada arquivo: que ele existe, se
 * a composição o CITA (usado) ou não (descartado), e de qual mídia do chat ele
 * veio — é essa última que transforma um player solto numa linha do card.
 *
 * O "usado" é derivado do texto da composição de propósito: quando o agente
 * troca a narração no `audio.json`, o arquivo antigo vira descartado sozinho.
 */

const userData = path.join(os.tmpdir(), `orbit-motion-files-${process.pid}`)

vi.mock('electron', () => ({
  app: { getPath: () => userData },
  BrowserWindow: { getAllWindows: () => [] },
  net: {},
  protocol: { handle: () => {}, registerSchemesAsPrivileged: () => {} },
  session: {},
  dialog: {},
}))

let files: typeof import('./motion-files')
let store: typeof import('./motion-store')

const SESSION = 'sess-files'
let root: string
let folder: string

beforeAll(async () => {
  files = await import('./motion-files')
  store = await import('./motion-store')
  root = path.join(userData, 'orbit-data', 'motion', SESSION)
  folder = path.join(root, 'intro')
  await fsp.mkdir(path.join(folder, 'fonts'), { recursive: true })
  await fsp.writeFile(path.join(folder, 'index.html'), '<video src="clipe.mp4"></video><style>@font-face{src:url("fonts/inter.woff2")}</style>')
  await fsp.writeFile(path.join(folder, 'audio.json'), JSON.stringify({ tracks: [{ src: 'narracao.wav' }] }))
  await fsp.writeFile(path.join(folder, 'clipe.mp4'), Buffer.alloc(64))
  await fsp.writeFile(path.join(folder, 'narracao.wav'), Buffer.alloc(32))
  // A antiga: o `audio.json` não fala dela.
  await fsp.writeFile(path.join(folder, 'narracao-2.wav'), Buffer.alloc(16))
  await fsp.writeFile(path.join(folder, 'fonts', 'inter.woff2'), Buffer.alloc(8))
  await fsp.writeFile(path.join(folder, '.DS_Store'), 'x')
  await store.registerMotion(folder, path.join(folder, 'index.html'), { root, sessionId: SESSION })
})

afterAll(async () => {
  await fsp.rm(userData, { recursive: true, force: true })
})

describe('listMotionBundles', () => {
  it('lista a pasta da peça, sem os arquivos internos, com usado/descartado', async () => {
    const [bundle] = await files.listMotionBundles(SESSION)
    expect(bundle.name).toBe('intro')
    const byName = Object.fromEntries(bundle.files.map((file) => [file.name, file]))
    // index.html é a peça, audio.json é manifesto: nenhum dos dois é item da lista.
    expect(byName['index.html']).toBeUndefined()
    expect(byName['audio.json']).toBeUndefined()
    expect(byName['.DS_Store']).toBeUndefined()
    expect(byName['clipe.mp4'].used).toBe(true)
    expect(byName['narracao.wav'].used).toBe(true)
    // Citada só no HTML, por caminho relativo.
    expect(byName['fonts/inter.woff2'].used).toBe(true)
    // A narração que a composição não cita: continua na pasta, etiquetada.
    expect(byName['narracao-2.wav'].used).toBe(false)
    expect(bundle.discarded).toBe(1)
    expect(bundle.totalBytes).toBe(64 + 32 + 16 + 8)
    expect(bundle.files.find((file) => file.name === 'clipe.mp4')?.kind).toBe('video')
    expect(bundle.files.find((file) => file.name === 'narracao.wav')?.kind).toBe('audio')
    expect(bundle.files.find((file) => file.name === 'fonts/inter.woff2')?.kind).toBe('font')
  })

  it('a composição muda → o estado do arquivo muda junto, sem ninguém marcar nada', async () => {
    const audioFile = path.join(folder, 'audio.json')
    const before = await fsp.readFile(audioFile, 'utf8')
    await fsp.writeFile(audioFile, JSON.stringify({ tracks: [{ src: 'narracao-2.wav' }] }))
    try {
      const [bundle] = await files.listMotionBundles(SESSION)
      const byName = Object.fromEntries(bundle.files.map((file) => [file.name, file]))
      expect(byName['narracao-2.wav'].used).toBe(true)
      expect(byName['narracao.wav'].used).toBe(false)
    } finally {
      await fsp.writeFile(audioFile, before)
    }
  })

  it('sem peça registrada na sessão, nenhum card', async () => {
    expect(await files.listMotionBundles('outra-sessao')).toEqual([])
  })

  it('a origem de cada arquivo vira chave do chat', async () => {
    const id = store.motionIdFor(folder, path.join(folder, 'index.html'))
    await files.recordMotionFile(
      { id, folder, sessionId: SESSION },
      { name: 'narracao.wav', ref: 'aud_abc.wav' },
    )
    await files.recordMotionFile(
      { id, folder, sessionId: SESSION },
      { name: 'clipe.mp4', source: '/tmp/projeto/clipe.mp4' },
    )
    const [bundle] = await files.listMotionBundles(SESSION)
    expect(bundle.keys).toContain('aud_abc.wav')
    expect(bundle.keys).toContain('/tmp/projeto/clipe.mp4')
  })

  it('registrar de novo o mesmo arquivo não duplica a origem nem apaga a anterior', async () => {
    const id = store.motionIdFor(folder, path.join(folder, 'index.html'))
    // A narração regravada que caiu no mesmo nome: as duas mensagens da
    // conversa continuam apontando para o arquivo.
    await files.recordMotionFile({ id, folder, sessionId: SESSION }, { name: 'narracao.wav', ref: 'aud_def.wav' })
    await files.recordMotionFile({ id, folder, sessionId: SESSION }, { name: 'narracao.wav', ref: 'aud_def.wav' })
    const [bundle] = await files.listMotionBundles(SESSION)
    expect(bundle.keys).toContain('aud_abc.wav')
    expect(bundle.keys).toContain('aud_def.wav')
    expect(bundle.keys.filter((key) => key === 'aud_def.wav')).toHaveLength(1)
  })

  it('peça apagada leva a origem junto (a pasta reaberta é uma peça nova)', async () => {
    const id = store.motionIdFor(folder, path.join(folder, 'index.html'))
    await store.unregisterMotion(id)
    const rebuilt = await store.registerMotion(folder, path.join(folder, 'index.html'), { root, sessionId: SESSION })
    const [bundle] = await files.listMotionBundles(SESSION)
    expect(rebuilt.id).toBe(id)
    expect(bundle.keys).not.toContain('aud_abc.wav')
  })
})

describe('mentionsFile', () => {
  it('o arquivo tem que aparecer como arquivo, não como pedaço de outra palavra', () => {
    expect(files.mentionsFile('<img src="foto.png">', 'foto.png')).toBe(true)
    expect(files.mentionsFile('url(./foto.png)', 'foto.png')).toBe(true)
    expect(files.mentionsFile('{"src":"foto.png"}', 'foto.png')).toBe(true)
    // Outro arquivo que TERMINA com o nome não cita o nome.
    expect(files.mentionsFile('src="minha-foto.png"', 'foto.png')).toBe(false)
    expect(files.mentionsFile('src="foto.png.bak"', 'foto.png')).toBe(false)
  })

  it('caminho com subpasta vale pelo caminho inteiro ou pelo nome solto', () => {
    expect(files.mentionsFile('src="fonts/inter.woff2"', 'fonts/inter.woff2')).toBe(true)
    expect(files.mentionsFile('src="inter.woff2"', 'fonts/inter.woff2')).toBe(true)
    expect(files.mentionsFile('src="fonts/outra.woff2"', 'fonts/inter.woff2')).toBe(false)
  })

  it('nome com espaço vale também na forma que viaja numa URL', () => {
    expect(files.mentionsFile('src="minha%20narracao.wav"', 'minha narracao.wav')).toBe(true)
  })
})

describe('pieceFileName', () => {
  it('só aceita caminho dentro da pasta', () => {
    expect(files.pieceFileName('/a/b', '/a/b/c/d.wav')).toBe('c/d.wav')
    expect(files.pieceFileName('/a/b', '/a/b')).toBeNull()
    expect(files.pieceFileName('/a/b', '/a/c/d.wav')).toBeNull()
    expect(files.pieceFileName('/a/b', '/a/b/../d.wav')).toBeNull()
  })
})
