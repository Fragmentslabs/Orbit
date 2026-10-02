import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * Fork clona as mensagens apontando para o MESMO ativo (documentId/mediaUrl
 * inalterado) — o que falta é o registro saber que o ativo agora também
 * pertence à sessão nova, senão "Neste chat" no fork não encontra o que a
 * própria conversa dele já mostra. linkMediaSessions é essa ponte.
 */

const userData = path.join(os.tmpdir(), `orbit-media-fork-test-${process.pid}`)

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

describe('linkMediaSessions', () => {
  it('adiciona a sessão do fork sem mexer na sessão de origem', async () => {
    const url = await media.saveMedia(Buffer.from('fake-png'), 'png', {
      source: 'chat',
      sessionId: 'sessao-original',
      name: 'grafico.png',
    })
    const id = media.mediaIdFromUrl(url)!

    await media.linkMediaSessions([id], 'sessao-fork-1')

    const entry = await media.getMediaEntry(id)
    expect(entry?.sessionId).toBe('sessao-original')
    expect(entry?.linkedSessionIds).toEqual(['sessao-fork-1'])
  })

  it('é idempotente — vincular duas vezes não duplica a entrada', async () => {
    const url = await media.saveMedia(Buffer.from('fake-png-2'), 'png', {
      source: 'chat',
      sessionId: 'sessao-original-2',
    })
    const id = media.mediaIdFromUrl(url)!

    await media.linkMediaSessions([id], 'sessao-fork-2')
    await media.linkMediaSessions([id], 'sessao-fork-2')

    const entry = await media.getMediaEntry(id)
    expect(entry?.linkedSessionIds).toEqual(['sessao-fork-2'])
  })

  it('não vincula de volta a sessão que já é a de origem', async () => {
    const url = await media.saveMedia(Buffer.from('fake-png-3'), 'png', {
      source: 'chat',
      sessionId: 'sessao-original-3',
    })
    const id = media.mediaIdFromUrl(url)!

    await media.linkMediaSessions([id], 'sessao-original-3')

    const entry = await media.getMediaEntry(id)
    expect(entry?.linkedSessionIds ?? []).toEqual([])
  })

  it('ignora ids que não existem no registro, em silêncio', async () => {
    await expect(media.linkMediaSessions(['img_naoexiste.png'], 'sessao-fork-3')).resolves.toBeUndefined()
  })

  it('listMedia com filtro por sessão enxerga tanto a origem quanto o fork', async () => {
    const url = await media.saveMedia(Buffer.from('fake-png-4'), 'png', {
      source: 'chat',
      sessionId: 'sessao-original-4',
    })
    const id = media.mediaIdFromUrl(url)!
    await media.linkMediaSessions([id], 'sessao-fork-4')

    const naOrigem = await media.listMedia({ sessionId: 'sessao-original-4' })
    const noFork = await media.listMedia({ sessionId: 'sessao-fork-4' })
    const emOutraSessao = await media.listMedia({ sessionId: 'sessao-qualquer' })

    expect(naOrigem.some((e) => e.id === id)).toBe(true)
    expect(noFork.some((e) => e.id === id)).toBe(true)
    expect(emOutraSessao.some((e) => e.id === id)).toBe(false)
  })
})
