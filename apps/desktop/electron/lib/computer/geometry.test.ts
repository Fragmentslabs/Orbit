import { describe, expect, it } from 'vitest'
import { fitWithin, frameCenter, globalToShot, physicalToDip, shotToGlobal, visibleIn, windowSpace, type ShotGeometry } from './geometry'

/**
 * O modelo vê o screenshot reduzido; o evento sai em pontos globais. Errar a
 * conversão é clicar no lugar errado de outro app — por isso cada caso de
 * tela (Retina, monitor à esquerda, janela fora da origem) tem teste.
 */

describe('fitWithin', () => {
  it('reduz mantendo a proporção e nunca amplia', () => {
    expect(fitWithin(2480, 1600, 1280)).toEqual({ width: 1280, height: 826 })
    expect(fitWithin(800, 600, 1280)).toEqual({ width: 800, height: 600 })
    expect(fitWithin(1000, 3000, 1280)).toEqual({ width: 427, height: 1280 })
  })
})

describe('shotToGlobal', () => {
  it('Retina 2x: o screenshot reduzido volta para pontos da janela', () => {
    // Janela de 1240×800 pt; a captura teria 2480×1600 px e foi reduzida a 1280×826.
    const g: ShotGeometry = { frame: [120, 80, 1240, 800], width: 1280, height: 826 }
    const [x, y] = shotToGlobal(g, 640, 413)
    expect(x).toBeCloseTo(120 + 620, 0)
    expect(y).toBeCloseTo(80 + 400, 0)
  })

  it('monitor à esquerda do principal: origem negativa', () => {
    const g: ShotGeometry = { frame: [-1440, 100, 1440, 900], width: 1280, height: 800 }
    expect(shotToGlobal(g, 0, 0)).toEqual([-1440, 100])
    expect(shotToGlobal(g, 1280, 800)).toEqual([0, 1000])
  })

  it('monitor acima do principal: y negativo', () => {
    const g: ShotGeometry = { frame: [200, -1080, 1920, 1080], width: 1280, height: 720 }
    expect(shotToGlobal(g, 640, 360)).toEqual([1160, -540])
  })

  it('ponto fora do screenshot é erro, não um clique em outro app', () => {
    const g: ShotGeometry = { frame: [0, 0, 100, 100], width: 100, height: 100 }
    expect(() => shotToGlobal(g, 101, 10)).toThrow(/outside the screenshot/)
    expect(() => shotToGlobal(g, -1, 10)).toThrow(/outside the screenshot/)
    expect(() => shotToGlobal(g, Number.NaN, 10)).toThrow()
  })
})

describe('globalToShot / frameCenter / visibleIn', () => {
  const g: ShotGeometry = { frame: [100, 50, 1000, 500], width: 500, height: 250 }

  it('frame global → espaço do screenshot (ida e volta batem)', () => {
    const shot = globalToShot(g, [300, 150, 200, 100])
    expect(shot).toEqual([100, 50, 100, 50])
    const center = frameCenter([300, 150, 200, 100])
    expect(shotToGlobal(g, shot[0] + shot[2] / 2, shot[1] + shot[3] / 2)).toEqual(center)
  })

  it('elemento rolado para fora ou sem tamanho não está visível', () => {
    expect(visibleIn(g.frame, [300, 150, 10, 10])).toBe(true)
    expect(visibleIn(g.frame, [300, 900, 10, 10])).toBe(false)
    expect(visibleIn(g.frame, [300, 150, 0, 0])).toBe(false)
  })
})

describe('Windows: pixel físico, escala 1 e DIP a 150%', () => {
  // Principal a 150% (2560×1440 físicos = 1706,67×960 DIP) e um segundo
  // monitor a 100% à direita: físico começa em 2560, DIP em 1706,67.
  const displays = [
    { bounds: { x: 0, y: 0, width: 2560 / 1.5, height: 960 }, scaleFactor: 1.5, physicalOrigin: { x: 0, y: 0 } },
    { bounds: { x: 2560 / 1.5, y: 0, width: 1920, height: 1080 }, scaleFactor: 1, physicalOrigin: { x: 2560, y: 0 } },
  ]

  it('com escala 1, o screenshot tem o tamanho do frame físico e x/y voltam ao pixel físico', () => {
    const g = windowSpace([300, 150, 1500, 900], 1, 2000)
    expect(g).toEqual({ frame: [300, 150, 1500, 900], width: 1500, height: 900 })
    expect(shotToGlobal(g, 750, 450)).toEqual([1050, 600])
    // Reduzido ao lado máximo: a razão continua exata.
    const small = windowSpace([300, 150, 1500, 900], 1, 1000)
    expect(small).toMatchObject({ width: 1000, height: 600 })
    expect(shotToGlobal(small, 500, 300)).toEqual([1050, 600])
  })

  it('pixel físico → DIP no monitor a 150%', () => {
    expect(physicalToDip([300, 150, 1500, 900], displays)).toEqual([200, 100, 1000, 600])
  })

  it('pixel físico → DIP no segundo monitor (100%), relativo ao canto dele', () => {
    expect(physicalToDip([2660, 100, 800, 600], displays)).toEqual([1806.67, 100, 800, 600])
  })

  it('sem canto físico, vale o canto DIP', () => {
    expect(physicalToDip([150, 150, 300, 300], [{ bounds: { x: 0, y: 0, width: 1280, height: 720 }, scaleFactor: 1.5 }])).toEqual([100, 100, 200, 200])
  })
})
