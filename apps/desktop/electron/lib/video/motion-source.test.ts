import { describe, expect, it, vi } from 'vitest'
import path from 'node:path'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/orbit-test', isPackaged: false },
  BrowserWindow: class {},
  protocol: { handle: () => {} },
}))

const { planPieceFiles, resolveEditFile, truncationReason } = await import('./motion-source')

const FOLDER = path.resolve('/pieces/intro')
const ENTRY = path.join(FOLDER, 'index.html')

describe('truncationReason', () => {
  const doc = (body: string) => `<!doctype html><html><head></head><body>${body}</body></html>`
  it('accepts a complete document and a bare fragment', () => {
    expect(truncationReason(doc('<script>let a = 1</script>'))).toBeNull()
    expect(truncationReason('<div>oi</div>')).toBeNull()
  })
  it('flags a document that stops short', () => {
    expect(truncationReason('<html><body><script>let a =')).toMatch(/closing <\/html>/)
    expect(truncationReason('<html><body><script>x</html>')).toMatch(/<script>/)
    expect(truncationReason('<html><body><style>a{</html>')).toMatch(/<style>/)
  })
  it('ignores tags inside comments', () => {
    expect(truncationReason(doc('<!-- <script> -->'))).toBeNull()
  })
})

describe('planPieceFiles', () => {
  it('plans text files inside the folder', () => {
    const plan = planPieceFiles(FOLDER, ENTRY, { 'scenes/a.js': 'x', 'theme.css': 'y' })
    expect(plan.map((f) => f.name)).toEqual(['scenes/a.js', 'theme.css'])
    expect(plan[0].absolute).toBe(path.join(FOLDER, 'scenes', 'a.js'))
  })
  it('refuses escapes, the entry and binary files', () => {
    expect(() => planPieceFiles(FOLDER, ENTRY, { '../x.js': '' })).toThrow(/inside the composition folder/)
    // A leading slash is stripped, never honoured: it lands INSIDE the folder.
    expect(planPieceFiles(FOLDER, ENTRY, { '/etc/x.js': '' })[0].absolute).toBe(path.join(FOLDER, 'etc', 'x.js'))
    expect(() => planPieceFiles(FOLDER, ENTRY, { 'index.html': '' })).toThrow(/entry/)
    expect(() => planPieceFiles(FOLDER, ENTRY, { 'a.png': '' })).toThrow(/text files/)
  })
  it('returns nothing without files', () => {
    expect(planPieceFiles(FOLDER, ENTRY, undefined)).toEqual([])
  })
})

describe('resolveEditFile', () => {
  it('defaults to the entry and resolves a piece file', () => {
    expect(resolveEditFile(FOLDER, ENTRY, undefined)).toBe(ENTRY)
    expect(resolveEditFile(FOLDER, ENTRY, 'scenes/a.js')).toBe(path.join(FOLDER, 'scenes', 'a.js'))
    expect(() => resolveEditFile(FOLDER, ENTRY, '../a.js')).toThrow()
    expect(() => resolveEditFile(FOLDER, ENTRY, 'clip.mp4')).toThrow(/text file/)
  })
})
