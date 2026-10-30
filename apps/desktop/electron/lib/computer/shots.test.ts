import { describe, expect, it } from 'vitest'
import { forgetShots, markerFor, rememberShot, rememberTarget, shotView } from './shots'
import type { ShotGeometry } from './geometry'

/**
 * The panel thumbnail: only the last screenshot per conversation, in memory, with the
 * target of the last action converted to the image space.
 */

const geometry: ShotGeometry = { frame: [100, 50, 1000, 800], width: 1280, height: 1024 }
const shot = (at: number) => ({ data: Buffer.from('img'), mediaType: 'image/webp', geometry, app: 'TextEdit', at })

describe('markerFor', () => {
  it('global frame → rectangle in the image', () => {
    expect(markerFor(geometry, { frame: [1000, 750, 80, 30] })).toMatchObject({ x: 1152, y: 896, w: 102, h: 38 })
  })

  it('a point becomes a zero-size rectangle', () => {
    expect(markerFor(geometry, { point: [600, 450] })).toMatchObject({ x: 640, y: 512, w: 0, h: 0 })
  })

  it('a target outside the window has no marker', () => {
    expect(markerFor(geometry, { point: [5000, 5000] })).toBeNull()
  })
})

describe('last screenshot', () => {
  it('keeps only the most recent, and the action target holds for the next screenshot', () => {
    rememberShot('s1', shot(1))
    rememberTarget('s1', { point: [600, 450] }, 'left_click')
    rememberShot('s1', shot(2))
    const view = shotView('s1')
    expect(view?.at).toBe(2)
    expect(view?.dataUrl.startsWith('data:image/webp;base64,')).toBe(true)
    expect(view?.marker).toMatchObject({ x: 640, y: 512, label: 'left_click' })
  })

  it('conversations do not mix and the end of control clears the memory', () => {
    rememberShot('s2', shot(3))
    expect(shotView('s3')).toBeNull()
    forgetShots('s2')
    expect(shotView('s2')).toBeNull()
  })
})
