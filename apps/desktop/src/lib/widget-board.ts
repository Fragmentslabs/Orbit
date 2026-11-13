import {
  FRAGMENT_WIDGET_COLUMNS,
  FRAGMENT_WIDGET_GAP,
  FRAGMENT_WIDGET_UNIT,
  type FragmentWidget,
  type FragmentWidgetPlacement,
  type FragmentWidgetSize,
} from "@shared/fragments"

/** A placement that found room on the board: the cell it starts at and the box it fills. */
export interface BoardItem {
  placement: FragmentWidgetPlacement
  /** Position in the placement list (the reorder handle uses it). */
  index: number
  /** Columns and rows it spans. */
  cols: number
  rows: number
  /** Top-left cell, 0-based. */
  col: number
  row: number
}

/** "2x1" → { cols: 2, rows: 1 }. */
/**
 * The box the placed widgets actually occupy, and where it starts. Only the right column
 * filled is one 72px column at col 1 — the panel offsets every card by `col`/`row`, so a
 * hole on the left never turns into an empty strip on screen.
 */
export function boardExtent(items: readonly BoardItem[]): {
  cols: number
  rows: number
  /** Top-left cell the box starts at. */
  col: number
  row: number
  width: number
  height: number
} {
  if (items.length === 0) return { cols: 0, rows: 0, col: 0, row: 0, width: 0, height: 0 }
  // Starting at infinity matters now that the board can begin below the sixth row: a card
  // stored at row 8 gives a two-row box starting at 8, not one padded with empty rows above.
  let minCol = Number.POSITIVE_INFINITY
  let minRow = Number.POSITIVE_INFINITY
  let maxCol = 0
  let maxRow = 0
  for (const item of items) {
    minCol = Math.min(minCol, item.col)
    minRow = Math.min(minRow, item.row)
    maxCol = Math.max(maxCol, item.col + item.cols)
    maxRow = Math.max(maxRow, item.row + item.rows)
  }
  const cols = maxCol - minCol
  const rows = maxRow - minRow
  return {
    cols,
    rows,
    col: minCol,
    row: minRow,
    width: cols === 0 ? 0 : cols * FRAGMENT_WIDGET_UNIT + (cols - 1) * FRAGMENT_WIDGET_GAP,
    height: rows === 0 ? 0 : rows * FRAGMENT_WIDGET_UNIT + (rows - 1) * FRAGMENT_WIDGET_GAP,
  }
}

export function sizeToBox(size: FragmentWidgetSize): { cols: number; rows: number } {
  const [cols, rows] = size.split("x").map(Number)
  return { cols: cols ?? 1, rows: rows ?? 1 }
}

/** The inverse: the declared size a cell span came from (a placement without `size`). */
export function boxToSize(cols: number, rows: number): FragmentWidgetSize {
  return `${cols}x${rows}` as FragmentWidgetSize
}

/** A ceiling on the board's height, so a corrupted placement cannot make it endless. */
export const MAX_BOARD_ROWS = 40

/**
 * How many rows the board has: exactly the rows the cards use — one row for a 1x1, two for
 * a 2x2 — and never a row nobody asked for. An empty board keeps a single row, so there is
 * still somewhere to drop the first card.
 */
export function boardRows(placements: readonly FragmentWidgetPlacement[]): number {
  let rows = 1
  for (const placement of placements) {
    const box = sizeToBox(placement.size ?? "1x1")
    rows = Math.max(rows, (placement.row ?? 0) + box.rows)
  }
  return Math.min(rows, MAX_BOARD_ROWS)
}

/** The board's height in pixels for a given number of rows. */
export function boardHeight(rows: number): number {
  return rows * FRAGMENT_WIDGET_UNIT + (rows - 1) * FRAGMENT_WIDGET_GAP
}

/** Which page a placement sits on. Absent means the first one. */
export function pageOf(placement: FragmentWidgetPlacement): number {
  return placement.page ?? 0
}

