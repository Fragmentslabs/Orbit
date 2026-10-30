import { ComputerError, type Frame } from './types'

/**
 * Coordinate spaces of Computer Use on macOS:
 *  - global points: the space of AX, of CGWindowList and of the events (origin at the
 *    top left of the main monitor; monitors to the left/above become
 *    negative);
 *  - screenshot pixels: what the model sees, already reduced to the maximum edge.
 * Between the two there is only the scale ratio of the window.
 *
 * On Windows the host is per-monitor DPI aware: UIA, DWM, PrintWindow and SendInput
 * speak physical pixel of the virtual desktop, and the contract's "global" is that
 * pixel. The screenshot already comes out at frame size (scale 1). DIP only exists on
 * the Electron side — `physicalToDip` is the bridge, if something in Orbit needs to
 * line up with the target window.
 */

export interface ShotGeometry {
  /** Window frame in global points */
  frame: Frame
  /** Size of the coordinate space shown to the model */
  width: number
  height: number
}

/** Size that fits in `maxEdge` keeping the proportion (never enlarges). */
export function fitWithin(width: number, height: number, maxEdge: number): { width: number; height: number } {
  const longest = Math.max(width, height)
  if (longest <= maxEdge) return { width: Math.round(width), height: Math.round(height) }
  const ratio = maxEdge / longest
  return { width: Math.max(1, Math.round(width * ratio)), height: Math.max(1, Math.round(height * ratio)) }
}

/**
 * The coordinate space of a window: the size its screenshot has (points × monitor
 * scale, reduced to the maximum edge). It is the SAME with or without a screenshot in
 * the observation — before, without a screenshot, x/y became window points, and the
 * agent that repeated "the same steps" of an observation with an image was off by
 * half on a Retina monitor (seen in Phase 0: the drag landed below the text line and
 * selected nothing).
 */
export function windowSpace(frame: Frame, scale: number, maxEdge: number): ShotGeometry {
  const size = fitWithin(frame[2] * scale, frame[3] * scale, maxEdge)
  return { frame, width: size.width, height: size.height }
}

/** Screenshot point → global point. Outside the image is an error, not a click in another app. */
export function shotToGlobal(g: ShotGeometry, x: number, y: number): [number, number] {
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > g.width || y > g.height) {
    throw new ComputerError(
      'badRequest',
      `Point (${x}, ${y}) is outside the screenshot (${g.width}×${g.height}). Coordinates are pixels of the LAST cu_observe screenshot of this window.`,
    )
  }
  const [fx, fy, fw, fh] = g.frame
  return [round2(fx + (x * fw) / g.width), round2(fy + (y * fh) / g.height)]
}

/** Global frame → rectangle in the screenshot space (so the tree can point at where the element is in the image). */
export function globalToShot(g: ShotGeometry, frame: Frame): Frame {
  const [fx, fy, fw, fh] = g.frame
  const sx = g.width / fw
  const sy = g.height / fh
  return [Math.round((frame[0] - fx) * sx), Math.round((frame[1] - fy) * sy), Math.round(frame[2] * sx), Math.round(frame[3] * sy)]
}

export function frameCenter(frame: Frame): [number, number] {
  return [round2(frame[0] + frame[2] / 2), round2(frame[1] + frame[3] / 2)]
}

/** Does the element show up in the window? (zeroed frame or outside it = scrolled out/hidden) */
export function visibleIn(window: Frame, frame: Frame): boolean {
  if (frame[2] <= 0 || frame[3] <= 0) return false
  return frame[0] < window[0] + window[2] && frame[0] + frame[2] > window[0] && frame[1] < window[1] + window[3] && frame[1] + frame[3] > window[1]
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/**
 * A monitor: bounds in DIP (as Electron describes them), the scale factor and the
 * corner in physical pixel (`screen.dipToScreenRect(null, bounds)`). Without the
 * physical corner, the DIP corner applies — right for monitors next to a main one at
 * 100%.
 */
export interface DisplayScale {
  bounds: { x: number; y: number; width: number; height: number }
  scaleFactor: number
  physicalOrigin?: { x: number; y: number }
}

/**
 * Rectangle in physical pixel (Windows) → Electron DIP. Each monitor has its own
 * scale, so the conversion is relative to the corner of the monitor that contains the
 * center of the rectangle (the same as `screen.screenToDipRect`, testable without
 * Electron).
 */
export function physicalToDip(frame: Frame, displays: DisplayScale[]): Frame {
  const cx = frame[0] + frame[2] / 2
  const cy = frame[1] + frame[3] / 2
  const origin = (d: DisplayScale) => d.physicalOrigin ?? { x: d.bounds.x, y: d.bounds.y }
  const display =
    displays.find((d) => {
      const o = origin(d)
      return cx >= o.x && cx < o.x + d.bounds.width * d.scaleFactor && cy >= o.y && cy < o.y + d.bounds.height * d.scaleFactor
    }) ?? displays[0]
  if (!display) return frame
  const s = display.scaleFactor || 1
  const o = origin(display)
  const { x, y } = display.bounds
  return [round2(x + (frame[0] - o.x) / s), round2(y + (frame[1] - o.y) / s), round2(frame[2] / s), round2(frame[3] / s)]
}
