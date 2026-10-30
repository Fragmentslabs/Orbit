import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

/**
 * Media journal per turn, and the revert that applies it: pieces (here, a design
 * canvas — motion and slides go through the same journalPiece) and the gallery
 * (artifacts, images). Each turn runs inside the scope the chat-engine opens;
 * the revert undoes from the chosen turn to the end, and the unrevert gives everything back.
 */

const userData = path.join(os.tmpdir(), `orbit-media-journal-${process.pid}`)

vi.mock('electron', () => ({
  app: { getPath: () => userData, getAppPath: () => userData, isPackaged: false },
  BrowserWindow: { getAllWindows: () => [] },
  net: {},
  protocol: { handle: () => {}, registerSchemesAsPrivileged: () => {} },
  session: {},
  dialog: {},
}))

const { bindMediaJournal, closeMediaJournal, mergeJournals, readMediaJournal, restorePaths, runWithMediaJournal } =
  await import('./media-journal')
const { discardMediaRevert, revertMedia, unrevertMedia } = await import('./media-revert')
const media = await import('../media')
const { getDesign, designIdFor } = await import('../design/design-store')
const { createDesignTools, designPiecesDir } = await import('../tools/design')

type Exec = (input: unknown, options: unknown) => Promise<unknown>
const run = (tools: Record<string, unknown>, name: string, input: unknown) =>
  (tools[name] as { execute: Exec }).execute(input, { toolCallId: 'call1', messages: [], abortSignal: undefined }) as Promise<string>

/** A turn of the agent: the scope the chat-engine opens around runChatTurn. */
function turn(sessionId: string, messageId: string, fn: () => Promise<void>): Promise<void> {
  return runWithMediaJournal(sessionId, async () => {
    bindMediaJournal(messageId)
    try {
      await fn()
    } finally {
      // The FINAL state (what the revert compares) is written here.
      await closeMediaJournal()
    }
  })
}

const board = (html: string) => ({ file: 'Main.html', x: 0, y: 0, w: 400, h: 300, html })

afterAll(async () => {
  await fsp.rm(userData, { recursive: true, force: true })
})

describe('mergeJournals', () => {
  it('the first turn that touched a path or an entry is the one that counts', () => {
    const merged = mergeJournals([
      { dir: '/j/m1', records: [{ type: 'media', id: 'a.png', before: null }, { type: 'path', path: '/d/piece', backup: 'b1' }] },
      {
        dir: '/j/m2',
        records: [
          { type: 'media', id: 'a.png', before: { id: 'a.png' } as never },
          { type: 'path', path: '/d/piece', backup: 'b0' },
          // Inside a folder already registered by a previous turn: covered by it.
          { type: 'path', path: '/d/piece/x.html', backup: 'b3' },
          { type: 'path', path: '/d/other.png', backup: null },
        ],
      },
    ])
    expect(merged).toEqual([
      { type: 'media', id: 'a.png', before: null },
      { type: 'path', path: path.resolve('/d/piece'), backupFile: path.join('/j/m1', 'files', 'b1'), piece: undefined },
      { type: 'path', path: path.resolve('/d/other.png'), backupFile: null, piece: undefined },
    ])
  })
})