/** The placements of one page — what that page's board draws and measures. */
export function onPage(placements: readonly FragmentWidgetPlacement[], page: number): FragmentWidgetPlacement[] {
  return placements.filter((placement) => pageOf(placement) === page)
}

/** A placement and its index in the FULL list: laying out one page never renumbers the others. */
interface Entry {
  placement: FragmentWidgetPlacement
  index: number
}

/** The placements of a page, each keeping the index it has in the full list. */
function entriesOn(placements: readonly FragmentWidgetPlacement[], page: number): Entry[] {
  const entries: Entry[] = []
  placements.forEach((placement, index) => {
    if (pageOf(placement) === page) entries.push({ placement, index })
  })
  return entries
}

/** The declared sizes, largest area first — one order for every screen that shows them. */
export function sizesLargestFirst(widget: FragmentWidget): FragmentWidgetSize[] {
  return [...widget.sizes].sort((a, b) => {
    const ba = sizeToBox(a)
    const bb = sizeToBox(b)
    return bb.cols * bb.rows - ba.cols * ba.rows || bb.cols - ba.cols || bb.rows - ba.rows
  })
}

/** The largest declared size — what a click places and what a preview draws. */
export function biggestSize(widget: FragmentWidget): FragmentWidgetSize {
  return sizesLargestFirst(widget)[0] ?? "1x1"
}

/** The widgets of a fragment, the largest one first — the order the library and the panel show. */
export function widgetsLargestFirst(widgets: readonly FragmentWidget[]): FragmentWidget[] {
  const area = (widget: FragmentWidget) => {
    const { cols, rows } = sizeToBox(biggestSize(widget))
    return cols * rows
  }
  return [...widgets].sort((a, b) => area(b) - area(a))
}

/**
 * The sizes to try, in order: the one asked for, then every declared size from the
 * largest down. A board with a hole too small for the chosen size still shows the
 * widget, smaller, instead of leaving it out.
 */
function sizesOf(widget: FragmentWidget | undefined, asked: FragmentWidgetSize | undefined): FragmentWidgetSize[] {
  if (!widget) return asked ? [asked] : []
  const byArea = sizesLargestFirst(widget)
  return asked ? [asked, ...byArea.filter((size) => size !== asked)] : byArea
}

/**
 * The cell under a point — relative to the board's top-left corner — clamped to the grid.
 * A drop lands exactly where the pointer is, which is what lets a 1x1 sit on the right
 * column, with nothing on its left, and stay there.
 */
export function cellAt(x: number, y: number, rows: number): { col: number; row: number } {
  const pitch = FRAGMENT_WIDGET_UNIT + FRAGMENT_WIDGET_GAP
  return {
    col: Math.max(0, Math.min(FRAGMENT_WIDGET_COLUMNS - 1, Math.floor(x / pitch))),
    row: Math.max(0, Math.min(rows - 1, Math.floor(y / pitch))),
  }
}

/**
 * Where a card dragged onto the board actually lands, and at which size: the cell under the
 * pointer when what is in the hand fits there, otherwise the largest declared size that does.
 *
 * The guide and the drop both read THIS answer. While hovering, the layout already resolves
 * the size the cell can take; the drop stores that same size. Storing the size in the hand
 * instead is what made a 1x1 dropped beside another 1x1 come back as a 2x1 in a free spot
 * further down, pushing the neighbour around.
 */
