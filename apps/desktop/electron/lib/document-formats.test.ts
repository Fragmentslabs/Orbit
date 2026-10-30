import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const userData = path.join(os.tmpdir(), `orbit-doc-formats-${Date.now()}`)

/**
 * Chromium does not exist here, so `session.fromPartition` blows up — and that is
 * exactly what these tests want: the thumbnail capture and the PDF generation
 * are best-effort, and failing at them cannot bring the document's creation
 * down. The .docx does not depend on any window (it is ZIP + XML), so it is through
 * it that the success path is verified.
 */
vi.mock('electron', () => ({
  app: { getPath: () => userData },
  BrowserWindow: {
    getAllWindows: () => [],
  },
  net: {},
  protocol: { handle: () => {} },
  session: {
    fromPartition: () => {
      throw new Error('without Chromium in the test')
    },
  },
  dialog: {},
}))

const { documentInfo, ensureDocumentRender, saveDerivedDocx, saveDocument, saveDocumentEdit, updateDocument } =
  await import('./media')
const { documentOpensAsFile } = await import('@shared/media')

/** The .docx text, to check WHICH version the delivered file carries. */
async function docxText(file: string): Promise<string> {
  const JSZip = (await import('jszip')).default
  const zip = await JSZip.loadAsync(await fsp.readFile(file))
  return zip.file('word/document.xml')!.async('string')
}

const documentsDir = path.join(userData, 'orbit-data', 'documents')

/** The sibling files of a document, by extension. */
async function siblings(id: string): Promise<string[]> {
  const base = id.replace(/\.md$/, '')
  const names = await fsp.readdir(documentsDir)
  return names
    .filter((name) => name.startsWith(base))
    .map((name) => name.slice(base.length))
    .sort()
}

beforeEach(async () => {
  await fsp.rm(userData, { recursive: true, force: true })
})

afterAll(async () => {
  await fsp.rm(userData, { recursive: true, force: true })
})

describe('a document is born as Markdown', () => {
  it('without formats, saves only the source and the preview', async () => {
    const ref = await saveDocument('# Report\n\nBody of the text.', [], { title: 'Report' })

    expect(ref.formats).toEqual([])
    expect(await siblings(ref.id)).toEqual(['.html', '.md'])
  })

  it('with formats requested, renders on creation', async () => {
    const ref = await saveDocument('# Proposal\n\nBody.', ['docx'], { title: 'Proposal' })

    expect(ref.formats).toEqual(['docx'])
    expect(await siblings(ref.id)).toContain('.docx')
  })

  it('editing does not invent a render nobody asked for', async () => {
    const ref = await saveDocument('# Minutes\n\nFirst version.', [], { title: 'Minutes' })
    const updated = await updateDocument(ref.id, '# Minutes\n\nSecond version.', {})

    expect(updated.ok && updated.ref.formats).toEqual([])
    expect(updated.ok && updated.ref.revision).toBe(2)
    expect(await siblings(ref.id)).toEqual(['.html', '.md'])
  })
})

describe('rendering on demand', () => {
  it('generates the file on the first request and registers it', async () => {
    const ref = await saveDocument('# Manual\n\n- one\n- two', [], { title: 'Manual' })
    expect(await siblings(ref.id)).not.toContain('.docx')

    const file = await ensureDocumentRender(ref.id, 'docx')

    expect(file).toBe(path.join(documentsDir, ref.id.replace(/\.md$/, '.docx')))
    expect(await siblings(ref.id)).toContain('.docx')
  })

  it('the second request reuses what is on disk', async () => {
    const ref = await saveDocument('# Manual\n\nBody.', [], { title: 'Manual' })
    const first = await ensureDocumentRender(ref.id, 'docx')
    const stamp = (await fsp.stat(first!)).mtimeMs

    const second = await ensureDocumentRender(ref.id, 'docx')

    expect(second).toBe(first)
    expect((await fsp.stat(second!)).mtimeMs).toBe(stamp)
  })

  it('regenerates when the file vanished from disk behind our back', async () => {
    const ref = await saveDocument('# Manual\n\nBody.', [], { title: 'Manual' })
    const file = (await ensureDocumentRender(ref.id, 'docx'))!
    await fsp.rm(file)

    expect(await ensureDocumentRender(ref.id, 'docx')).toBe(file)
    expect(await siblings(ref.id)).toContain('.docx')
  })

  it('a document that does not exist generates nothing', async () => {
    expect(await ensureDocumentRender('doc_missing.md', 'docx')).toBeNull()
  })
})

