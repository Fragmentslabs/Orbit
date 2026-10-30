import { describe, expect, it, vi } from 'vitest'

vi.mock('../computer', () => ({ computerRegistry: {}, getComputerDriver: vi.fn(), isComputerAvailable: () => false }))
vi.mock('../computer/observe', () => ({ observe: vi.fn() }))
vi.mock('./selection', () => ({ frontmostForeignApp: vi.fn() }))
vi.mock('../computer/session', () => ({ isEnhanced: () => false, noteEnhanced: vi.fn(), releaseEnhanced: vi.fn() }))

const { prefetchedScreenBlock, recentOverlayHistory, wantsScreen } = await import('./turn-context')

describe('wantsScreen', () => {
  it('requests about the screen read the window first', () => {
    expect(wantsScreen('Consegue ver minha tela?')).toBe(true)
    expect(wantsScreen('what does this error say?')).toBe(true)
    expect(wantsScreen('traduz isso')).toBe(true)
    expect(wantsScreen('what does this error say')).toBe(true)
  })

  it('ordinary conversation reads nothing', () => {
    expect(wantsScreen('Tchau, até a próxima.')).toBe(false)
    expect(wantsScreen('Quanto é 12 vezes 8?')).toBe(false)
  })
})

describe('recentOverlayHistory', () => {
  const now = 10 * 60 * 60_000
  const msg = (minutesAgo: number, id: string) => ({ id, createdAt: now - minutesAgo * 60_000 })

  it('only the recent thread, and always the turn message', () => {
    const history = [msg(120, 'velha'), msg(90, 'velha2'), msg(10, 'recente'), msg(0, 'atual')]
    expect(recentOverlayHistory(history, now).map((m) => m.id)).toEqual(['recente', 'atual'])
  })

  it('at most 12 messages', () => {
    const history = Array.from({ length: 30 }, (_, i) => msg(30 - i, `m${i}`))
    const kept = recentOverlayHistory(history, now)
    expect(kept).toHaveLength(12)
    expect(kept.at(-1)?.id).toBe('m29')
  })
})

describe('prefetchedScreenBlock', () => {
  it('tells the model that this counts as having looked in this turn', () => {
    expect(prefetchedScreenBlock({ windowText: 'App: Mail' })).toMatch(/counts as looking in THIS turn/)
  })

  it('carries the window text and the image description, each under its own label', () => {
    const block = prefetchedScreenBlock({ windowText: 'App: Mail', description: 'Um e-mail aberto' })
    expect(block).toContain('Window text (accessibility tree):\nApp: Mail')
    expect(block).toContain('described it:\nUm e-mail aberto')
  })

  it('only the description, when the window gave no text', () => {
    const block = prefetchedScreenBlock({ description: 'Um vídeo no YouTube' })
    expect(block).not.toContain('Window text')
    expect(block).toContain('Um vídeo no YouTube')
  })
})
