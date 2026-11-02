import { describe, expect, it, vi } from 'vitest'
import path from 'node:path'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/orbit-test', isPackaged: false },
  BrowserWindow: class {},
  protocol: { handle: () => {} },
}))

const { planPieceFiles, resolveEditFile, truncationReason, unflattenHtml } = await import('./motion-source')

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

describe('unflattenHtml', () => {
  const flat = '<!doctype html>\\n<html>\\n<head></head>\\n<body>\\n<p>oi</p>\\n</body>\\n</html>'
  it('restores the line breaks of an html that arrived on ONE line with literal \\n', () => {
    const out = unflattenHtml(flat)
    expect(out.fixed).toBe(true)
    expect(out.html.split('\n')).toHaveLength(7)
    expect(out.html).not.toContain('\\n')
  })
  it('leaves a real document, and a minified page with a "\\n" inside a string, alone', () => {
    expect(unflattenHtml('<p>a</p>\n<p>b</p>')).toEqual({ html: '<p>a</p>\n<p>b</p>', fixed: false })
    const minified = '<script>const s="a\\nb"</script>'
    expect(unflattenHtml(minified)).toEqual({ html: minified, fixed: false })
  })
})
