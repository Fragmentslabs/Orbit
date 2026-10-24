/**
 * Contas da vista do canvas: o artboard vive em coordenadas do canvas.json e a
 * tela mostra `translate(view.x, view.y) scale(view.zoom)` por cima delas.
 * Quem monta o iframe de um board precisa saber se ele ainda encosta na
 * viewport — é o que permite deixar de fora o que ninguém está olhando.
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
 * O artboard encosta na viewport (com `margin` px de TELA em volta)? A margem
 * é o que faz o board já estar montado quando a pessoa dá um pan rápido — e
 * ela é em px de tela justamente para valer igual em qualquer zoom.
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
