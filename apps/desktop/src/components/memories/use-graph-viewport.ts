/**
 * Viewport of the memory canvas — pan and zoom.
 *
 * The transform lives in a ref and is written straight into the scene <g>: during a
 * drag or a pinch React re-renders nothing, so the whole scene
 * (hundreds of nodes, each with an icon in foreignObject) is not reconciled on
 * every frame. Whoever needs the value — the % label and the minimap
 * rectangle — subscribes through `subscribe`, and only those little pieces redraw.
 *
 * The wheel is heard on a native non-passive listener: React's onWheel is
 * passive, the preventDefault did not take and the window applied its own zoom
 * over ours — hence the freezing and the jumps.
 *
 * Map of the gestures:
 *   wheel / two fingers    → moves on both axes, 1:1 with the gesture
 *   shift + wheel          → moves sideways
 *   ctrl (or cmd) + wheel  → zoom at the pointer; the trackpad pinch on macOS
 *                            arrives exactly like this, only in fine deltas
 *   drag                   → moves on both axes, 1:1 with the cursor
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react"

export interface Transform {
  x: number
  y: number
  k: number
}

/** Deltas in "lines" (Firefox and some wheels) — Chromium's default step. */
const LINE_PX = 16
/**
 * Boundary between a fine delta (trackpad pinch, which arrives in small and
 * continuous steps) and the coarse step of a wheel click (~100px at once).
 */
const COARSE_DELTA = 40
/**
 * Zoom gain per pixel of delta. The pinch adds up to ~200px along the whole
 * gesture, so it needs a much bigger gain than the wheel for a comfortable
 * movement to give a noticeable zoom (~4.5x here).
 */
const ZOOM_SPEED_FINE = 0.0075
const ZOOM_SPEED_COARSE = 0.0022
/** Slack in px before a pointerdown becomes a drag instead of a click. */
const DRAG_SLOP = 3
/** Duration of the discrete transitions (zoom buttons, center). */
const ANIM_MS = 220

interface DragState {
  id: number
  /** Pointer at the start and at the last sample (this one re-anchors the zoom in the middle). */
  startX: number
  startY: number
  lastX: number
  lastY: number
  /** Transform at the instant the drag started. */
  originX: number
  originY: number
  moved: boolean
}

export interface CanvasViewport {
  /** Element that receives the wheel and the pointer. */
  surfaceRef: React.MutableRefObject<SVGSVGElement | null>
  /** Group that carries the transform. */
  sceneRef: React.MutableRefObject<SVGGElement | null>
  subscribe: (fn: () => void) => () => void
  getTransform: () => Transform
  setViewport: (next: Transform, animate?: boolean) => void
  zoomBy: (factor: number) => void
  /** True when the click that is arriving is only the end of a drag. */
  wasDragged: () => boolean
  onPointerDown: (e: React.PointerEvent) => void
}

