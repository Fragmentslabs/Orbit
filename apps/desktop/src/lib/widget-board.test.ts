import { describe, expect, it } from "vitest"
import type { FragmentWidget, FragmentWidgetPlacement } from "@shared/fragments"
import { sanitizeFragmentWidgets } from "@shared/fragment-rules"
import { boardExtent, boardHeight, boardRows, cellAt, dropTarget, layoutWidgetBoard, onPage } from "./widget-board"

function widget(id: string, sizes: FragmentWidget["sizes"]): FragmentWidget {
  return { id, name: id, sizes }
}

const offered = new Map<string, FragmentWidget>([
  ["big", widget("big", ["1x1", "2x1", "1x2", "2x2"])],
  ["small", widget("small", ["1x1"])],
  ["wide", widget("wide", ["2x1"])],
  ["pair", widget("pair", ["2x1", "1x1"])],
  ["tall", widget("tall", ["1x2"])],
])

const lookup = (placement: FragmentWidgetPlacement) => offered.get(placement.widgetId)

const place = (widgetId: string, size?: FragmentWidgetPlacement["size"], col?: number, row?: number): FragmentWidgetPlacement => {
  const placement: FragmentWidgetPlacement = { fragmentId: "frag-x", widgetId, size }
  if (col != null) placement.col = col
  if (row != null) placement.row = row
  return placement
}

describe("layoutWidgetBoard", () => {
  it("puts two 1x1 side by side when neither has a cell", () => {
    const board = layoutWidgetBoard([place("small", "1x1"), place("small", "1x1")], lookup)
    expect(board.map((item) => [item.col, item.row])).toEqual([
      [0, 0],
      [1, 0],
    ])
  })

  it("gives a 2x2 the full width and continues below it", () => {
    const board = layoutWidgetBoard([place("big", "2x2"), place("small", "1x1")], lookup, 3)
    expect(board[0]).toMatchObject({ col: 0, row: 0, cols: 2, rows: 2 })
    expect(board[1]).toMatchObject({ col: 0, row: 2, cols: 1, rows: 1 })
  })

  it("keeps a 1x1 on the right column with nothing on its left", () => {
    const board = layoutWidgetBoard([place("small", "1x1", 1, 0)], lookup)
    expect(board[0]).toMatchObject({ col: 1, row: 0, cols: 1, rows: 1 })
  })

  it("stacks two 1x1 on the same column without packing them to the left", () => {
    const board = layoutWidgetBoard([place("small", "1x1", 1, 0), place("small", "1x1", 1, 1)], lookup)
    expect(board.map((item) => [item.col, item.row])).toEqual([
      [1, 0],
      [1, 1],
    ])
  })

  it("never moves a placed card to fill a hole", () => {
    const board = layoutWidgetBoard([place("small", "1x1", 0, 2), place("small", "1x1", 1, 0)], lookup)
    expect(board.map((item) => [item.col, item.row])).toEqual([
      [0, 2],
      [1, 0],
    ])
  })

  it("fills the rows it has and leaves the rest out", () => {
    const board = layoutWidgetBoard(
      Array.from({ length: 7 }, () => place("wide", "2x1")),
      lookup,
      6,
    )
    expect(board).toHaveLength(6)
    expect(board[5]).toMatchObject({ row: 5, cols: 2, rows: 1 })
  })

  it("falls back to a size that still fits", () => {
    // Eleven cells taken: one is free, so the 2x2 it asked for becomes a 1x1.
    const placements = Array.from({ length: 11 }, () => place("small", "1x1")).concat(place("big", "2x2"))
    const board = layoutWidgetBoard(placements, lookup, 6)
    expect(board).toHaveLength(12)
    expect(board[11]).toMatchObject({ col: 1, row: 5, cols: 1, rows: 1 })
  })

  it("measures only the box the placed widgets occupy", () => {
    const one = layoutWidgetBoard([place("small", "1x1")], lookup)
    expect(boardExtent(one)).toEqual({ cols: 1, rows: 1, col: 0, row: 0, width: 72, height: 72 })

    const pair = layoutWidgetBoard([place("big", "2x2"), place("small", "1x1")], lookup, 6)
    expect(boardExtent(pair)).toEqual({ cols: 2, rows: 3, col: 0, row: 0, width: 152, height: 232 })
  })

  it("shrinks to the single column that is filled, on either side", () => {
    const right = layoutWidgetBoard([place("small", "1x1", 1, 0), place("small", "1x1", 1, 1)], lookup)
    expect(boardExtent(right)).toEqual({ cols: 1, rows: 2, col: 1, row: 0, width: 72, height: 152 })

    const left = layoutWidgetBoard([place("small", "1x1", 0, 3)], lookup)
    expect(boardExtent(left)).toEqual({ cols: 1, rows: 1, col: 0, row: 3, width: 72, height: 72 })
  })

  it("measures an empty board as nothing", () => {
    expect(boardExtent([])).toEqual({ cols: 0, rows: 0, col: 0, row: 0, width: 0, height: 0 })
  })

  it("keeps a card stored below the sixth row where it was put", () => {
    const board = layoutWidgetBoard([place("small", "1x1", 0, 6)], lookup)
    expect(board[0]).toMatchObject({ col: 0, row: 6 })
  })
})

