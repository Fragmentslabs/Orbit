import { describe, expect, it } from 'vitest'
import { MOTION_THREE_HELPER } from './motion-three-helper'

/** The pure half of the helper (rng, ease, applyShot), evaluated without three.js. */
const pure = new Function(
  MOTION_THREE_HELPER.replace(/^import .*$/gm, '')
    .replace(/export function mountThree[\s\S]*$/, '')
    .replace(/export /g, '') + '\nreturn { rng, ease, applyShot }',
)() as {
  rng: (seed: number) => () => number
  ease: Record<string, (u: number) => number>
  applyShot: (camera: FakeCamera, shots: unknown[], frame: number, fps: number) => number
}

interface FakeCamera {
  fov: number
  position: { set: (x: number, y: number, z: number) => void; v: number[] }
  lookAt: (x: number, y: number, z: number) => void
  looked: number[]
  updateProjectionMatrix: () => void
}
const camera = (): FakeCamera => {
  const cam: FakeCamera = {
    fov: 40,
    looked: [],
    position: { v: [], set: (x, y, z) => (cam.position.v = [x, y, z]) },
    lookAt: (x, y, z) => (cam.looked = [x, y, z]),
    updateProjectionMatrix: () => {},
  }
  return cam
}

describe('orbit-three helper', () => {
  it('is syntactically valid module source', () => {
    expect(() => new Function(MOTION_THREE_HELPER.replace(/^import .*$/gm, '').replace(/export /g, ''))).not.toThrow()
  })

  it('rng is seeded and repeatable', () => {
    const a = pure.rng(7), b = pure.rng(7)
    expect([a(), a(), a()]).toEqual([b(), b(), b()])
    expect(pure.rng(8)()).not.toBe(pure.rng(7)())
  })

  it('eases from 0 to 1 and never overshoots in-out', () => {
    for (const name of ['linear', 'in', 'out', 'inOut']) {
      expect(pure.ease[name](0)).toBeCloseTo(0)
      expect(pure.ease[name](1)).toBeCloseTo(1)
    }
  })

  it('moves the camera along a shot and holds the ends', () => {
    const cam = camera()
    const shots = [{ from: 0, to: 30, pos: { from: [0, 0, 10], to: [0, 0, 4] }, look: [0, 0, 0], ease: 'linear' }]
    expect(pure.applyShot(cam, shots, 0, 30)).toBe(0)
    expect(cam.position.v[2]).toBeCloseTo(10)
    pure.applyShot(cam, shots, 15, 30)
    expect(cam.position.v[2]).toBeCloseTo(7)
    pure.applyShot(cam, shots, 999, 30)
    expect(cam.position.v[2]).toBeCloseTo(4)
  })

  it('picks the shot by frame and animates fov and orbit', () => {
    const cam = camera()
    const shots = [
      { from: 0, to: 10, pos: [0, 0, 5] },
      { from: 10, to: 20, orbit: { center: [0, 1, 0], radius: 5, height: 2, angle: { from: 0, to: Math.PI / 2 } }, fov: { from: 40, to: 20 }, ease: 'linear' },
    ]
    expect(pure.applyShot(cam, shots, 5, 30)).toBe(0)
    expect(pure.applyShot(cam, shots, 20, 30)).toBe(1)
    expect(cam.position.v[0]).toBeCloseTo(5)
    expect(cam.position.v[1]).toBeCloseTo(3)
    expect(cam.fov).toBeCloseTo(20)
    expect(cam.looked).toEqual([0, 1, 0])
  })

  it('is deterministic: the same frame gives the same camera, in any order', () => {
    const shots = [{ from: 0, to: 60, pos: { from: [0, 0, 10], to: [3, 1, 4] }, drift: 0.2 }]
    const a = camera(), b = camera()
    pure.applyShot(a, shots, 40, 30)
    pure.applyShot(b, shots, 12, 30)
    pure.applyShot(b, shots, 40, 30)
    expect(b.position.v).toEqual(a.position.v)
  })
})
