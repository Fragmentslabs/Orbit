import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const userData = path.join(os.tmpdir(), `orbit-doc-source-${Date.now()}`)

vi.mock('electron', () => ({
  app: { getPath: () => userData },
  BrowserWindow: { getAllWindows: () => [] },
  net: {},
  protocol: { handle: () => {} },
  session: {
    fromPartition: () => {
      throw new Error('without Chromium in the test')
    },
  },
  dialog: {},
}))

const { isDocumentSource, useDocumentAsSource } = await import('./document-source')
const { getMediaEntry, saveDocument } = await import('./media')
const { listSessionDocuments, removeSessionDocument } = await import('./session-documents')

const SESSION = 'test-session'

beforeEach(async () => {
  await fsp.rm(userData, { recursive: true, force: true })
})

afterAll(async () => {
  await fsp.rm(userData, { recursive: true, force: true })
})

/**
 * Promoting is the only path between the two spaces — what the agent PRODUCED and
 * what the conversation READS. It is deliberate for content safety (an output that
 * slides into the sources on its own makes the agent cite its own report as
 * evidence), so what these tests protect is that it only happens when
 * asked, and that asking twice does not fill the tab with copies.
 */
describe('promoting a document to source', () => {
  it('takes the Markdown to the conversation sources', async () => {
    const ref = await saveDocument('# Manual\n\nHow to install.', [], { title: 'Manual' })

    const result = await useDocumentAsSource(SESSION, ref.id)

    expect(result.ok).toBe(true)
    const sources = await listSessionDocuments(SESSION)
    expect(sources.map((d) => d.filename)).toEqual(['Manual'])
    // The source id stays noted in the document: it is what makes promoting idempotent.
    expect((await getMediaEntry(ref.id))?.sourceId).toBe(sources[0].id)
  })

  it('promoting again points at the same source, without duplicating', async () => {
    const ref = await saveDocument('# Manual\n\nBody.', [], { title: 'Manual' })
    const first = await useDocumentAsSource(SESSION, ref.id)

    const second = await useDocumentAsSource(SESSION, ref.id)

    expect(second).toEqual({
      ok: true,
      sourceId: first.ok ? first.sourceId : '',
      already: true,
    })
    expect(await listSessionDocuments(SESSION)).toHaveLength(1)
  })

  it('once the source is removed, promoting restores it instead of assuming it exists', async () => {
    const ref = await saveDocument('# Manual\n\nBody.', [], { title: 'Manual' })
    const first = await useDocumentAsSource(SESSION, ref.id)
    await removeSessionDocument(SESSION, first.ok ? first.sourceId : '')
    expect(await listSessionDocuments(SESSION)).toHaveLength(0)

    const again = await useDocumentAsSource(SESSION, ref.id)

    expect(again).toMatchObject({ ok: true, already: false })
    expect(await listSessionDocuments(SESSION)).toHaveLength(1)
  })

  it('a document that does not exist does not become a source', async () => {
    expect(await useDocumentAsSource(SESSION, 'doc_missing.md')).toMatchObject({ ok: false })
    expect(await listSessionDocuments(SESSION)).toHaveLength(0)
  })
})

/**
 * The pill's state comes FROM HERE, and not from a boolean stored on the screen: the
 * source may be removed in the Sources tab at any moment, and then the button has
 * to offer the promotion again instead of pretending the document is already there.
 */
describe('source state', () => {
  it('follows promote and remove', async () => {
    const ref = await saveDocument('# Manual\n\nBody.', [], { title: 'Manual' })
    expect(await isDocumentSource(SESSION, ref.id)).toBe(false)

    const added = await useDocumentAsSource(SESSION, ref.id)
    expect(await isDocumentSource(SESSION, ref.id)).toBe(true)

    await removeSessionDocument(SESSION, added.ok ? added.sourceId : '')
    // The `sourceId` stays noted in the document, but the source no longer exists:
    // what counts is the list, not the note.
    expect(await isDocumentSource(SESSION, ref.id)).toBe(false)
  })

  it('another conversation does not inherit the source', async () => {
    const ref = await saveDocument('# Manual\n\nBody.', [], { title: 'Manual' })
    await useDocumentAsSource(SESSION, ref.id)

    expect(await isDocumentSource('other-session', ref.id)).toBe(false)
  })
})