describe('media revert', () => {
  const sessionId = 'sess1'
  const tools = createDesignTools({ sessionId })
  const folder = path.join(designPiecesDir(sessionId), 'landing')
  const boardFile = path.join(folder, 'Main.html')
  let createdArtifact = ''
  let foreignArtifact = ''

  it('outside a turn nothing is recorded', async () => {
    await run(tools, 'design_write', { name: 'Rascunho', boards: [board('<p>outside</p>')] })
    expect(await readMediaJournal(sessionId, 'msg0')).toBeNull()
  })

  it('each turn keeps the state BEFORE the first write', async () => {
    await turn(sessionId, 'msg1', async () => {
      await run(tools, 'design_write', { name: 'Landing', boards: [board('<p>A</p>')] })
    })
    await turn(sessionId, 'msg2', async () => {
      await run(tools, 'design_edit', { name: 'Landing', file: 'Main.html', edits: [{ oldText: '<p>A</p>', newText: '<p>B</p>' }] })
      createdArtifact = (await media.saveArtifact('<p>new</p>', { title: 'New', sessionId })).id
    })
    // Another chat writes to the gallery afterwards: the revert of this one cannot take it along.
    foreignArtifact = (await media.saveArtifact('<p>from another chat</p>', { title: 'Other', sessionId: 'other' })).id

    const first = await readMediaJournal(sessionId, 'msg1')
    expect(first?.records).toEqual([expect.objectContaining({ type: 'path', path: folder, backup: null })])
    const second = await readMediaJournal(sessionId, 'msg2')
    expect(second?.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'path', path: folder, backup: expect.any(String) }),
        expect.objectContaining({ type: 'media', id: createdArtifact, before: null }),
      ]),
    )
  })

  it('reverting the second turn restores the canvas and removes only its artifact', async () => {
    const summary = await revertMedia(sessionId, ['msg2'])
    expect(summary).toEqual({ restored: true, pieces: 1, items: 1, conflicts: 0 })
    expect(await fsp.readFile(boardFile, 'utf8')).toBe('<p>A</p>')
    expect(await media.getMediaEntry(createdArtifact)).toBeNull()
    await expect(fsp.stat(path.join(userData, 'orbit-data', 'artifacts', createdArtifact))).rejects.toThrow()
    expect(await media.getMediaEntry(foreignArtifact)).not.toBeNull()
  })

  it('the unrevert gives back what the revert undid', async () => {
    await unrevertMedia(sessionId)
    expect(await fsp.readFile(boardFile, 'utf8')).toBe('<p>B</p>')
    const restored = await media.getMediaEntry(createdArtifact)
    expect(restored).not.toBeNull()
    expect(await fsp.readFile(restored!.path, 'utf8')).toBe('<p>new</p>')
  })

  it('reverting from the first turn deletes the piece created in it and unregisters it', async () => {
    const summary = await revertMedia(sessionId, ['msg1', 'msg2'])
    expect(summary?.restored).toBe(true)
    await expect(fsp.stat(folder)).rejects.toThrow()
    expect(await getDesign(designIdFor(folder))).toBeUndefined()
    // The piece made outside a turn is not the agent's: it stays.
    expect(await fsp.readFile(path.join(designPiecesDir(sessionId), 'rascunho', 'Main.html'), 'utf8')).toBe('<p>outside</p>')
  })

  it('confirming the revert (new message) drops the turn journals and the redo', async () => {
    await discardMediaRevert(sessionId, ['msg1', 'msg2'])
    expect(await readMediaJournal(sessionId, 'msg1')).toBeNull()
    expect(await readMediaJournal(sessionId, 'msg2')).toBeNull()
    await unrevertMedia(sessionId) // no redo: does nothing
    await expect(fsp.stat(folder)).rejects.toThrow()
  })
})

describe('media revert — gallery', () => {
  const sessionId = 'sess2'

  it('an artifact rewritten in the turn goes back to the previous text and revision', async () => {
    const ref = await media.saveArtifact('<p>v1</p>', { title: 'Doc', sessionId })
    await turn(sessionId, 'msg1', async () => {
      await media.updateArtifact(ref.id, '<p>v2</p>')
    })
    expect((await media.getMediaEntry(ref.id))?.revision).toBe(2)

    await revertMedia(sessionId, ['msg1'])
    const entry = await media.getMediaEntry(ref.id)
    expect(entry?.revision ?? 1).toBe(1)
    expect(await fsp.readFile(entry!.path, 'utf8')).toBe('<p>v1</p>')
  })

  it('an image deleted in the turn returns to the gallery, with the file', async () => {
    const id = media.mediaIdFromUrl(await media.saveMedia(Buffer.from('fake-png'), 'png', { source: 'chat', sessionId }))!
    const file = (await media.getMediaEntry(id))!.path
    await turn(sessionId, 'msg2', async () => {
      await media.deleteMedia(id)
    })
    expect(await media.getMediaEntry(id)).toBeNull()

    const summary = await revertMedia(sessionId, ['msg2'])
    expect(summary).toEqual({ restored: true, pieces: 0, items: 1, conflicts: 0 })
    expect(await media.getMediaEntry(id)).not.toBeNull()
    expect(await fsp.readFile(file, 'utf8')).toBe('fake-png')
  })

  it('turns that did not touch media produce no summary', async () => {
    expect(await revertMedia(sessionId, ['msg-sem-midia'])).toBeUndefined()
  })
})

