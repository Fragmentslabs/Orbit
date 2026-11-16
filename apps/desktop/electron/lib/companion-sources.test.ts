import { beforeEach, describe, expect, it, vi } from 'vitest'

const docs = vi.hoisted(() => ({
  addSessionDocument: vi.fn(),
  addSessionText: vi.fn(),
  addSessionUrl: vi.fn(),
  listSessionSources: vi.fn(),
  removeSessionDocument: vi.fn(),
  setSessionDocumentShared: vi.fn(),
}))
vi.mock('./session-documents', () => docs)

import {
  addSourceFile,
  addSourceText,
  addSourceUrl,
  listSources,
  removeSource,
  shareSource,
  toCompanionSource,
} from './companion-sources'

const doc = (over = {}) => ({
  id: 'doc1',
  sessionId: 's1',
  filename: 'a.pdf',
  kind: 'pdf' as const,
  totalPages: 3,
  totalChars: 100,
  truncated: false,
  createdAt: 1,
  ...over,
})

beforeEach(() => vi.clearAllMocks())

describe('toCompanionSource', () => {
  it('drops internals and normalizes shared', () => {
    const out = toCompanionSource(doc({ sizeBytes: 5, sourceUrl: 'https://x.dev' }))
    expect(out).toEqual({
      id: 'doc1', filename: 'a.pdf', kind: 'pdf', totalPages: 3, truncated: false,
      sizeBytes: 5, createdAt: 1, shared: false, sourceUrl: 'https://x.dev',
    })
    expect(out).not.toHaveProperty('totalChars')
  })
})

describe('listSources', () => {
  it('maps both areas', async () => {
    docs.listSessionSources.mockResolvedValue({
      shared: [doc({ id: 'src1', shared: true })], own: [doc()], folderId: 'f', usage: 9,
    })
    const out = await listSources('s1')
    expect(out.status).toBe(200)
    expect(out.body).toMatchObject({ folderId: 'f', usage: 9 })
    expect((out.body as { shared: { shared: boolean }[] }).shared[0].shared).toBe(true)
  })
  it('rejects a path-like session id', async () => {
    expect((await listSources('../x')).status).toBe(400)
    expect(docs.listSessionSources).not.toHaveBeenCalled()
  })
})

describe('adding', () => {
  it('uploads a file from base64 into the requested scope', async () => {
    docs.addSessionDocument.mockResolvedValue({ ok: true, doc: doc({ id: 'src3' }) })
    const out = await addSourceFile('s1', { filename: 'a.pdf', data: Buffer.from('hi').toString('base64'), shared: true })
    expect(out).toEqual({ status: 200, body: { id: 'src3' } })
    const [sid, name, bytes, shared] = docs.addSessionDocument.mock.calls[0]
    expect([sid, name, bytes.toString(), shared]).toEqual(['s1', 'a.pdf', 'hi', true])
  })
  it('validates file input and surfaces desktop errors', async () => {
    expect((await addSourceFile('s1', { filename: 'a.pdf' })).status).toBe(400)
    docs.addSessionDocument.mockResolvedValue({ ok: false, error: 'unsupported' })
    const out = await addSourceFile('s1', { filename: 'a.exe', data: 'AAAA' })
    expect(out).toEqual({ status: 422, body: { error: 'unsupported' } })
  })
  it('adds text and defaults to the conversation scope', async () => {
    docs.addSessionText.mockResolvedValue({ ok: true, doc: doc({ id: 'doc2' }) })
    await addSourceText('s1', { title: 't', text: 'body' })
    expect(docs.addSessionText).toHaveBeenCalledWith('s1', 't', 'body', false)
  })
  it('accepts only http(s) urls', async () => {
    expect((await addSourceUrl('s1', { url: 'file:///etc/passwd' })).status).toBe(400)
    docs.addSessionUrl.mockResolvedValue({ ok: true, doc: doc({ id: 'doc4', kind: 'web' }) })
    expect((await addSourceUrl('s1', { url: 'https://a.dev' })).status).toBe(200)
  })
})

describe('share / remove', () => {
  it('returns the new id after a move', async () => {
    docs.setSessionDocumentShared.mockResolvedValue({ ok: true, id: 'src2' })
    expect(await shareSource('s1', 'doc5', { shared: true })).toEqual({ status: 200, body: { id: 'src2' } })
    expect((await shareSource('s1', 'doc5', {})).status).toBe(400)
  })
  it('maps a missing source to 404', async () => {
    docs.removeSessionDocument.mockResolvedValue(false)
    expect((await removeSource('s1', 'doc9')).status).toBe(404)
    docs.removeSessionDocument.mockResolvedValue(true)
    expect((await removeSource('s1', 'doc9')).status).toBe(200)
  })
})