export function dropTarget(
  placements: readonly FragmentWidgetPlacement[],
  widgetOf: (placement: FragmentWidgetPlacement) => FragmentWidget | undefined,
  drag: { fragmentId: string; widgetId: string; size?: FragmentWidgetSize; from?: number | null },
  cell: { col: number; row: number },
  rows: number,
  page = 0,
): BoardItem | null {
  // Only this page counts: the cells of the other pages are not on this board.
  const next = entriesOn(placements, page).map((entry) => ({ placement: { ...entry.placement }, index: entry.index }))
  if (drag.from != null) {
    const at = next.findIndex((entry) => entry.index === drag.from)
    if (at >= 0) next.splice(at, 1)
  }
  next.push({
    index: placements.length,
    placement: {
      fragmentId: drag.fragmentId,
      widgetId: drag.widgetId,
      ...(drag.size ? { size: drag.size } : {}),
      col: cell.col,
      row: cell.row,
      page,
    },
  })
  const layout = layoutEntries(next, widgetOf, rows)
  // The dragged placement is the last one walked, so when it found a spot it is the last
  // item of the layout — and when no declared size fits anywhere, it is not there at all.
  const landing = layout[layout.length - 1]
  if (!landing) return null
  return landing.placement.fragmentId === drag.fragmentId && landing.placement.widgetId === drag.widgetId ? landing : null
}

/**
 * Draws the board. A placement that carries a cell (col/row) is honoured exactly — that is
 * what lets the person leave a hole on purpose, or keep a 1x1 on the right column with
 * nothing on its left. Only a placement with no cell, or one that no longer fits where it
 * was (the size changed, another card grew over it), falls back to the first free spot;
 * nothing already placed is ever moved to fill a hole.
 *
 * It is a pure function on purpose: the panel and the preview must lay out identically.
 */
export function layoutWidgetBoard(
  placements: readonly FragmentWidgetPlacement[],
  widgetOf: (placement: FragmentWidgetPlacement) => FragmentWidget | undefined,
  rowCount?: number,
  page = 0,
): BoardItem[] {
  const entries = entriesOn(placements, page)
  const rows = rowCount ?? boardRows(entries.map((entry) => entry.placement))
  return layoutEntries(entries, widgetOf, rows)
}

/** The body of the layout, on the entries of ONE page — each item keeps its index in the full list. */
function layoutEntries(
  entries: readonly Entry[],
  widgetOf: (placement: FragmentWidgetPlacement) => FragmentWidget | undefined,
  rowCount: number,
): BoardItem[] {
  const taken = Array.from({ length: rowCount }, () => Array<boolean>(FRAGMENT_WIDGET_COLUMNS).fill(false))
  const items: BoardItem[] = []

  const fits = (col: number, row: number, cols: number, rows: number) => {
    if (col < 0 || row < 0) return false
    if (col + cols > FRAGMENT_WIDGET_COLUMNS || row + rows > rowCount) return false
    for (let r = row; r < row + rows; r++) {
      for (let c = col; c < col + cols; c++) if (taken[r]?.[c]) return false
    }
    return true
  }

  const settle = (index: number, placement: FragmentWidgetPlacement, size: FragmentWidgetSize, col: number, row: number) => {
    const { cols, rows } = sizeToBox(size)
    for (let r = row; r < row + rows; r++) {
      for (let c = col; c < col + cols; c++) taken[r]![c] = true
    }
    items.push({ placement: { ...placement, size }, index, cols, rows, col, row })
  }

  for (const { placement, index } of entries) {
    const widget = widgetOf(placement)
    const sizes = sizesOf(widget, placement.size)

    // 1) where it was put, at the size it was put with (or a smaller declared one)
    if (placement.col != null && placement.row != null) {
      let placed = false
      for (const size of sizes) {
        const { cols, rows } = sizeToBox(size)
        if (!fits(placement.col, placement.row, cols, rows)) continue
        settle(index, placement, size, placement.col, placement.row)
        placed = true
        break
      }
      if (placed) continue
    }

    // 2) no cell (an old board) or no room there: the first free spot, largest size first
    let placed = false
    for (const size of sizes) {
      const { cols, rows } = sizeToBox(size)
      for (let row = 0; row < rowCount && !placed; row++) {
        for (let col = 0; col < FRAGMENT_WIDGET_COLUMNS && !placed; col++) {
          if (!fits(col, row, cols, rows)) continue
          settle(index, placement, size, col, row)
          placed = true
        }
      }
      if (placed) break
    }
  }
  return items
}
