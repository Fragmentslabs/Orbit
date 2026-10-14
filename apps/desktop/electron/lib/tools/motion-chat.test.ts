import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/orbit-test', isPackaged: false },
  BrowserWindow: class {},
  protocol: { handle: () => {} },
}))

const { applyTextEdits, chatMotionDir, motionSlug } = await import('./motion-chat')

describe('motionSlug', () => {
  it('turns any name into a short, safe folder name', () => {
    expect(motionSlug('Intro do Orbit!')).toBe('intro-do-orbit')
    expect(motionSlug('  Apresentação — Orbit 2.0  ')).toBe('apresentacao-orbit-2-0')
    expect(motionSlug('../../etc')).toBe('etc')
    expect(motionSlug('***')).toBe('motion')
    expect(motionSlug('a'.repeat(100))).toHaveLength(40)
  })
})

describe('chatMotionDir', () => {
  it('refuses a session id that could escape the folder', () => {
    expect(() => chatMotionDir('../outro')).toThrow(/invalid session/)
    expect(chatMotionDir('JwGoW05wNYfnaOkdxxpcR')).toContain('JwGoW05wNYfnaOkdxxpcR')
  })
})

describe('applyTextEdits', () => {
  const html = '<h1 class="t">Oi</h1>\n<style>.t{animation:in .4s}</style>'

  it('applies exact replacements in order', () => {
    const out = applyTextEdits(html, [
      { oldText: 'Oi', newText: 'Oi, eu sou o Orbit' },
      { oldText: 'in .4s', newText: 'in .6s cubic-bezier(.2,.8,.2,1)' },
    ])
    expect(out).toBe('<h1 class="t">Oi, eu sou o Orbit</h1>\n<style>.t{animation:in .6s cubic-bezier(.2,.8,.2,1)}</style>')
  })

  it('refuses a missing or ambiguous oldText instead of editing the wrong place', () => {
    expect(() => applyTextEdits(html, [{ oldText: 'Tchau', newText: 'x' }])).toThrow(/not found/)
    expect(() => applyTextEdits(html, [{ oldText: 't', newText: 'x' }])).toThrow(/appears \d+ times/)
    expect(applyTextEdits('a a a', [{ oldText: 'a', newText: 'b', replaceAll: true }])).toBe('b b b')
  })

  it('does not interpret $ patterns in the replacement', () => {
    expect(applyTextEdits('preço', [{ oldText: 'preço', newText: '$& $1' }])).toBe('$& $1')
  })
})
