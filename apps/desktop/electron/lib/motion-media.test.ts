import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * A peça de motion entra na galeria por um registro que NÃO é um arquivo do
 * Orbit: a composição é uma pasta do projeto. O que estes testes protegem são as
 * duas consequências disso — registrar de novo a mesma peça não cria um segundo
 * card, e o `path` do item aponta para a CAPA, nunca para o arquivo de quem fez
 * a peça.
 */

const userData = path.join(os.tmpdir(), `orbit-motion-media-test-${process.pid}`)

vi.mock('electron', () => ({
  app: { getPath: () => userData },
  BrowserWindow: { getAllWindows: () => [] },
  net: {},
  protocol: { handle: () => {}, registerSchemesAsPrivileged: () => {} },
  session: {},
  dialog: {},
}))

let media: typeof import('./media')

beforeAll(async () => {
  media = await import('./media')
})

afterAll(async () => {
  await fsp.rm(userData, { recursive: true, force: true })
})

describe('saveMotionMedia', () => {
  it('registra a peça uma vez só: registrar de novo atualiza o MESMO item', async () => {
    const first = await media.saveMotionMedia(Buffer.from('capa-1'), {
      motionId: 'mv_abc123',
      title: 'Abertura',
    })
    const second = await media.saveMotionMedia(Buffer.from('capa-2'), {
      motionId: 'mv_abc123',
      title: 'Abertura v2',
    })
    expect(second.id).toBe(first.id)
    expect(second.createdAt).toBe(first.createdAt)
    expect(second.name).toBe('Abertura v2')
    const items = (await media.listMedia({ kind: 'motion' })).filter((i) => i.motionId === 'mv_abc123')
    expect(items).toHaveLength(1)
  })

  it('o path aponta para a CAPA, nunca para a peça do projeto', async () => {
    const entry = await media.saveMotionMedia(Buffer.from('capa'), {
      motionId: 'mv_def456',
      title: 'Fecho',
      directory: '/tmp/algum-projeto',
    })
    expect(entry.kind).toBe('motion')
    expect(entry.motionId).toBe('mv_def456')
    // Apagar o item da galeria apaga a miniatura — o único byte NOSSO. A
    // composição continua intocada na pasta do projeto.
    expect(entry.path.startsWith(userData)).toBe(true)
    expect(path.basename(entry.path)).toBe(entry.id)
    expect(entry.thumb).toBe(entry.id)
    await expect(fsp.readFile(entry.path, 'utf8')).resolves.toBe('capa')
    // O projeto fica gravado, para a Mídia agrupar e o item sobreviver à conversa.
    expect(entry.directory).toBe('/tmp/algum-projeto')
  })

  it('sem captura a peça entra do mesmo jeito, só que sem capa', async () => {
    const entry = await media.saveMotionMedia(null, { motionId: 'mv_semcapa', title: 'Rascunho' })
    expect(entry.kind).toBe('motion')
    expect(entry.thumb).toBeUndefined()
    expect(entry.size).toBe(0)
  })
})

const exists = (target: string) =>
  fsp.stat(target).then(
    () => true,
    () => false,
  )

