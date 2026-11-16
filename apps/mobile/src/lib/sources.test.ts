import { describe, expect, it } from 'vitest'
import { formatBytes, hostOf, normalizeSourceUrl, sortSources, sourceTypeLabel, sourceUnitKey } from './sources'

const src = (over: object = {}) =>
  ({ id: 'doc1', filename: 'a.pdf', kind: 'pdf', totalPages: 1, truncated: false, createdAt: 1, shared: false, ...over }) as never

describe('normalizeSourceUrl', () => {
  it('adds https and keeps full addresses', () => {
    expect(normalizeSourceUrl('example.com/a')).toBe('https://example.com/a')
    expect(normalizeSourceUrl(' http://example.com ')).toBe('http://example.com/')
  })
  it('rejects other schemes, spaces and bare words', () => {
    expect(normalizeSourceUrl('file:///etc/passwd')).toBeNull()
    expect(normalizeSourceUrl('javascript:alert(1)')).toBeNull()
    expect(normalizeSourceUrl('not a url')).toBeNull()
    expect(normalizeSourceUrl('word')).toBeNull()
    expect(normalizeSourceUrl('')).toBeNull()
  })
})

describe('sourceTypeLabel', () => {
  it('uses the extension, never for sites or numeric tails', () => {
    expect(sourceTypeLabel(src({ filename: 'x.md', kind: 'text' }))).toBe('MD')
    expect(sourceTypeLabel(src({ filename: 'Example.com', kind: 'web' }))).toBeNull()
    expect(sourceTypeLabel(src({ filename: 'Sales 2026.1', kind: 'text' }))).toBeNull()
    expect(sourceTypeLabel(src({ filename: 'Pasted text', kind: 'text' }))).toBeNull()
  })
})

describe('helpers', () => {
  it('formats bytes', () => {
    expect(formatBytes(10)).toBe('10 B')
    expect(formatBytes(2048)).toBe('2 KB')
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB')
  })
  it('extracts the host', () => {
    expect(hostOf('https://www.example.com/x')).toBe('example.com')
    expect(hostOf('nonsense')).toBe('nonsense')
  })
  it('picks the unit and sorts newest first', () => {
    expect(sourceUnitKey('spreadsheet')).toBe('unitSheets')
    expect(sourceUnitKey('docx')).toBe('unitBlocks')
    expect(sourceUnitKey('pdf')).toBe('unitPages')
    expect(sortSources([src({ id: 'a', createdAt: 1 }), src({ id: 'b', createdAt: 2 })]).map((s) => s.id)).toEqual(['b', 'a'])
  })
})
