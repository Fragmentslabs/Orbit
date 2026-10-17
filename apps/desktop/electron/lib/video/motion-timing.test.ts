import { describe, expect, it } from 'vitest'
import { MOTION_RUNTIME } from './motion-runtime'
import { MOTION_TIMING_SCRIPT } from './motion-timing'

const { videoTime, gifFrame, gifDelay } = new Function(
  `${MOTION_TIMING_SCRIPT}; return { videoTime: orbitVideoTime, gifFrame: orbitGifFrame, gifDelay: orbitGifDelay }`,
)() as {
  videoTime(t: number, m: Record<string, unknown>): number
  gifFrame(t: number, durations: number[], loop: boolean): number
  gifDelay(seconds: unknown): number
}

describe('orbitVideoTime', () => {
  it('sem atributos é o de antes: o arquivo toca desde o instante 0', () => {
    expect(videoTime(0, {})).toBe(0)
    expect(videoTime(2.5, {})).toBe(2.5)
    // Com duração: prende no fim (um pouco antes, para o quadro existir)…
    expect(videoTime(9, { duration: 4 })).toBeCloseTo(3.999)
    // …ou dá a volta.
    expect(videoTime(9, { duration: 4, loop: true })).toBe(1)
  })

  it('data-start: parado no primeiro quadro até a hora, depois anda', () => {
    expect(videoTime(1, { start: 3 })).toBe(0)
    expect(videoTime(3, { start: 3 })).toBe(0)
    expect(videoTime(4.5, { start: 3 })).toBe(1.5)
  })

  it('data-in corta o começo do arquivo', () => {
    expect(videoTime(0, { in: 10 })).toBe(10)
    expect(videoTime(2, { start: 1, in: 10 })).toBe(11)
  })

  it('data-end segura o último quadro', () => {
    expect(videoTime(9, { start: 2, in: 5, end: 6 })).toBe(9)
    expect(videoTime(5, { start: 2, in: 5, end: 6 })).toBe(8)
    // end antes do start não faz sentido e é ignorado.
    expect(videoTime(5, { start: 4, end: 2 })).toBe(1)
  })

  it('o loop respeita o corte inicial somando antes de dar a volta', () => {
    expect(videoTime(3, { in: 2, duration: 4, loop: true })).toBe(1)
  })
})

describe('orbitGifFrame', () => {
  const frames = [0.1, 0.2, 0.1] // 0.4 s no total

  it('percorre os quadros pelo tempo de cada um', () => {
    expect([0, 0.05, 0.1, 0.29, 0.31, 0.39].map((t) => gifFrame(t, frames, true))).toEqual([0, 0, 1, 1, 2, 2])
  })

  it('repete por padrão e segura o último quadro quando não repete', () => {
    expect(gifFrame(0.45, frames, true)).toBe(0)
    expect(gifFrame(0.95, frames, true)).toBe(1)
    expect(gifFrame(5, frames, false)).toBe(2)
  })

  it('antes de começar é o primeiro quadro; sem quadros, o zero', () => {
    expect(gifFrame(-1, frames, true)).toBe(0)
    expect(gifFrame(3, [], true)).toBe(0)
    expect(gifFrame(3, [0, 0], true)).toBe(0)
  })

  it('é pura: o mesmo tempo dá sempre o mesmo quadro, em qualquer ordem', () => {
    const ts = [0.35, 0.05, 0.25, 0.05, 0.35]
    expect(ts.map((t) => gifFrame(t, frames, true))).toEqual([2, 0, 1, 0, 2])
  })
})

describe('orbitGifDelay', () => {
  it('atraso pequeno ou ausente vira 100 ms, como nos navegadores', () => {
    expect(gifDelay(0)).toBe(0.1)
    expect(gifDelay(0.01)).toBe(0.1)
    expect(gifDelay(undefined)).toBe(0.1)
    expect(gifDelay(0.04)).toBe(0.04)
  })
})

describe('no runtime', () => {
  it('o script está embutido', () => {
    expect(MOTION_RUNTIME).toContain('function orbitVideoTime')
    expect(MOTION_RUNTIME).toContain('function orbitGifFrame')
  })
})
