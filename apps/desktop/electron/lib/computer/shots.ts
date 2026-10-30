import { globalToShot, type ShotGeometry } from './geometry'
import type { Frame } from './types'

/**
 * Last screenshot of each conversation, in memory, with the point of the last action —
 * it is what the thumbnail of the actions panel shows. Computer Use screenshots do NOT
 * go to the gallery: with one observation per action (read_back), a short task would
 * already write dozens of files in the media tab. The model receives the image through
 * toModelOutput; the person sees only the most recent one, here.
 */

export interface ShotTarget {
  /** Global frame of the element (click by index) */
  frame?: Frame
  /** Global point (click by x/y, scroll) */
  point?: [number, number]
}

interface LastShot {
  data: Buffer
  mediaType: string
  geometry: ShotGeometry
  app: string
  at: number
  /** In global points: it holds for the next screenshot of the same window too */
  target: (ShotTarget & { label: string; at: number }) | null
}

export interface ShotView {
  dataUrl: string
  width: number
  height: number
  app: string
  at: number
  /** Rectangle in the screenshot space (a point = size 0) */
  marker: { x: number; y: number; w: number; h: number; label: string } | null
}

const shots = new Map<string, LastShot>()

/** Stores the new screenshot; the target of the last action stays (it is the same window, after the action). */
export function rememberShot(sessionId: string, shot: Omit<LastShot, 'target'>): void {
  const previous = shots.get(sessionId)
  shots.set(sessionId, { ...shot, target: previous?.target ?? null })
}

export function rememberTarget(sessionId: string, target: ShotTarget, label: string): void {
  const shot = shots.get(sessionId)
  if (shot) shot.target = { ...target, label, at: Date.now() }
}

export function forgetShots(sessionId: string): void {
  shots.delete(sessionId)
}

/** The marker in the image space — outside it (window changed, element scrolled), no marker. */
export function markerFor(geometry: ShotGeometry, target: ShotTarget): ShotView['marker'] {
  const frame: Frame | null = target.frame ?? (target.point ? [target.point[0], target.point[1], 0, 0] : null)
  if (!frame) return null
  const [x, y, w, h] = globalToShot(geometry, frame)
  if (x + w < 0 || y + h < 0 || x > geometry.width || y > geometry.height) return null
  return { x, y, w, h, label: '' }
}

export function shotView(sessionId: string): ShotView | null {
  const shot = shots.get(sessionId)
  if (!shot) return null
  const marker = shot.target ? markerFor(shot.geometry, shot.target) : null
  return {
    dataUrl: `data:${shot.mediaType};base64,${shot.data.toString('base64')}`,
    width: shot.geometry.width,
    height: shot.geometry.height,
    app: shot.app,
    at: shot.at,
    marker: marker && shot.target ? { ...marker, label: shot.target.label } : null,
  }
}