describe("boardRows", () => {
  it("has exactly the rows the cards use, with no empty rows below", () => {
    expect(boardRows([place("small", "1x1", 0, 0)])).toBe(1)
    expect(boardRows([place("small", "1x1", 0, 1)])).toBe(2)
    expect(boardRows([place("big", "2x2", 0, 0)])).toBe(2)
  })

  it("keeps one row on an empty board, so the first card has where to land", () => {
    expect(boardRows([])).toBe(1)
  })

  it("counts up to the last row a card reaches", () => {
    expect(boardRows([place("small", "1x1", 0, 5)])).toBe(6)
    expect(boardRows([place("small", "1x1", 0, 6)])).toBe(7)
    expect(boardRows([place("big", "2x2", 0, 6)])).toBe(8)
  })

  it("measures the height of the rows it has", () => {
    expect(boardHeight(1)).toBe(72)
    expect(boardHeight(2)).toBe(152)
  })
})

describe("cellAt", () => {
  it("maps a point to the cell it is over", () => {
    expect(cellAt(10, 10, 6)).toEqual({ col: 0, row: 0 })
    expect(cellAt(80, 10, 6)).toEqual({ col: 1, row: 0 })
    expect(cellAt(10, 170, 6)).toEqual({ col: 0, row: 2 })
  })

  it("clamps to the grid", () => {
    expect(cellAt(9999, 9999, 6)).toEqual({ col: 1, row: 5 })
    expect(cellAt(-10, -10, 6)).toEqual({ col: 0, row: 0 })
  })

  it("clamps to the rows the board has, not to a fixed six", () => {
    expect(cellAt(10, 500, 6)).toEqual({ col: 0, row: 5 })
    expect(cellAt(10, 500, 7)).toEqual({ col: 0, row: 6 })
  })
})

