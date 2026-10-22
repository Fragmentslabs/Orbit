import { describe, expect, it, vi } from 'vitest'

/**
 * Timeline da gravação: quadros com timestamp → durações do concat.
 *
 * É a conta que define o vídeo inteiro: começar no primeiro quadro (nada de
 * tela branca do carregamento), cada quadro durando até o próximo, e um trecho
 * parado mantendo a última imagem pelo tempo real que durou. O resto do módulo
 * depende de Electron e é exercitado pelo smoke test, não aqui.
 */

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', isPackaged: false },
  BrowserWindow: class {},
}))

const { frameTimeline, timelineDurationMs, concatList } = await import('./browser-record')

describe('frameTimeline', () => {
  it('começa no primeiro quadro e dura até o próximo', () => {
    const entries = frameTimeline(
      [
        { file: 'a.jpg', at: 1000 },
        { file: 'b.jpg', at: 1033 },
        { file: 'c.jpg', at: 1066 },
      ],
      { endedAt: 1066 },
    )
    expect(entries.map((e) => e.durationMs)).toEqual([33, 33, 1])
    expect(timelineDurationMs(entries)).toBe(67)
  })

  it('mantém o último quadro pelo tempo parado mais a cauda', () => {
    const entries = frameTimeline(
      [
        { file: 'a.jpg', at: 0 },
        { file: 'b.jpg', at: 40 },
      ],
      { endedAt: 2000, tailMs: 500 },
    )
    expect(entries[1]).toEqual({ file: 'b.jpg', durationMs: 2460 })
  })

  it('ordena pelo timestamp e nunca gera duração zero', () => {
    const entries = frameTimeline(
      [
        { file: 'b.jpg', at: 50 },
        { file: 'a.jpg', at: 10 },
      ],
      { endedAt: 50 },
    )
    expect(entries[0]).toEqual({ file: 'a.jpg', durationMs: 40 })
    expect(entries.every((e) => e.durationMs >= 1)).toBe(true)
  })

  it('sem quadros, não há timeline', () => {
    expect(frameTimeline([], { endedAt: 999 })).toEqual([])
  })

  it('o concat repete o último arquivo (senão o ffmpeg descarta a duração dele)', () => {
    const text = concatList([
      { file: '/tmp/a.jpg', durationMs: 33 },
      { file: '/tmp/b.jpg', durationMs: 500 },
    ])
    const lines = text.trim().split('\n')
    expect(lines[0]).toBe('ffconcat version 1.0')
    expect(lines[1]).toBe("file '/tmp/a.jpg'")
    expect(lines[2]).toBe('duration 0.0330')
    expect(lines[3]).toBe("file '/tmp/b.jpg'")
    expect(lines[4]).toBe('duration 0.5000')
    expect(lines[5]).toBe("file '/tmp/b.jpg'")
  })

  it('escapa apóstrofo no caminho', () => {
    expect(concatList([{ file: "/tmp/o'brien.jpg", durationMs: 10 }])).toContain("file '/tmp/o'\\''brien.jpg'")
  })
})
