/**
 * Math of the canvas view: the artboard lives in coordinates of canvas.json and the
 * screen shows `translate(view.x, view.y) scale(view.zoom)` over them.
 * Whoever mounts the iframe of a board needs to know whether it still touches the
 * viewport — it is what allows leaving out what nobody is looking at.
 */

export interface BoardRect {
  x: number
  y: number
  w: number
  h: number
}

export interface CanvasView {
  x: number
  y: number
  zoom: number
}

export interface ViewportSize {
  w: number
  h: number
}

/**
 * Does the artboard touch the viewport (with `margin` SCREEN px around it)? The margin
 * is what makes the board already be mounted when the person pans fast — and
 * it is in screen px precisely to count the same at any zoom.
 */
export function isBoardInView(
  board: BoardRect,
  view: CanvasView,
  viewport: ViewportSize,
  margin = 0,
): boolean {
  const x = view.x + board.x * view.zoom
  const y = view.y + board.y * view.zoom
  const w = board.w * view.zoom
  const h = board.h * view.zoom
  return x < viewport.w + margin && x + w > -margin && y < viewport.h + margin && y + h > -margin
}
