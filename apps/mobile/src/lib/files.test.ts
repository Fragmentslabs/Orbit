import { describe, expect, it } from 'vitest'
import {
  autoIndentNewline,
  breadcrumbs,
  categoryOf,
  extensionOf,
  findMatches,
  formatBytes,
  insertChar,
  insertPair,
  insertTab,
  languageOf,
  lineCount,
  lineOfOffset,
  longestLine,
  outdent,
  parentPath,
  stepIndex,
 splitTokensByLine } from './files'


describe('names', () => {
  it('reads extensions, dotfiles included', () => {
    expect(extensionOf('src/App.TSX')).toBe('tsx')
    expect(extensionOf('.gitignore')).toBe('gitignore')
    expect(extensionOf('Makefile')).toBe('')
  })
  it('categorizes and picks a highlight language', () => {
    expect(categoryOf('a.ts')).toBe('code')
    expect(categoryOf('Dockerfile')).toBe('code')
    expect(categoryOf('x.png')).toBe('image')
    expect(categoryOf('x.weird')).toBe('other')
    expect(languageOf('Dockerfile')).toBe('docker')
    expect(languageOf('a.jsonc')).toBe('json')
    expect(languageOf('LICENSE')).toBeUndefined()
  })
  it('formats sizes', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2.0 KB')
    expect(formatBytes(50 * 1024)).toBe('50 KB')
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB')
  })
})

describe('paths', () => {
  it('builds breadcrumbs and parents', () => {
    expect(breadcrumbs('a/b', 'proj')).toEqual([
      { name: 'proj', path: '' },
      { name: 'a', path: 'a' },
      { name: 'b', path: 'a/b' },
    ])
    expect(parentPath('a/b/c.ts')).toBe('a/b')
    expect(parentPath('c.ts')).toBe('')
  })
})

describe('text metrics', () => {
  it('counts lines and the longest line', () => {
    expect(lineCount('')).toBe(1)
    expect(lineCount('a\nb\n')).toBe(3)
    expect(longestLine('ab\nabcd\nabc')).toBe(4)
    expect(lineOfOffset('a\nb\nc', 4)).toBe(2)
  })
})

describe('find', () => {
  it('finds case-insensitively by default and wraps stepping', () => {
    expect(findMatches('Foo foo FOO', 'foo')).toEqual([0, 4, 8])
    expect(findMatches('Foo foo FOO', 'foo', { caseSensitive: true })).toEqual([4])
    expect(findMatches('abc', '')).toEqual([])
    expect(stepIndex(2, 3, 1)).toBe(0)
    expect(stepIndex(0, 3, -1)).toBe(2)
    expect(stepIndex(-1, 3, 1)).toBe(0)
    expect(stepIndex(0, 0, 1)).toBe(-1)
  })
  it('caps the match count', () => {
    expect(findMatches('a'.repeat(5000), 'a', {}, 100)).toHaveLength(100)
  })
})

describe('editor edits', () => {
  it('tab inserts an indent at the caret', () => {
    expect(insertTab('ab', { start: 1, end: 1 })).toEqual({ text: 'a  b', selection: { start: 3, end: 3 } })
  })
  it('tab indents every selected line and outdent undoes it', () => {
    const text = 'a\nb\nc'
    const indented = insertTab(text, { start: 0, end: 3 })
    expect(indented.text).toBe('  a\n  b\nc')
    expect(outdent(indented.text, indented.selection).text).toBe(text)
  })
  it('wraps a selection or inserts a pair with the caret inside', () => {
    expect(insertPair('x', { start: 1, end: 1 }, '(')).toEqual({ text: 'x()', selection: { start: 2, end: 2 } })
    expect(insertPair('abc', { start: 0, end: 3 }, '"').text).toBe('"abc"')
    expect(insertPair('a', { start: 1, end: 1 }, '=').text).toBe('a=')
  })
  it('steps over an existing closer', () => {
    expect(insertChar('()', { start: 1, end: 1 }, ')')).toEqual({ text: '()', selection: { start: 2, end: 2 } })
  })
  it('keeps the indent on newline and adds a level after a bracket', () => {
    expect(autoIndentNewline('  foo', '  foo\n', 6)?.text).toBe('  foo\n  ')
    expect(autoIndentNewline('if (x) {', 'if (x) {\n', 9)?.text).toBe('if (x) {\n  ')
    expect(autoIndentNewline('foo', 'foo\n', 4)).toBeNull()
    expect(autoIndentNewline('a', 'ab', 2)).toBeNull()
  })
})

describe('splitTokensByLine', () => {
  it('splits multi-line tokens and keeps colors', () => {
    const lines = splitTokensByLine([
      { text: '/* a\nb */', color: 'g' },
      { text: '\nx', color: 'w' },
    ])
    expect(lines).toEqual([
      [{ text: '/* a', color: 'g' }],
      [{ text: 'b */', color: 'g' }],
      [{ text: 'x', color: 'w' }],
    ])
  })
})
