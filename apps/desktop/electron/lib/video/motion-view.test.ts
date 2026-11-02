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