describe('derived document', () => {
  it('is not converted on demand: what it has is the file, not a source', async () => {
    // Bytes that are not a real .docx: mammoth fails, the preview falls back to the
    // unavailable text and the record is born the same as an edited copy's.
    const ref = await saveDerivedDocx(Buffer.from('not a docx'), {
      title: 'Revised contract',
      sourceName: 'contract.docx',
    })

    expect(ref.formats).toEqual(['docx'])
    expect(await ensureDocumentRender(ref.id, 'pdf')).toBeNull()
    expect(await siblings(ref.id)).not.toContain('.pdf')
  })
})

describe('document destination', () => {
  it('without formats, it is a live document: opens in the canvas', async () => {
    const ref = await saveDocument('# Notes\n\nBody.', [], { title: 'Notes' })
    const info = (await documentInfo(ref.id))!

    expect(info.delivery).toBeUndefined()
    expect(documentOpensAsFile(info)).toBe(false)
  })

  it('requested as a file, opens in the viewer', async () => {
    const ref = await saveDocument('# Contract\n\nBody.', ['docx'], { title: 'Contract' })
    const info = (await documentInfo(ref.id))!

    expect(info.delivery).toEqual(['docx'])
    expect(documentOpensAsFile(info)).toBe(true)
  })

  it('downloading a live document does not turn it into a file', async () => {
    const ref = await saveDocument('# Notes\n\nBody.', [], { title: 'Notes' })
    await ensureDocumentRender(ref.id, 'docx')
    const info = (await documentInfo(ref.id))!

    // The cache grew, the destination did not: it is still a document to edit.
    expect(info.formats).toEqual(['docx'])
    expect(documentOpensAsFile(info)).toBe(false)
  })

  it('requesting the format later changes the destination', async () => {
    const ref = await saveDocument('# Notes\n\nBody.', [], { title: 'Notes' })
    await updateDocument(ref.id, '# Notes\n\nRevised body.', { formats: ['docx'] })

    expect(documentOpensAsFile((await documentInfo(ref.id))!)).toBe(true)
  })
})

describe('user edit in the canvas', () => {
  it('saves the source and advances the revision', async () => {
    const ref = await saveDocument('# Minutes\n\nFirst.', [], { title: 'Minutes' })

    const result = await saveDocumentEdit(ref.id, '# Minutes\n\nHandwritten.')

    expect(result.ok && result.revision).toBe(2)
    expect(await fsp.readFile(path.join(documentsDir, ref.id), 'utf8')).toContain('Handwritten.')
  })

  it('the file downloaded after the edit carries the new text', async () => {
    const ref = await saveDocument('# Manual\n\nAgent version.', [], { title: 'Manual' })
    const before = (await ensureDocumentRender(ref.id, 'docx'))!
    expect(await docxText(before)).toContain('Agent version')

    await saveDocumentEdit(ref.id, '# Manual\n\nUser version.')
    const after = (await ensureDocumentRender(ref.id, 'docx'))!

    expect(await docxText(after)).toContain('User version')
    expect(await docxText(after)).not.toContain('Agent version')
  })

  it('a derived one is not editable: its Markdown is only a note', async () => {
    const ref = await saveDerivedDocx(Buffer.from('not a docx'), { title: 'Revised contract' })

    expect(await saveDocumentEdit(ref.id, '# Reescrito')).toEqual({
      ok: false,
      reason: 'notFound',
    })
  })

  it('refuses a save based on a version the agent already replaced', async () => {
    const ref = await saveDocument('# Minutes\n\nFrom the agent.', [], { title: 'Minutes' })
    const openRevision = (await documentInfo(ref.id))!.revision ?? 1
    await updateDocument(ref.id, '# Minutes\n\nSecond from the agent.', {})

    const result = await saveDocumentEdit(ref.id, '# Minutes\n\nFrom the user.', openRevision)

    expect(result).toEqual({ ok: false, reason: 'stale', revision: 2 })
    expect(await fsp.readFile(path.join(documentsDir, ref.id), 'utf8')).toContain(
      'Second from the agent.',
    )
  })
})

