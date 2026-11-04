import { describe, expect, it } from 'vitest'
import { applyTextEditsDetailed } from '../tools/piece-common'
import { describeEditReceipt, fileHash, MAX_VIEW_LINES, viewFile } from './motion-view'

const file = Array.from({ length: 30 }, (_, i) => `line ${i + 1}${i === 9 || i === 11 ? ' needle' : ''}`).join('\n')

describe('viewFile', () => {
  it('without a request returns the file as it is, behind a one-line header with its hash', () => {
    const out = viewFile('index.html', 'a\nb')
    expect(out).toBe(`[index.html · 2 lines · hash ${fileHash('a\nb')}]\na\nb`)
  })

  it('returns a numbered range, clamped to the file', () => {
    const out = viewFile('index.html', file, { from: 9, to: 11 })
    expect(out).toContain('lines 9–11')
    expect(out).toContain(' 9\tline 9\n10\tline 10 needle\n11\tline 11')
    expect(viewFile('x', file, { from: 99 })).toMatch(/only 30 lines/)
    expect(viewFile('x', file, { from: 28, to: 999 })).toContain('lines 28–30')
  })

  it('caps a very long range and says where to continue', () => {
    const big = Array.from({ length: MAX_VIEW_LINES + 50 }, (_, i) => `l${i}`).join('\n')
    expect(viewFile('x', big, { from: 1 })).toContain(`ask from ${MAX_VIEW_LINES + 1}`)
  })

  it('finds lines with context and merges close windows into one block', () => {
    const out = viewFile('index.html', file, { find: 'needle', context: 1 })
    expect(out).toContain('2 lines contain "needle"')
    // lines 10 and 12 are two apart: one block 9–13, no "…" separator
    expect(out).toContain(' 9\tline 9')
    expect(out).toContain('13\tline 13')
    expect(out).not.toContain('…')
    expect(viewFile('x', file, { find: 'needle', context: 0 })).toContain('…')
  })

  it('says so when nothing matches', () => {
    expect(viewFile('x', file, { find: 'nope' })).toMatch(/No line contains "nope"/)
  })
})

describe('edit receipt', () => {
  it('reports where each edit landed and the hash before → after', () => {
    const before = 'a\nb\nc\nb'
    const { text, applied } = applyTextEditsDetailed(before, [
      { oldText: 'a', newText: 'a1\na2' },
      { oldText: 'b', newText: 'B', replaceAll: true },
    ])
    const receipt = describeEditReceipt('index.html', before, text, applied)
    expect(receipt).toContain(`4 → 5 lines, hash ${fileHash(before)} → ${fileHash(text)}`)
    expect(receipt).toContain('- edit 1: line 1 (1→2 lines) — now: a1')
    expect(receipt).toContain('- edit 2: 2 replacements, first at line 3 — now: B')
  })

  it('refuses an edit that swaps a text for itself', () => {
    expect(() => applyTextEditsDetailed('abc', [{ oldText: 'b', newText: 'b' }])).toThrow(/identical/)
  })
})

describe('viewFile by symbol and several finds', () => {
  const code = [
    '<style>',
    '.word { opacity: 0; }',
    '.word.on {',
    '  color: #c2352c;',
    '}',
    '</style>',
    '<script>',
    'const KW = ["a", "b"]',
    'const lerp = (a, b, t) => a + (b - a) * t;',
    'function buildK(lines, out) {',
    "  const s = 'a { not a block';",
    '  lines.forEach((c) => {',
    '    // } a comment brace',
    '    out.push({ el: c, on: false })',
    '  })',
    '  return out',
    '}',
    'const state = {',
    '  tick(frame) {',
    '    return frame / 30',
    '  },',
    '}',
    'buildK(lines, out)',
    '</script>',
  ].join('\n')

  it('returns the whole function, closed for you, ignoring braces in strings and comments', () => {
    const out = viewFile('index.html', code, { symbol: 'buildK' })
    expect(out).toContain('"buildK": lines 10–17')
    expect(out).toContain('10\tfunction buildK(lines, out) {')
    expect(out).toContain('17\t}')
    expect(out).not.toContain('18\t')
  })

  it('finds an arrow const that has no braces, a method, a const object and a CSS rule', () => {
    expect(viewFile('x', code, { symbol: 'lerp' })).toContain('"lerp": lines 9–9')
    expect(viewFile('x', code, { symbol: 'tick' })).toContain('"tick": lines 19–21')
    expect(viewFile('x', code, { symbol: 'state' })).toContain('"state": lines 18–22')
    expect(viewFile('x', code, { symbol: '.word.on' })).toContain('".word.on": lines 3–5')
  })

  it('does not take a CALL for a declaration, and says when there is none', () => {
    const out = viewFile('x', code, { symbol: 'buildK' })
    expect(out).not.toContain('more declaration')
    expect(viewFile('x', code, { symbol: 'nothing' })).toMatch(/No declaration of "nothing"/)
  })

  it('accepts several finds in one call and merges the windows', () => {
    const out = viewFile('x', code, { find: ['KW', 'lerp'], context: 0 })
    expect(out).toContain('2 lines contain "KW" / "lerp"')
    expect(out).toContain('8\tconst KW')
    expect(out).toContain('9\tconst lerp')
    expect(out).not.toContain('…')
  })
})
