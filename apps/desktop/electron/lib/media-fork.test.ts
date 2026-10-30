import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * Fork clones the messages pointing to the SAME asset (documentId/mediaUrl
 * unchanged) — what is missing is for the record to know that the asset now also
 * belongs to the new session, otherwise "In this chat" in the fork does not find what its
 * own conversation already shows. linkMediaSessions is that bridge.
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
  it('adds the fork session without touching the origin session', async () => {
    const url = await media.saveMedia(Buffer.from('fake-png'), 'png', {
      source: 'chat',
      sessionId: 'session-original',
      name: 'chart.png',
    })
    const id = media.mediaIdFromUrl(url)!

    await media.linkMediaSessions([id], 'session-fork-1')

    const entry = await media.getMediaEntry(id)
    expect(entry?.sessionId).toBe('session-original')
    expect(entry?.linkedSessionIds).toEqual(['session-fork-1'])
  })

  it('is idempotent — linking twice does not duplicate the entry', async () => {
    const url = await media.saveMedia(Buffer.from('fake-png-2'), 'png', {
      source: 'chat',
      sessionId: 'session-original-2',
    })
    const id = media.mediaIdFromUrl(url)!

    await media.linkMediaSessions([id], 'session-fork-2')
    await media.linkMediaSessions([id], 'session-fork-2')

    const entry = await media.getMediaEntry(id)
    expect(entry?.linkedSessionIds).toEqual(['session-fork-2'])
  })

  it('does not link back the session that is already the origin', async () => {
    const url = await media.saveMedia(Buffer.from('fake-png-3'), 'png', {
      source: 'chat',
      sessionId: 'session-original-3',
    })
    const id = media.mediaIdFromUrl(url)!

    await media.linkMediaSessions([id], 'session-original-3')

    const entry = await media.getMediaEntry(id)
    expect(entry?.linkedSessionIds ?? []).toEqual([])
  })

  it('ignores ids that do not exist in the registry, silently', async () => {
    await expect(media.linkMediaSessions(['img_missing.png'], 'session-fork-3')).resolves.toBeUndefined()
  })

  it('listMedia with a session filter sees both the origin and the fork', async () => {
    const url = await media.saveMedia(Buffer.from('fake-png-4'), 'png', {
      source: 'chat',
      sessionId: 'session-original-4',
    })
    const id = media.mediaIdFromUrl(url)!
    await media.linkMediaSessions([id], 'session-fork-4')

    const inOrigin = await media.listMedia({ sessionId: 'session-original-4' })
    const noFork = await media.listMedia({ sessionId: 'session-fork-4' })
    const inAnotherSession = await media.listMedia({ sessionId: 'session-any' })

    expect(inOrigin.some((e) => e.id === id)).toBe(true)
    expect(noFork.some((e) => e.id === id)).toBe(true)
    expect(inAnotherSession.some((e) => e.id === id)).toBe(false)
  })
})