describe('media revert — conflicts', () => {
  it('artifact created in the turn and edited by another conversation later: preserved', async () => {
    const sessionId = 'sess-conflito-a'
    let id = ''
    await turn(sessionId, 'msg1', async () => {
      id = (await media.saveArtifact('<p>v1</p>', { title: 'Compartilhado', sessionId })).id
    })
    // Another conversation edits the SAME artifact afterwards.
    await media.updateArtifact(id, '<p>another conversation</p>')

    const summary = await revertMedia(sessionId, ['msg1'])

    expect(summary).toEqual({
      restored: true,
      pieces: 0,
      items: 0,
      conflicts: 1,
      conflictLabels: ['Compartilhado'],
    })
    const entry = await media.getMediaEntry(id)
    expect(entry?.revision).toBe(2)
    expect(await fsp.readFile(entry!.path, 'utf8')).toBe('<p>another conversation</p>')
  })

  it('piece edited by hand in the panel after the turn: folder and cover preserved', async () => {
    const sessionId = 'sess-conflito-b'
    const tools = createDesignTools({ sessionId })
    const folder = path.join(designPiecesDir(sessionId), 'manual')
    await turn(sessionId, 'msg1', async () => {
      await run(tools, 'design_write', { name: 'Manual', boards: [board('<p>do turno</p>')] })
    })
    const file = path.join(folder, 'Main.html')
    // The person edits in the panel, outside a turn — it does not enter the journal.
    await fsp.writeFile(file, '<p>edited by hand</p>', 'utf8')

    const summary = await revertMedia(sessionId, ['msg1'])

    expect(summary).toMatchObject({ restored: true, pieces: 0, conflicts: 1 })
    expect(await fsp.readFile(file, 'utf8')).toBe('<p>edited by hand</p>')
  })

  it('unrevert: what changed between the revert and the undo is preserved', async () => {
    const sessionId = 'sess-conflito-c'
    const ref = await media.saveArtifact('<p>v1</p>', { title: 'Doc', sessionId })
    await turn(sessionId, 'msg1', async () => {
      await media.updateArtifact(ref.id, '<p>v2</p>')
    })

    const first = await revertMedia(sessionId, ['msg1'])
    expect(first?.conflicts).toBe(0)
    expect((await media.getMediaEntry(ref.id))?.revision ?? 1).toBe(1)

    // Another conversation touches it AFTER the revert, before the unrevert.
    await media.updateArtifact(ref.id, '<p>v3</p>')
    const undone = await unrevertMedia(sessionId)

    expect(undone?.conflicts).toBe(1)
    const entry = await media.getMediaEntry(ref.id)
    // The revert took the revision back to 1; the next external edit becomes 2.
    expect(entry?.revision).toBe(2)
    expect(await fsp.readFile(entry!.path, 'utf8')).toBe('<p>v3</p>')
  })
})

describe('revalidation right before applying', () => {
  it('restorePaths leaves intact the path that changed after the decision', async () => {
    const dir = path.join(userData, 'revalida')
    await fsp.mkdir(dir, { recursive: true })
    const alvo = path.join(dir, 'a.txt')
    const backup = path.join(dir, 'a.backup')
    await fsp.writeFile(alvo, 'mudou no meio', 'utf8')
    await fsp.writeFile(backup, 'before', 'utf8')

    const skipped = await restorePaths(
      [{ type: 'path', path: alvo, backupFile: backup }],
      async () => false,
    )

    expect(skipped).toHaveLength(1)
    expect(await fsp.readFile(alvo, 'utf8')).toBe('mudou no meio')
  })

  it('restoreMediaEntries refuses the entry another conversation wrote in between', async () => {
    const created = await media.saveArtifact('<p>v1</p>', { title: 'Corrida', sessionId: 'sess-corrida' })
    const previous = await media.getMediaEntry(created.id)
    await media.updateArtifact(created.id, '<p>v2</p>')

    const skipped = await media.restoreMediaEntries([{ id: created.id, before: previous }], () => false)

    expect([...skipped]).toEqual([created.id])
    expect((await media.getMediaEntry(created.id))?.revision).toBe(2)
  })
})
