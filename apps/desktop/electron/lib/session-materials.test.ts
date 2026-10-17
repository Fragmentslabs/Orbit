import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * Foto, GIF, áudio e vídeo na aba Fontes. Módulos de verdade (mídia, áudio,
 * anexos, escopo de pasta) sobre um userData temporário; o vídeo usa o ffmpeg
 * do app e a parte dele pula quando a máquina não o tem.
 */

const desktop = path.resolve(__dirname, '../..')
const bundled = path.join(desktop, 'resources', 'ffmpeg', `${process.platform}-${process.arch}`)
const hasFfmpeg = fs.existsSync(path.join(bundled, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'))
const userData = path.join(os.tmpdir(), `orbit-session-materials-${process.pid}`)

vi.mock('electron', () => ({
  app: { getPath: () => userData, getAppPath: () => desktop, isPackaged: false },
  BrowserWindow: { getAllWindows: () => [] },
  net: {},
  protocol: { handle: () => {}, registerSchemesAsPrivileged: () => {} },
  session: {},
  dialog: {},
}))

const materials = await import('./session-materials')
const media = await import('./media')
const documents = await import('./session-documents')
const { runFfmpeg } = await import('./video/ffmpeg')
const { motionFfmpegArgs } = await import('./video/motion-render-args')

const exists = (target: string) =>
  fsp.stat(target).then(
    () => true,
    () => false,
  )

let png: string
let gif: string
let wav: string

beforeAll(async () => {
  await fsp.mkdir(userData, { recursive: true })
  const image = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#f00' } }).png().toBuffer()
  png = image.toString('base64')
  // Um GIF mínimo e válido (1x1) — o conteúdo não importa, só a extensão preservada.
  gif = Buffer.from('R0lGODlhAQABAIAAAP///wAAACwAAAAAAQABAAACAkQBADs=', 'base64').toString('base64')
  wav = Buffer.concat([Buffer.from('RIFF$\0\0\0WAVEfmt ', 'binary'), Buffer.alloc(24)]).toString('base64')
})
afterAll(async () => {
  await fsp.rm(userData, { recursive: true, force: true })
})

describe('materialKindOf', () => {
  it('classifica pelo MIME ou pela extensão', () => {
    expect(materials.materialKindOf('image/gif', 'a.gif')).toBe('image')
    expect(materials.materialKindOf('', 'FOTO.JPG')).toBe('image')
    expect(materials.materialKindOf('audio/mpeg', 'a.mp3')).toBe('audio')
    expect(materials.materialKindOf('', 'clip.MOV')).toBe('video')
    expect(materials.materialKindOf('application/pdf', 'a.pdf')).toBeNull()
    expect(materials.materialKindOf('', 'planilha.xlsx')).toBeNull()
  })
})

describe('addSessionMaterial / listSessionMaterials', () => {
  it('foto e GIF entram na conversa, com a referência img_ e a extensão preservada', async () => {
    const photo = await materials.addSessionMaterial('s1', { filename: 'foto.png', mime: 'image/png', data: png }, false)
    const animated = await materials.addSessionMaterial('s1', { filename: 'dança.gif', mime: 'image/gif', data: gif }, false)
    expect(photo.ok && photo.material.id).toMatch(/^img_.*\.png$/)
    expect(animated.ok && animated.material).toMatchObject({ kind: 'image', animated: true, name: 'dança.gif', shared: false })
    expect(animated.ok && animated.material.id).toMatch(/\.gif$/)

    const list = await materials.listSessionMaterials('s1')
    expect(list.own.map((m) => m.name).sort()).toEqual(['dança.gif', 'foto.png'])
    expect(list.shared).toEqual([])
    expect(list.bytes).toBeGreaterThan(0)
  })

  it('o áudio vira aud_ e aparece sem capa', async () => {
    const result = await materials.addSessionMaterial('s2', { filename: 'voz.wav', mime: 'audio/wav', data: wav }, false)
    expect(result.ok).toBe(true)
    const [audio] = (await materials.listSessionMaterials('s2')).own
    expect(audio).toMatchObject({ kind: 'audio', name: 'voz.wav', thumbUrl: null })
    expect(audio.id).toMatch(/^aud_/)
  })

  it('tipo que a aba não guarda é recusado com o motivo', async () => {
    const result = await materials.addSessionMaterial('s1', { filename: 'doc.pdf', mime: 'application/pdf', data: 'AAAA' }, false)
    expect(result.ok).toBe(false)
  })

  it('só aparece o que o USUÁRIO trouxe: a imagem que o agente gerou é saída, não material', async () => {
    await media.saveMedia(Buffer.from(png, 'base64'), 'png', { source: 'chat', sessionId: 's3', name: 'gerada.png' })
    expect((await materials.listSessionMaterials('s3')).own).toEqual([])
  })

  it('o que é de uma conversa não aparece em outra', async () => {
    const mine = await materials.listSessionMaterials('s1')
    const other = await materials.listSessionMaterials('s2')
    expect(mine.own.some((m) => m.name === 'voz.wav')).toBe(false)
    expect(other.own.some((m) => m.name === 'foto.png')).toBe(false)
  })
})

describe('escopo da pasta', () => {
  it('compartilhar não muda a referência; sem pasta, não há com quem compartilhar', async () => {
    await documents.setDraftFolder(null)
    const added = await materials.addSessionMaterial('draft', { filename: 'a.png', mime: 'image/png', data: png }, true)
    // Sem pasta, "compartilhado" cai na conversa.
    expect(added.ok && added.material.shared).toBe(false)
    const id = added.ok ? added.material.id : ''
    const denied = await materials.setMaterialShared('draft', id, true)
    expect(denied.ok).toBe(false)

    await documents.setDraftFolder('pasta1')
    expect(await materials.setMaterialShared('draft', id, true)).toEqual({ ok: true })
    const shared = await materials.listSessionMaterials('draft')
    expect(shared.shared.map((m) => m.id)).toEqual([id])
    expect(shared.own.some((m) => m.id === id)).toBe(false)

    expect(await materials.setMaterialShared('draft', id, false)).toEqual({ ok: true })
    const back = await materials.listSessionMaterials('draft')
    expect(back.shared).toEqual([])
    expect(back.own.map((m) => m.id)).toContain(id)
  })

  it('recusa um id que não é um material desta conversa', async () => {
    const result = await materials.setMaterialShared('s2', 'img_naoexiste.png', true)
    expect(result).toMatchObject({ ok: false })
  })

  it('o que foi trazido no rascunho passa para a sessão quando ela nasce', async () => {
    await documents.setDraftFolder(null)
    const added = await materials.addSessionMaterial('draft', { filename: 'rascunho.png', mime: 'image/png', data: png }, false)
    const id = added.ok ? added.material.id : ''
    expect((await materials.listSessionMaterials('nova')).own.map((m) => m.id)).not.toContain(id)

    expect(await materials.adoptDraftMaterials('nova')).toBeGreaterThan(0)

    expect((await materials.listSessionMaterials('nova')).own.map((m) => m.id)).toContain(id)
    expect((await materials.listSessionMaterials('draft')).own.map((m) => m.id)).not.toContain(id)
  })
})

describe('excluir libera o espaço', () => {
  it('apagar pela galeria tira o arquivo do disco e da aba', async () => {
    const added = await materials.addSessionMaterial('s4', { filename: 'sai.png', mime: 'image/png', data: png }, false)
    const material = added.ok ? added.material : null
    const entry = await media.getMediaEntry(material!.id)
    expect(await exists(entry!.path)).toBe(true)

    expect(await media.deleteMedia(material!.id)).toBe(true)

    expect(await exists(entry!.path)).toBe(false)
    expect((await materials.listSessionMaterials('s4')).own).toEqual([])
  })
})

describe('describeMaterialsForAgent', () => {
  it('uma linha por material: referência, tipo, nome, fatos e de onde veio', () => {
    const text = materials.describeMaterialsForAgent({
      shared: [
        { id: 'vdo_a.mp4', kind: 'video', name: 'Aula.mp4', sizeBytes: 14_200_000, createdAt: 1, durationMs: 12_400, width: 1920, height: 1080, thumbUrl: null, playUrl: null, shared: true, animated: false },
      ],
      own: [
        { id: 'img_b.gif', kind: 'image', name: 'dança.gif', sizeBytes: 500_000, createdAt: 2, thumbUrl: null, playUrl: null, shared: false, animated: true },
      ],
    })
    expect(text.split('\n')).toEqual([
      'vdo_a.mp4: video "Aula.mp4" (12.4 s, 1920x1080, 14.2 MB, folder material, shared with the other chats of the folder)',
      'img_b.gif: image "dança.gif" (animated GIF, 0.5 MB, attached in this conversation)',
    ])
  })
})

describe.skipIf(!hasFfmpeg)('vídeo na aba (ffmpeg real)', () => {
  async function clip(file: string): Promise<void> {
    const frame = Buffer.alloc(64 * 64 * 4, 180)
    await runFfmpeg(motionFfmpegArgs({ width: 64, height: 64, captureWidth: 64, captureHeight: 64, fps: 5, format: 'mp4', output: file }), {
      stdin: Readable.from([Buffer.concat(Array.from({ length: 10 }, () => frame))]),
    })
  }

  it('um vídeo de arquivo entra por caminho: é copiado, sondado, ganha capa e vira item da galeria', async () => {
    const source = path.join(userData, 'Entrevista.mp4')
    await clip(source)
    const result = await materials.addSessionMaterial('sv', { filename: 'Entrevista.mp4', mime: 'video/mp4', path: source }, false)
    expect(result.ok).toBe(true)
    const material = result.ok ? result.material : null
    expect(material).toMatchObject({ kind: 'video', name: 'Entrevista.mp4' })
    expect(material!.id).toMatch(/^vdo_/)
    expect(material!.durationMs).toBeGreaterThan(1500)
    expect(material!.thumbUrl).toMatch(/^orbit-artifact:\/\/vdp_/)
    expect(material!.playUrl).toMatch(/^orbit-video:\/\//)
    // O original continua onde estava; a cópia é do app.
    expect(fs.existsSync(source)).toBe(true)
    const entry = await media.getMediaEntry(material!.id)
    expect(entry!.path.startsWith(userData)).toBe(true)
    expect((await media.listMedia({ kind: 'video' })).map((e) => e.id)).toContain(material!.id)

    // Excluir apaga a cópia (e só ela).
    expect(await media.deleteMedia(material!.id)).toBe(true)
    expect(fs.existsSync(entry!.path)).toBe(false)
    expect(fs.existsSync(source)).toBe(true)
  })

  it('arquivo que não é vídeo de verdade é recusado e não deixa cópia', async () => {
    const fake = path.join(userData, 'falso.mp4')
    await fsp.writeFile(fake, 'isto não é um vídeo')
    const result = await materials.addSessionMaterial('sv2', { filename: 'falso.mp4', mime: 'video/mp4', path: fake }, false)
    expect(result.ok).toBe(false)
    expect((await materials.listSessionMaterials('sv2')).own).toEqual([])
  })

  it('o caminho precisa ser de um arquivo de vídeo: o nome declarado não vale', async () => {
    const secret = path.join(userData, 'segredo.txt')
    await fsp.writeFile(secret, 'confidencial')
    const result = await materials.addSessionMaterial('sv3', { filename: 'inocente.mp4', mime: 'video/mp4', path: secret }, false)
    expect(result).toMatchObject({ ok: false })
  })
})
