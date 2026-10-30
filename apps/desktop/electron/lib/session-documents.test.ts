import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * Folder scope of the sources, from the point of view of WHO ASKS.
 *
 * The module does not look at the session mode anywhere — what it reads is the
 * `folderId` of the persisted SessionInfo. That is what makes the Sources tab count
 * the same in chat and in code, where the folder is created automatically per
 * repository: the "shared" area of a code session is that repo's reference
 * material, visible in all of its conversations.
 *
 * The tests below close exactly that pair — what crosses, what does not
 * cross, and what happens to the session that is in no folder at all.
 */

const userData = path.join(os.tmpdir(), `orbit-docs-test-${process.pid}`)

vi.mock('electron', () => ({
  app: { getPath: () => userData },
  // The module notifies the windows on every change (documents:changed). With no
  // window open the notice has nowhere to go, which is the case here.
  BrowserWindow: { getAllWindows: () => [] },
  dialog: {},
}))

const storageDir = path.join(userData, 'orbit-data', 'storage', 'session')

/** A session as the renderer persists it — the main only reads this file. */
async function persistSession(id: string, folderId: string | null, mode: 'chat' | 'code') {
  await fsp.mkdir(storageDir, { recursive: true })
  await fsp.writeFile(
    path.join(storageDir, `${id}.json`),
    JSON.stringify({
      id,
      title: id,
      mode,
      directory: mode === 'code' ? 'C:/Projects/Orbit' : undefined,
      folderId,
      pinned: false,
      archived: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  )
}

const FOLDER = 'folderrepo1'

let docs: typeof import('./session-documents')

beforeAll(async () => {
  docs = await import('./session-documents')
  // Two code conversations of the same repository + one outside any folder.
  await persistSession('conva', FOLDER, 'code')
  await persistSession('convb', FOLDER, 'code')
  await persistSession('convloose', null, 'code')
})

afterAll(async () => {
  await fsp.rm(userData, { recursive: true, force: true })
})

describe('sources in code mode', () => {
  it('reads the folderId of the persisted session, without looking at the mode', async () => {
    expect(await docs.documentFolderId('conva')).toBe(FOLDER)
    expect(await docs.documentFolderId('convloose')).toBeNull()
  })

  it('the folder source crosses the conversations of the same repository; the attachment does not', async () => {
    const source = await docs.addSessionText('conva', 'Client spec', 'Retention is 4.5% per month.', true)
    const attachment = await docs.addSessionText('conva', 'Draft', 'This only applies here.', false)
    expect(source.ok).toBe(true)
    expect(attachment.ok).toBe(true)
    if (!source.ok || !attachment.ok) return

    // The prefix is what says where the file lives — src in the folder, doc in the session.
    expect(source.doc.id).toMatch(/^src\d+$/)
    expect(attachment.doc.id).toMatch(/^doc\d+$/)

    const other = await docs.listSessionSources('convb')
    expect(other.folderId).toBe(FOLDER)
    expect(other.shared.map((d) => d.id)).toContain(source.doc.id)
    // A's attachment belongs to A: the other conversation of the same repo does not see it.
    expect(other.own).toHaveLength(0)
  })

  it('the other conversation can READ the content of the folder source', async () => {
    const list = await docs.listSessionSources('convb')
    const id = list.shared[0]?.id
    expect(id).toBeDefined()
    const read = await docs.readSessionDocument('convb', id!)
    expect(read?.extracted.pages.map((p) => p.text).join('\n')).toContain('4.5%')
  })

  it('a conversation outside a folder does not see the shared one, and does not break', async () => {
    const loose = await docs.listSessionSources('convloose')
    expect(loose.folderId).toBeNull()
    expect(loose.shared).toHaveLength(0)
  })

  it('promoting the attachment (the drag between the areas) publishes it to the repository', async () => {
    const before = await docs.listSessionSources('conva')
    const attachment = before.own[0]
    expect(attachment).toBeDefined()

    expect(await docs.setSessionDocumentShared('conva', attachment!.id, true)).toBeTruthy()

    const after = await docs.listSessionSources('convb')
    expect(after.shared).toHaveLength(2)
    // When changing area the id changes namespace — otherwise two docN of different
    // conversations would collide inside the folder.
    expect(after.shared.every((d) => /^src\d+$/.test(d.id))).toBe(true)
    expect(new Set(after.shared.map((d) => d.id)).size).toBe(2)
  })

  it('the thumbnail is generated once and cached in the document scope', async () => {
    const newDoc = await docs.addSessionText('convb', 'Report', 'Line one\nLine two', false)
    expect(newDoc.ok).toBe(true)
    if (!newDoc.ok) return

    const thumb = await docs.sessionDocumentThumb('convb', newDoc.doc.id)
    expect(thumb).toMatch(/^data:image\/webp;base64,/)

    const cache = path.join(userData, 'orbit-data', 'session-docs', 'convb', `${newDoc.doc.id}.thumb.webp`)
    await expect(fsp.access(cache)).resolves.toBeUndefined()

    // The second call does not redraw: it is the same file coming back.
    expect(await docs.sessionDocumentThumb('convb', newDoc.doc.id)).toBe(thumb)

    // And it disappears along with the document — an orphan cache would become another id's cover.
    await docs.removeSessionDocument('convb', newDoc.doc.id)
    await expect(fsp.access(cache)).rejects.toThrow()
  })

  it('the thumbnail follows the document when it changes area', async () => {
    const attachment = await docs.addSessionText('conva', 'Note', 'Note content', false)
    expect(attachment.ok).toBe(true)
    if (!attachment.ok) return
    await docs.sessionDocumentThumb('conva', attachment.doc.id)

    const moved = await docs.setSessionDocumentShared('conva', attachment.doc.id, true)
    expect(moved).toBeTruthy()
    const newId = (moved as { ok: true; id: string }).id

    const target = path.join(
      userData,
      'orbit-data',
      'session-docs',
      `folder-${FOLDER}`,
      `${newId}.thumb.webp`,
    )
    await expect(fsp.access(target)).resolves.toBeUndefined()
  })

  it('a folder draft already sees its sources, before the first message', async () => {
    // A chat opened from a folder's "+" belongs to it from the click. Without
    // this the Sources tab would show the shared area empty precisely in the
    // chat that was created from a folder.
    const source = await docs.addSessionText('conva', 'Folder manual', 'Shared content', true)
    expect(source.ok).toBe(true)
    if (!source.ok) return

    // Loose draft: it sees nothing from the folder.
    await docs.setDraftFolder(null)
    expect((await docs.listSessionSources('draft')).shared).toHaveLength(0)

    // Draft of the folder: it sees.
    await docs.setDraftFolder(FOLDER)
    const fromFolder = await docs.listSessionSources('draft')
    expect(fromFolder.folderId).toBe(FOLDER)
    expect(fromFolder.shared.map((d) => d.id)).toContain(source.doc.id)

    // And the marker does not count as the user's material: a session of the SAME
    // folder and without attachments of its own has to report exactly the same number.
    // Without the exclusion, the draft would show up with a few bytes more out of nowhere.
    await persistSession('convvazia', FOLDER, 'code')
    expect(fromFolder.usage).toBe((await docs.listSessionSources('convvazia')).usage)

    await docs.setDraftFolder(null)
  })

  it('the draft does not become a ghost session in the conversation list', async () => {
    // The draft's folder lives in the documents scope, and not as a session
    // record: the sidebar reads the sessions from the storage and would show a "draft".
    await docs.setDraftFolder(FOLDER)
    const dir = path.join(userData, 'orbit-data', 'storage', 'session')
    const files = await fsp.readdir(dir)
    expect(files).not.toContain('draft.json')
    await docs.setDraftFolder(null)
  })

  it('clicking a source in the new chat: an empty sessionId resolves the draft', async () => {
    // The draft's Sources tab lives without a session, and the panel opens the source with
    // an empty sessionId. Before this that became "document not found": the list
    // showed the file and clicking it opened nothing.
    const draft = await docs.addSessionText('draft', 'New chat notes', 'First line', false)
    expect(draft.ok).toBe(true)
    if (!draft.ok) return

    const read = await docs.readSessionDocument('', draft.doc.id)
    expect(read?.extracted.pages.map((p) => p.text).join('\n')).toContain('First line')
  })

  it('.md/.txt come in through the Sources tab as text sources; a disguised binary does not', async () => {
    // Its own session: its sources do not enter the folder tests' count.
    await persistSession('convmd', null, 'chat')
    const md = await docs.addSessionDocument('convmd', 'architecture.md', Buffer.from('# Heading\n\nText.'), false)
    expect(md.ok).toBe(true)
    if (!md.ok) return
    expect(md.doc.kind).toBe('text')
    // The content goes through the same reader as the other sources.
    const read = await docs.readSessionDocument('convmd', md.doc.id)
    expect(read?.extracted.pages[0]?.text).toContain('# Heading')

    const binary = await docs.addSessionDocument('convmd', 'fake.md', Buffer.from([0, 1, 2, 3]), false)
    expect(binary.ok).toBe(false)
  })

  it('deleting the folder takes its sources, and only them', async () => {
    await docs.addSessionText('conva', 'Only from this conversation', 'text', false)
    await docs.deleteFolderDocuments(FOLDER)

    const list = await docs.listSessionSources('conva')
    expect(list.shared).toHaveLength(0)
    expect(list.own).toHaveLength(1)
  })
})
