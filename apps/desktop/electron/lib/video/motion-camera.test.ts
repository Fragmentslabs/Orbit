import { describe, expect, it } from 'vitest'
import { describeCameras, lintMotionCameras, type MotionCameraInfo } from './motion-camera'

const home = { x: 540, y: 960, zoom: 1, rot: 0 }
const cam = (over: Partial<MotionCameraInfo> = {}): MotionCameraInfo => ({
  layers: 2,
  moves: [{ at: 1, dur: 1, style: 'push', from: home, to: { ...home, zoom: 3 } }],
  shakes: 0,
  conflicts: [],
  ...over,
})

describe('describeCameras', () => {
  it('lists each move with style, times, zoom, pan and rotation', () => {
    const text = describeCameras([
      cam({
        moves: [
          { at: 1, dur: 0.8, style: 'push', from: home, to: { ...home, zoom: 3 } },
          { at: 3, dur: 0.9, style: 'slingshot', from: { ...home, zoom: 3 }, to: { x: 1600, y: 400, zoom: 2, rot: 5 } },
        ],
        shakes: 2,
      }),
    ])
    expect(text).toContain('Camera (2 layers)')
    expect(text).toContain('push 1s→1.8s zoom 1→3')
    expect(text).toContain('slingshot 3s→3.9s zoom 3→2 to (1600, 400) rot 0→5°')
    expect(text).toContain('2 shakes')
  })
  it('numbers several cameras, says "no moves", and reports a plan that could not be built', () => {
    const text = describeCameras([cam({ moves: [] }), cam({ error: 'focus target not found: #ghost' })])
    expect(text).toContain('Camera 1 (2 layers): no moves')
    expect(text).toContain('Camera 2: the plan could NOT be built — focus target not found: #ghost.')
  })
  it('says nothing when there is no camera', () => {
    expect(describeCameras([])).toBe('')
  })
})

describe('lintMotionCameras', () => {
  it('a clean camera has no findings', () => {
    expect(lintMotionCameras([cam()], 6)).toEqual([])
  })
  it('errors on a layer whose own transform the camera overwrites, naming the layer', () => {
    const f = lintMotionCameras([cam({ conflicts: ['title', '.hero'] })], 6)
    expect(f.map((x) => `${x.rule}:${x.severity}`)).toEqual(['camera-transform-conflict:error', 'camera-transform-conflict:error'])
    expect(f[0].message).toContain('"title"')
    expect(f[0].hint).toMatch(/INSIDE the layer/)
  })
  it('errors when the plan could not be built, and stops there for that camera', () => {
    const f = lintMotionCameras([cam({ error: 'focus target #x has no size', moves: [] })], 6)
    expect(f).toHaveLength(1)
    expect(f[0]).toMatchObject({ rule: 'camera-plan', severity: 'error' })
  })
  it('warns on an empty world, an idle camera, a move past the end and an absurd zoom', () => {
    expect(lintMotionCameras([cam({ layers: 0 })], 6).map((x) => x.rule)).toContain('camera-no-layers')
    expect(lintMotionCameras([cam({ moves: [] })], 6).map((x) => x.rule)).toContain('camera-idle')
    expect(lintMotionCameras([cam({ moves: [{ at: 5, dur: 2, style: 'ease', from: home, to: home }] })], 6).map((x) => x.rule)).toContain('camera-past-end')
    expect(lintMotionCameras([cam({ moves: [{ at: 1, dur: 1, style: 'push', from: home, to: { ...home, zoom: 90 } }] })], 6).map((x) => x.rule)).toContain('camera-zoom-extreme')
  })
  it('a shake-only camera is not idle', () => {
    expect(lintMotionCameras([cam({ moves: [], shakes: 1 })], 6)).toEqual([])
  })
})
