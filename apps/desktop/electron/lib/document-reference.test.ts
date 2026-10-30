import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * A document's address after it changes area.
 *
 * The id is the address AND the place: `doc1` is an attachment of the conversation, `src1` is a source of the
 * folder. Dragging the file from one area to the other swaps one for the other — and
 * everything already WRITTEN with the old address stays written. The citations
 * in the answer ("[1](#orbit-source/doc1/p12L2)") and the attachment chip keep the id
 * from the day of the send; the history is not rewritten on disk.
 *
 * With no trace, clicking that citation stopped opening the document and said
 * nothing — the Sources tab kept showing the file, which made it look like
 * the conversation had lost its memory. It is this pair (the trace, and the rescue of what
 * was moved before the trace existed) that these tests pin down.
 */

const userData = path.join(os.tmpdir(), `orbit-ref-test-${process.pid}`)

vi.mock('electron', () => ({
  app: { getPath: () => userData },
  BrowserWindow: { getAllWindows: () => [] },
  dialog: {},
}))

const FOLDER = 'pastaum'
const scope = (name: string) => path.join(userData, 'orbit-data', 'session-docs', name)

async function persistSession(id: string, folderId: string | null) {
  const dir = path.join(userData, 'orbit-data', 'storage', 'session')
  await fsp.mkdir(dir, { recursive: true })
  await fsp.writeFile(
    path.join(dir, `${id}.json`),
    JSON.stringify({ id, title: id, mode: 'chat', folderId, createdAt: 1, updatedAt: 1 }),
  )
}

let docs: typeof import('./session-documents')

/** Attachment of the conversation, later promoted to a source of the folder — the tab drag. */
async function attachAndPromote(sessionId: string, title: string, text: string) {
  const attachment = await docs.addSessionText(sessionId, title, text, false)
  if (!attachment.ok) throw new Error(attachment.error)
  const moved = await docs.setSessionDocumentShared(sessionId, attachment.doc.id, true)
  if (!moved.ok) throw new Error(moved.error)
  return { before: attachment.doc.id, now: moved.id }
}

/** Deletes the trace: it is the state of whoever promoted the file before this existed. */
async function forgetTrace(sessionId: string, docId: string) {
  await fsp.rm(path.join(scope(sessionId), `${docId}.moved.json`), { force: true })
}

beforeAll(async () => {
  docs = await import('./session-documents')
  for (const id of ['conv1', 'conv2', 'conv3', 'conv4', 'convsolta']) {
    await persistSession(id, id === 'convsolta' ? null : FOLDER)
  }
})

afterAll(async () => {
  await fsp.rm(userData, { recursive: true, force: true })
})