export function useCanvasViewport({ minZoom, maxZoom }: {
  minZoom: number
  maxZoom: number
}): CanvasViewport {
  const surfaceRef = useRef<SVGSVGElement | null>(null)
  const sceneRef = useRef<SVGGElement | null>(null)
  const transformRef = useRef<Transform>({ x: 0, y: 0, k: 1 })
  const listeners = useRef(new Set<() => void>())
  const commitRaf = useRef(0)
  const animRaf = useRef(0)
  const drag = useRef<DragState | null>(null)
  /** Survives the pointerup so the next click can consult it. */
  const dragged = useRef(false)

  const subscribe = useCallback((fn: () => void) => {
    listeners.current.add(fn)
    return () => {
      listeners.current.delete(fn)
    }
  }, [])
  const getTransform = useCallback(() => transformRef.current, [])

  const clampK = useCallback(
    (k: number) => Math.min(maxZoom, Math.max(minZoom, k)),
    [minZoom, maxZoom],
  )

  /** Writes the transform into the DOM. It is the hot path: no React here. */
  const paint = useCallback(() => {
    const g = sceneRef.current
    if (!g) return
    const { x, y, k } = transformRef.current
    g.setAttribute("transform", `translate(${x}, ${y}) scale(${k})`)
  }, [])

  /** Warns the subscribers at most once per frame. */
  const notify = useCallback(() => {
    if (commitRaf.current) return
    commitRaf.current = requestAnimationFrame(() => {
      commitRaf.current = 0
      for (const fn of listeners.current) fn()
    })
  }, [])

  const apply = useCallback((next: Transform) => {
    transformRef.current = next
    paint()
    notify()
  }, [paint, notify])

  const stopAnimation = useCallback(() => {
    if (!animRaf.current) return
    cancelAnimationFrame(animRaf.current)
    animRaf.current = 0
  }, [])

  const animateTo = useCallback((target: Transform, duration = ANIM_MS) => {
    stopAnimation()
    const from = transformRef.current
    const to = { ...target, k: clampK(target.k) }
    const start = performance.now()
    const step = (now: number) => {
      const p = Math.min(1, (now - start) / duration)
      const e = 1 - Math.pow(1 - p, 3)
      apply({
        x: from.x + (to.x - from.x) * e,
        y: from.y + (to.y - from.y) * e,
        k: from.k + (to.k - from.k) * e,
      })
      animRaf.current = p < 1 ? requestAnimationFrame(step) : 0
    }
    animRaf.current = requestAnimationFrame(step)
  }, [apply, clampK, stopAnimation])

  const setViewport = useCallback((next: Transform, animate = false) => {
    if (animate) {
      animateTo(next)
      return
    }
    stopAnimation()
    apply({ ...next, k: clampK(next.k) })
  }, [animateTo, apply, clampK, stopAnimation])

  /** Zoom keeping the point (cx, cy) fixed, in container coordinates. */
  const zoomAround = useCallback((k: number, cx: number, cy: number, animate = false) => {
    const t = transformRef.current
    const next = clampK(k)
    const target = {
      k: next,
      x: cx - ((cx - t.x) / t.k) * next,
      y: cy - ((cy - t.y) / t.k) * next,
    }
    // Zoom in the middle of a drag: re-anchors on the pointer, otherwise the next
    // pointermove would return the content to where it was before.
    const d = drag.current
    if (d) {
      d.originX = target.x
      d.originY = target.y
      d.startX = d.lastX
      d.startY = d.lastY
    }
    if (animate) {
      animateTo(target)
    } else {
      stopAnimation()
      apply(target)
    }
  }, [animateTo, apply, clampK, stopAnimation])

  const zoomBy = useCallback((factor: number) => {
    const el = surfaceRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    zoomAround(transformRef.current.k * factor, rect.width / 2, rect.height / 2, true)
  }, [zoomAround])

  useEffect(() => {
    const el = surfaceRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      // Holds the zoom/scroll of the window itself — without this the gesture was
      // disputed between the canvas and Chromium, and that is where the jumps came from.
      e.preventDefault()
      stopAnimation()
      const rect = el.getBoundingClientRect()
      let dx = e.deltaX
      let dy = e.deltaY
      if (e.deltaMode === 1) {
        dx *= LINE_PX
        dy *= LINE_PX
      } else if (e.deltaMode === 2) {
        dx *= rect.width
        dy *= rect.height
      }

      if (e.ctrlKey || e.metaKey) {
        const speed = Math.abs(dy) < COARSE_DELTA ? ZOOM_SPEED_FINE : ZOOM_SPEED_COARSE
        zoomAround(
          transformRef.current.k * Math.exp(-dy * speed),
          e.clientX - rect.left,
          e.clientY - rect.top,
        )
        return
      }

      const t = transformRef.current
      if (e.shiftKey && dx === 0) {
        // Some browsers already swap the axes by themselves with shift (then dx comes
        // filled and falls into the general case); in the others the swap is here.
        apply({ ...t, x: t.x - dy })
        return
      }
      apply({ ...t, x: t.x - dx, y: t.y - dy })
    }
    el.addEventListener("wheel", onWheel, { passive: false })
    return () => el.removeEventListener("wheel", onWheel)
  }, [apply, zoomAround, stopAnimation])

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    // Left or middle button; the right one stays for the context menu.
    if (e.button !== 0 && e.button !== 1) return
    if (e.button === 1) e.preventDefault()
    stopAnimation()
    dragged.current = false
    const t = transformRef.current
    const state: DragState = {
      id: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      lastX: e.clientX,
      lastY: e.clientY,
      originX: t.x,
      originY: t.y,
      moved: false,
    }
    drag.current = state

    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== state.id) return
      state.lastX = ev.clientX
      state.lastY = ev.clientY
      const dx = ev.clientX - state.startX
      const dy = ev.clientY - state.startY
      if (!state.moved && Math.abs(dx) + Math.abs(dy) <= DRAG_SLOP) return
      state.moved = true
      dragged.current = true
      // 1:1 with the cursor, on both axes, from the first pixel.
      apply({ ...transformRef.current, x: state.originX + dx, y: state.originY + dy })
    }
    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId !== state.id) return
      drag.current = null
      window.removeEventListener("pointermove", onMove)
      window.removeEventListener("pointerup", onUp)
      window.removeEventListener("pointercancel", onUp)
    }
    // Listening on the window instead of capturing the pointer: the capture forwards
    // the click to the captured element too, and then clicking a node would stop
    // selecting it.
    window.addEventListener("pointermove", onMove)
    window.addEventListener("pointerup", onUp)
    window.addEventListener("pointercancel", onUp)
  }, [apply, stopAnimation])

  const wasDragged = useCallback(() => dragged.current, [])

  // Without a dependency list on purpose: it reasserts the transform after
  // any render, so React never returns the <g> to identity.
  useLayoutEffect(paint)

  useEffect(() => () => {
    if (commitRaf.current) cancelAnimationFrame(commitRaf.current)
    if (animRaf.current) cancelAnimationFrame(animRaf.current)
  }, [])

  // Stable identity: the object enters the deps of whoever consumes it.
  return useMemo(
    () => ({ surfaceRef, sceneRef, subscribe, getTransform, setViewport, zoomBy, wasDragged, onPointerDown }),
    [subscribe, getTransform, setViewport, zoomBy, wasDragged, onPointerDown],
  )
}
