import { describe, expect, it } from 'vitest'
import { describeScenes, lintMotionScenes } from './motion-scenes'

const scenes = [
  { name: 'intro', start: 0, end: 4 },
  { name: 'verse', start: 4, end: 24.5 },
]

describe('describeScenes', () => {
  it('lists the scenes with their seconds, and nothing when there are none', () => {
    expect(describeScenes(scenes)).toBe('Scenes (orbitMotion.scenes — change a duration and the ones after it move): intro 0s→4s · verse 4s→24.5s.')
    expect(describeScenes([])).toBe('')
  })
})

describe('lintMotionScenes', () => {
  it('is quiet when the scenes fill the piece', () => {
    expect(lintMotionScenes(scenes, 24.5)).toEqual([])
    expect(lintMotionScenes(scenes, 24.9)).toEqual([])
    expect(lintMotionScenes([], 10)).toEqual([])
  })
  it('is an error when a scene runs past the end of the piece', () => {
    const [f] = lintMotionScenes(scenes, 20)
    expect(f.rule).toBe('scenes-cut-off')
    expect(f.severity).toBe('error')
    expect(f.message).toMatch(/verse is cut off/)
  })
  it('warns about an end with no scene', () => {
    const [f] = lintMotionScenes(scenes, 30)
    expect(f.rule).toBe('scenes-short')
    expect(f.severity).toBe('warning')
  })
})