describe('document reference that changed area', () => {
  it('the old citation still opens the file, and the panel shows the new id', async () => {
    const { before, now } = await attachAndPromote('conv1', 'Topologies', 'The bus is p12.')
    expect(before).toMatch(/^doc\d+$/)
    expect(now).toMatch(/^src\d+$/)

    // This is the citation click: the address written in the conversation.
    const view = await docs.readSessionText('conv1', before)
    expect(view?.filename).toBe('Topologies')
    expect(view?.pages[0]?.lines.join('\n')).toContain('bus')
    // And the panel shows where it went, otherwise the id change would look like
    // the wrong file opened instead of the right one.
    expect(view?.id).toBe(now)
    expect(view?.movedFrom).toBe(before)
  })

  it('the id still valid gets no change warning', async () => {
    const list = await docs.listSessionSources('conv1')
    const id = list.shared[0]!.id
    const view = await docs.readSessionText('conv1', id)
    expect(view?.id).toBe(id)
    expect(view?.movedFrom).toBeUndefined()
  })

  it('the trace belongs to the conversation that moved it: the doc1 of ANOTHER conversation does not come along', async () => {
    // Each chat has its own doc1. Following someone else's trace would open, under the citation
    // from conv2, a file that was never in it.
    expect(await docs.readSessionText('conv2', 'doc1')).toBeNull()
  })

  it('recovers what was promoted BEFORE the trace existed', async () => {
    // The fix has to count for the conversations that already lost the reference
    // — they are the reason for it. With no trace, the proof is the source's record, which
    // keeps from which conversation the file came.
    const { before, now } = await attachAndPromote('conv3', 'Contract', 'Clause 4.')
    await forgetTrace('conv3', before)

    const view = await docs.readSessionText('conv3', before)
    expect(view?.filename).toBe('Contract')
    expect(view?.id).toBe(now)
    expect(view?.movedFrom).toBe(before)
  })

  it('with two candidates the recovery GIVES UP, instead of opening the wrong file', async () => {
    // Opening the wrong document under a citation is worse than opening
    // nothing: the quoted stretch starts pointing to a text that is not its own.
    const one = await attachAndPromote('conv4', 'Exam', 'Question 1.')
    const two = await attachAndPromote('conv4', 'Form', 'Name field.')
    await forgetTrace('conv4', one.before)
    await forgetTrace('conv4', two.before)

    expect(await docs.readSessionText('conv4', one.before)).toBeNull()
    expect(await docs.readSessionText('conv4', two.before)).toBeNull()

    // With the trace in place, the same two resolve again — the ambiguity
    // was from the absence of proof, not from the case.
    const third = await attachAndPromote('conv4', 'Minutes', 'March meeting.')
    expect((await docs.readSessionText('conv4', third.before))?.filename).toBe('Minutes')
  })

  it('an id the conversation never handed out does not resolve — the model invents ids', async () => {
    // The system prompt's example uses `doc1` literally, so an invented
    // id is not a remote hypothesis. The scope's counter is what refutes it.
    expect(await docs.readSessionText('conv3', 'doc99')).toBeNull()
  })

  it('going back and forth between the areas does not lose the original address', async () => {
    const { before, now } = await attachAndPromote('conv1', 'Spreadsheet', 'Total: 10')
    const backAgain = await docs.setSessionDocumentShared('conv1', now, false)
    expect(backAgain.ok).toBe(true)
    if (!backAgain.ok) return

    // doc1 → src1 → doc2, followed end to end.
    const view = await docs.readSessionText('conv1', before)
    expect(view?.filename).toBe('Spreadsheet')
    expect(view?.id).toBe(backAgain.id)
  })

  it('the trace returns the address, not permission: demoted it leaves the folder scope', async () => {
    // While it was src, the other conversation of the folder could cite it. Demoted, the
    // file became private to conv1 — and the trace cannot break that.
    const { now } = await attachAndPromote('conv1', 'Private', 'Only mine.')
    expect((await docs.readSessionText('conv2', now))?.filename).toBe('Private')

    const backAgain = await docs.setSessionDocumentShared('conv1', now, false)
    expect(backAgain.ok).toBe(true)
    expect(await docs.readSessionText('conv2', now)).toBeNull()
    expect((await docs.readSessionText('conv1', now))?.filename).toBe('Private')
  })

  it('the trace does not show up as a document nor is charged as material', async () => {
    // It lives in the same directory as the records and ends in .json: without
    // care, it would enter the tab's list as a ghost source.
    const list = await docs.listSessionSources('conv1')
    expect(list.own.every((d) => /^doc\d+$/.test(d.id))).toBe(true)
    expect(list.shared.every((d) => /^src\d+$/.test(d.id))).toBe(true)

    const before = (await docs.listSessionSources('convsolta')).usage
    const attachment = await docs.addSessionText('convsolta', 'Note', 'x', false)
    expect(attachment.ok).toBe(true)
    if (!attachment.ok) return
    const withAttachment = (await docs.listSessionSources('convsolta')).usage
    expect(withAttachment).toBeGreaterThan(before)
  })
})
