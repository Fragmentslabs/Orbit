import type { LintFinding } from './motion-lint'

/**
 * What the page says about its cameras (orbitMotion.camera, motion-helpers.ts): the moves it
 * planned, the layers it owns, and the layers whose transform somebody ELSE also writes — the camera
 * overwrites that transform on every frame, so the layer's own animation silently never shows.
 *
 * The report lists the moves (the agent used to find them only through `evaluate`); the lint turns
 * the conflict and the plan mistakes into findings it can act on.
 */
export interface MotionCameraMove {
  at: number
  dur: number
  style: string
  from: { x: number; y: number; zoom: number; rot: number }
  to: { x: number; y: number; zoom: number; rot: number }
}

export interface MotionCameraInfo {
  /** How many direct children of the world the camera moves. */
  layers: number
  moves: MotionCameraMove[]
  shakes: number
  /** Layers (by name) whose transform is also set by the page itself. */
  conflicts: string[]
  /** Why the plan could not be built (a focus target that is missing or has no size…). */
  error?: string
}

const num = (n: number): string => String(Number(n.toFixed(2)))
const at = (seconds: number): string => `${num(seconds)}s`

/** One line per camera: the moves with their style, time and zoom. Pure. */
export function describeCameras(cameras: MotionCameraInfo[]): string {
  if (!cameras.length) return ''
  return cameras
    .map((c, i) => {
      const label = cameras.length > 1 ? `Camera ${i + 1}` : 'Camera'
      if (c.error) return `${label}: the plan could NOT be built — ${c.error}.`
      const moves = c.moves.map((m) => {
        const zoom = m.to.zoom !== m.from.zoom ? ` zoom ${num(m.from.zoom)}→${num(m.to.zoom)}` : ''
        const pan = m.to.x !== m.from.x || m.to.y !== m.from.y ? ` to (${Math.round(m.to.x)}, ${Math.round(m.to.y)})` : ''
        const rot = m.to.rot !== m.from.rot ? ` rot ${num(m.from.rot)}→${num(m.to.rot)}°` : ''
        return `${m.style} ${at(m.at)}→${at(m.at + m.dur)}${zoom}${pan}${rot}`
      })
      const parts = [moves.length ? moves.join(' · ') : 'no moves', c.shakes ? `${c.shakes} shake${c.shakes > 1 ? 's' : ''}` : '']
      return `${label} (${c.layers} layer${c.layers === 1 ? '' : 's'}): ${parts.filter(Boolean).join(' · ')}.`
    })
    .join('\n')
}

/** The cameras against the piece's length, in seconds. Pure. */
export function lintMotionCameras(cameras: MotionCameraInfo[], durationSeconds: number): LintFinding[] {
  const findings: LintFinding[] = []
  for (const c of cameras) {
    if (c.error) {
      findings.push({
        rule: 'camera-plan',
        severity: 'error',
        message: `the camera plan could not be built: ${c.error}`,
        hint: 'a focus() target must exist and have a size (hide a layer with opacity or visibility, not display:none), or pass { rect: { x, y, w, h } }',
      })
      continue
    }
    for (const name of c.conflicts) {
      findings.push({
        rule: 'camera-transform-conflict',
        severity: 'error',
        message: `the layer "${name}" is a direct child of the camera world and its own transform (CSS, an animation or the script) is overwritten by the camera on every frame`,
        hint: 'animate what is INSIDE the layer (put a wrapper in it), never the layer itself — or take the layer out of the world',
      })
    }
    if (c.layers === 0) {
      findings.push({
        rule: 'camera-no-layers',
        severity: 'warning',
        message: 'the camera world has no child elements, so nothing moves',
        hint: 'the DIRECT children of the world element are the layers the camera moves',
      })
    }
    if (c.layers > 0 && c.moves.length === 0 && c.shakes === 0) {
      findings.push({
        rule: 'camera-idle',
        severity: 'warning',
        message: 'a camera was created but it has no moves or shakes',
        hint: 'call .move() / .focus() / .zoomThrough() / .shake(), or drop the camera',
      })
    }
    const end = Math.max(0, ...c.moves.map((m) => m.at + m.dur))
    if (end > durationSeconds + 0.05) {
      findings.push({
        rule: 'camera-past-end',
        severity: 'warning',
        message: `the camera keeps moving until ${at(end)} but the piece lasts ${at(durationSeconds)} — the end of the move is never seen`,
        hint: 'finish the last move before the piece ends, or lengthen the piece',
      })
    }
    const extreme = c.moves.find((m) => m.to.zoom > 40 || m.to.zoom < 0.02)
    if (extreme) {
      findings.push({
        rule: 'camera-zoom-extreme',
        severity: 'warning',
        message: `a move at ${at(extreme.at)} goes to zoom ${num(extreme.to.zoom)} — almost nothing of the world would be in frame`,
        hint: 'check the target size: zoomThrough/focus compute the zoom from the element box',
      })
    }
  }
  return findings
}