describe("dropTarget", () => {
  it("keeps the size in the hand when it fits the cell", () => {
    const landing = dropTarget([], lookup, { fragmentId: "frag-x", widgetId: "big", size: "2x1" }, { col: 0, row: 0 }, 1)
    expect(landing).toMatchObject({ col: 0, row: 0, cols: 2, rows: 1 })
    expect(landing?.placement.size).toBe("2x1")
  })

  it("lands 1x1 beside a 1x1 on the right instead of growing to 2x1", () => {
    // The 2x1 in the hand does not fit at the cell on the left (the right column is taken),
    // so the drop keeps the declared 1x1 — the size the guide showed while hovering.
    const board = [place("small", "1x1", 1, 0)]
    const landing = dropTarget(board, lookup, { fragmentId: "frag-x", widgetId: "pair", size: "2x1" }, { col: 0, row: 0 }, 1)
    expect(landing?.placement.size).toBe("1x1")
    expect(landing).toMatchObject({ col: 0, row: 0, cols: 1, rows: 1 })
  })

  it("moves a card already on the board to the cell under the pointer", () => {
    const board = [place("small", "1x1", 0, 0), place("wide", "2x1", 0, 2)]
    const landing = dropTarget(board, lookup, { fragmentId: "frag-x", widgetId: "wide", size: "2x1", from: 1 }, { col: 0, row: 4 }, 5)
    expect(landing).toMatchObject({ col: 0, row: 4, cols: 2, rows: 1 })
  })

  it("returns nothing when no declared size fits anywhere", () => {
    const full = Array.from({ length: 12 }, () => place("small", "1x1"))
    expect(dropTarget(full, lookup, { fragmentId: "frag-x", widgetId: "big", size: "2x1" }, { col: 0, row: 0 }, 6)).toBeNull()
  })

  it("lands on the row opened below the board", () => {
    const board = [place("small", "1x1", 0, 0)]
    const landing = dropTarget(board, lookup, { fragmentId: "frag-x", widgetId: "pair", size: "2x1" }, { col: 0, row: 1 }, 2)
    expect(landing).toMatchObject({ col: 0, row: 1, cols: 2, rows: 1 })
  })

  it("opens two rows for a 2x2 dropped at the bottom", () => {
    const board = [place("small", "1x1", 0, 0)]
    const landing = dropTarget(board, lookup, { fragmentId: "frag-x", widgetId: "big", size: "2x2" }, { col: 0, row: 1 }, 3)
    expect(landing).toMatchObject({ col: 0, row: 1, cols: 2, rows: 2 })
  })
})

describe("pages", () => {
  it("draws only the cards of the page asked for, keeping the index of the full list", () => {
    const board = [place("small", "1x1", 0, 0), { ...place("wide", "2x1", 0, 0), page: 1 }]
    expect(layoutWidgetBoard(board, lookup, undefined, 0).map((item) => item.placement.widgetId)).toEqual(["small"])
    const second = layoutWidgetBoard(board, lookup, undefined, 1)
    expect(second.map((item) => item.placement.widgetId)).toEqual(["wide"])
    // The index is the one of the FULL list: the store's actions address cards by it.
    expect(second[0]!.index).toBe(1)
  })

  it("measures each page by its own rows", () => {
    const board = [place("small", "1x1", 0, 0), { ...place("tall", "1x2", 0, 0), page: 1 }]
    expect(boardRows(onPage(board, 0))).toBe(1)
    expect(boardRows(onPage(board, 1))).toBe(2)
  })

  it("does not let a card of another page block the cell", () => {
    const board = [{ ...place("wide", "2x1", 0, 0), page: 1 }]
    const landing = dropTarget(board, lookup, { fragmentId: "frag-x", widgetId: "pair", size: "2x1" }, { col: 0, row: 0 }, 1, 0)
    expect(landing).toMatchObject({ col: 0, row: 0, cols: 2, rows: 1 })
  })
})

describe("sanitizeFragmentWidgets", () => {
  it("keeps the well-formed ones and drops the rest", () => {
    const clean = sanitizeFragmentWidgets([
      { id: "hoje", name: "Hoje", sizes: ["1x1", "2x2"] },
      { id: "Hoje!", name: "bad id", sizes: ["1x1"] },
      { id: "sem-tamanho", name: "none", sizes: [] },
      { id: "hoje", name: "duplicate", sizes: ["2x1"] },
      { id: "total", name: "Total", sizes: ["3x3"] },
    ])
    expect(clean).toHaveLength(1)
    expect(clean[0]).toEqual({ id: "hoje", name: "Hoje", sizes: ["1x1", "2x2"] })
  })
})
