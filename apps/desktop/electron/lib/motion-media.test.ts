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