/**
 * The agent reads, the user edits in the canvas, the agent writes: without a guard, the
 * rewrite would silently erase what the person just typed. It is the only
 * path in this module in which work is lost, so it is the most covered one.
 */
describe('agent writing over the user edit', () => {
  /** What is written now — what matters is whether the rewrite WENT IN. */
  async function sourceOf(id: string): Promise<string> {
    return fsp.readFile(path.join(documentsDir, id), 'utf8')
  }

  it('refuses the rewrite based on an old version, saving nothing', async () => {
    const ref = await saveDocument('# Minutes\n\nFrom the agent.', [], { title: 'Minutes' })
    const readRevision = (await documentInfo(ref.id))!.revision ?? 1
    await saveDocumentEdit(ref.id, '# Minutes\n\nFrom the user.')

    const result = await updateDocument(ref.id, '# Minutes\n\nBlind rewrite.', {
      baseRevision: readRevision,
    })

    expect(result).toEqual({ ok: false, reason: 'stale', revision: 2 })
    expect(await sourceOf(ref.id)).toContain('From the user.')
  })

  it('also refuses without baseRevision, when there is a pending human edit', async () => {
    const ref = await saveDocument('# Minutes\n\nFrom the agent.', [], { title: 'Minutes' })
    await saveDocumentEdit(ref.id, '# Minutes\n\nFrom the user.')

    const result = await updateDocument(ref.id, '# Minutes\n\nBlind rewrite.', {})

    expect(result.ok).toBe(false)
    expect(await sourceOf(ref.id)).toContain('From the user.')
  })

  it('accepts when the agent started from the version on disk', async () => {
    const ref = await saveDocument('# Minutes\n\nFrom the agent.', [], { title: 'Minutes' })
    await saveDocumentEdit(ref.id, '# Minutes\n\nFrom the user.')
    const current = (await documentInfo(ref.id))!.revision!

    const result = await updateDocument(ref.id, '# Minutes\n\nFrom the agent, over the user one.', {
      baseRevision: current,
    })

    expect(result.ok).toBe(true)
    expect(await sourceOf(ref.id)).toContain('over the user one')
  })

  it('after the agent sees the user version, writing becomes free again', async () => {
    const ref = await saveDocument('# Minutes\n\nFrom the agent.', [], { title: 'Minutes' })
    await saveDocumentEdit(ref.id, '# Minutes\n\nFrom the user.')
    const current = (await documentInfo(ref.id))!.revision!
    await updateDocument(ref.id, '# Minutes\n\nFirst from the agent.', { baseRevision: current })

    // With no pending human edit, rewriting without baseRevision still counts:
    // it is the case of whoever wrote the text from scratch and read nothing.
    const result = await updateDocument(ref.id, '# Minutes\n\nSecond from the agent.', {})

    expect(result.ok).toBe(true)
    expect(await sourceOf(ref.id)).toContain('Second from the agent')
  })

  it('a document the user never touched still accepts a direct rewrite', async () => {
    const ref = await saveDocument('# Minutes\n\nFirst.', [], { title: 'Minutes' })

    expect((await updateDocument(ref.id, '# Minutes\n\nSecond.', {})).ok).toBe(true)
  })
})