describe('vídeo na galeria', () => {
  async function videoFile(name: string): Promise<string> {
    const dir = path.join(userData, 'orbit-data', 'video-attachments')
    await fsp.mkdir(dir, { recursive: true })
    const file = path.join(dir, name)
    await fsp.writeFile(file, 'video-bytes')
    return file
  }

  it('entra como tipo vídeo, com capa, duração e a URL do player', async () => {
    const file = await videoFile('vdo_a1.mp4')
    const entry = await media.saveVideoMedia(Buffer.from('png'), {
      id: 'vdo_a1.mp4',
      file,
      size: 11,
      name: 'Entrevista.mp4',
      source: 'user',
      sessionId: 's1',
      durationMs: 12_400,
      width: 1920,
      height: 1080,
      videoUrl: 'orbit-video://vid_x',
    })
    expect(entry).toMatchObject({ kind: 'video', durationMs: 12_400, videoUrl: 'orbit-video://vid_x', path: file, source: 'user' })
    expect(entry.thumb).toBe('vdp_a1.png')
    const listed = await media.listMedia({ kind: 'video' })
    expect(listed.map((e) => e.id)).toContain('vdo_a1.mp4')
  })

  it('registrar o mesmo id de novo atualiza o item (não cria outro)', async () => {
    const file = await videoFile('vdo_b2.mp4')
    await media.saveVideoMedia(null, { id: 'vdo_b2.mp4', file, size: 1, source: 'user', name: 'um' })
    await media.saveVideoMedia(null, { id: 'vdo_b2.mp4', file, size: 1, source: 'user', name: 'dois' })
    const items = (await media.listMedia({ kind: 'video' })).filter((e) => e.id === 'vdo_b2.mp4')
    expect(items).toHaveLength(1)
    expect(items[0].name).toBe('dois')
  })

  it('excluir apaga o ARQUIVO do vídeo, a capa e o registro — libera o espaço', async () => {
    const file = await videoFile('vdo_c3.mp4')
    const entry = await media.saveVideoMedia(Buffer.from('png'), { id: 'vdo_c3.mp4', file, size: 11, source: 'user' })
    const cover = path.join(userData, 'orbit-data', 'artifacts', entry.thumb!)
    expect(await exists(file)).toBe(true)
    expect(await exists(cover)).toBe(true)

    expect(await media.deleteMedia('vdo_c3.mp4')).toBe(true)

    expect(await exists(file)).toBe(false)
    expect(await exists(cover)).toBe(false)
    expect(await media.getMediaEntry('vdo_c3.mp4')).toBeNull()
  })

  it('o gancho do tipo roda ANTES do registro sumir; se ele falha, o item fica para tentar de novo', async () => {
    const file = await videoFile('vdo_d4.mp4')
    await media.saveVideoMedia(null, { id: 'vdo_d4.mp4', file, size: 11, source: 'user' })
    const seen: string[] = []
    media.setMediaDeleteHook('video', async (entry) => {
      seen.push(entry.id)
      throw new Error('indisponível')
    })
    await expect(media.deleteMedia('vdo_d4.mp4')).rejects.toThrow('indisponível')
    expect(seen).toEqual(['vdo_d4.mp4'])
    expect(await exists(file)).toBe(true)
    expect(await media.getMediaEntry('vdo_d4.mp4')).not.toBeNull()

    media.setMediaDeleteHook('video', async () => {})
    expect(await media.deleteMedia('vdo_d4.mp4')).toBe(true)
    expect(await exists(file)).toBe(false)
  })

  it('id que não é de vídeo, imagem, áudio nem artefato continua recusado', async () => {
    expect(await media.deleteMedia('vdo_x.exe')).toBe(false)
    expect(await media.deleteMedia('../../etc/passwd')).toBe(false)
  })
})

describe('excluir uma peça de motion', () => {
  it('chama o gancho do tipo com a peça — é ele que apaga a composição — e remove a capa', async () => {
    const entry = await media.saveMotionMedia(Buffer.from('capa'), { motionId: 'mv_apagar1', title: 'Peça' })
    const asked: Array<string | undefined> = []
    media.setMediaDeleteHook('motion', async (e) => {
      asked.push(e.motionId)
    })
    expect(await media.deleteMedia(entry.id)).toBe(true)
    expect(asked).toEqual(['mv_apagar1'])
    expect(await exists(entry.path)).toBe(false)
    expect(await media.getMediaEntry(entry.id)).toBeNull()
  })
})

describe('uso de disco', () => {
  it('conta os vídeos pelo registro, e excluir tira do número', async () => {
    const dir = path.join(userData, 'orbit-data', 'video-attachments')
    await fsp.mkdir(dir, { recursive: true })
    const file = path.join(dir, 'vdo_u9.mp4')
    await fsp.writeFile(file, Buffer.alloc(4096))
    const before = await media.mediaDiskUsage()
    await media.saveVideoMedia(null, { id: 'vdo_u9.mp4', file, size: 4096, source: 'user' })
    const during = await media.mediaDiskUsage()
    expect(during.bytes - before.bytes).toBe(4096)
    expect(during.count - before.count).toBe(1)

    await media.deleteMedia('vdo_u9.mp4')
    const after = await media.mediaDiskUsage()
    expect(after.bytes).toBe(before.bytes)
  })
})
