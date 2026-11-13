import { create } from "zustand"
import { FRAGMENT_WIDGET_COLUMNS, type FragmentWidgetPlacement, type FragmentWidgetSize } from "@shared/fragments"
import { MAX_BOARD_ROWS, boardRows, onPage, pageOf, sizeToBox } from "@/src/lib/widget-board"

/**
 * What the person placed on the widget board beside the chat: where each one sits, in which
 * order they were added, and on which PAGE.
 *
 * It is the PERSON's board, not the fragment's: a fragment only declares the widgets it
 * offers (manifest.widgets). Keeping the two apart is what lets a fragment be rewritten
 * without losing the board, and what stops a page from putting itself on the board.
 *
 * Every placement carries its own cell (col/row), and that is deliberate: a 1x1 must be
 * able to stay on the right column with nothing on its left, and no card may jump to fill
 * a hole. A placement with no cell — an old board, saved before cells existed — gets the
 * first free spot once, on load; after that it owns that cell.
 *
 * PAGES are boards of their own: each one has its own cells and its own rows. The page
 * showing lives here, not in a component, so the strip beside the chat and the Widgets tab
 * always show the same one. Nothing here is unique: the same widget may sit on two pages,
 * and twice on the same page — the board is a canvas, not a checklist.
 *
 * Persisted in localStorage like the other view preferences of the renderer.
 */
const STORAGE_KEY = "orbit.widget-panel.v1"

/** At most eight pages: the arrows and the dots have to stay readable in a 152px wide panel. */
export const MAX_PAGES = 8

function isSize(value: unknown): value is FragmentWidgetSize {
  return value === "1x1" || value === "2x1" || value === "1x2" || value === "2x2"
}

function isCell(value: unknown, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value < max
}

function clampPage(value: number, pages: number): number {
  return Math.min(Math.max(0, Math.trunc(value)), pages - 1)
}

type Grid = boolean[][]

function emptyGrid(rows: number): Grid {
  return Array.from({ length: rows }, () => Array<boolean>(FRAGMENT_WIDGET_COLUMNS).fill(false))
}

function boxOf(placement: FragmentWidgetPlacement): { cols: number; rows: number } {
  return sizeToBox(placement.size ?? "1x1")
}

function fits(grid: Grid, col: number, row: number, cols: number, rows: number): boolean {
  if (col < 0 || row < 0) return false
  if (col + cols > FRAGMENT_WIDGET_COLUMNS || row + rows > grid.length) return false
  for (let r = row; r < row + rows; r++) {
    for (let c = col; c < col + cols; c++) if (grid[r]?.[c]) return false
  }
  return true
}

function occupy(grid: Grid, col: number, row: number, cols: number, rows: number): void {
  for (let r = row; r < row + rows; r++) {
    for (let c = col; c < col + cols; c++) grid[r]![c] = true
  }
}

function firstFree(grid: Grid, cols: number, rows: number): { col: number; row: number } | null {
  for (let row = 0; row < grid.length; row++) {
    for (let col = 0; col < FRAGMENT_WIDGET_COLUMNS; col++) {
      if (fits(grid, col, row, cols, rows)) return { col, row }
    }
  }
  return null
}

/**
 * Gives a cell to the placements that have none, or whose cell no longer holds their size.
 * It walks in order, so the ones that already own a cell keep it untouched — and when the
 * rows the board has are all taken, it appends a new row instead of pushing the card out of
 * the board (a card with no cell is not drawn anywhere).
 *
 * Every page is normalized against its OWN grid: a card on page 1 never takes a cell on page 0.
 */
function normalize(placements: FragmentWidgetPlacement[]): FragmentWidgetPlacement[] {
  const result = placements.map((placement) => ({ ...placement }))
  const indexes = new Map<number, number[]>()
  result.forEach((placement, index) => {
    const page = pageOf(placement)
    const list = indexes.get(page) ?? []
    list.push(index)
    indexes.set(page, list)
  })
  for (const list of indexes.values()) {
    const grid = emptyGrid(boardRows(list.map((index) => result[index]!)))
    for (const index of list) {
      const placement = result[index]!
      const { cols, rows } = boxOf(placement)
      if (placement.col != null && placement.row != null && fits(grid, placement.col, placement.row, cols, rows)) {
        occupy(grid, placement.col, placement.row, cols, rows)
        continue
      }
      let spot = firstFree(grid, cols, rows)
      while (!spot && grid.length < MAX_BOARD_ROWS) {
        grid.push(Array<boolean>(FRAGMENT_WIDGET_COLUMNS).fill(false))
        spot = firstFree(grid, cols, rows)
      }
      if (!spot) continue
      occupy(grid, spot.col, spot.row, cols, rows)
      result[index] = { ...placement, ...spot }
    }
  }
  return result
}

interface StoredBoard {
  placements: FragmentWidgetPlacement[]
  pages: number
  page: number
}

function readBoard(): StoredBoard {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null")
    const stored = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null
    // A board saved before pages existed is a bare array: every card on page 0, one page.
    const list = Array.isArray(raw) ? raw : stored?.placements
    const kept = (Array.isArray(list) ? list : [])
      .filter((entry): entry is FragmentWidgetPlacement => {
        if (!entry || typeof entry !== "object") return false
        const value = entry as Record<string, unknown>
        return typeof value.fragmentId === "string" && typeof value.widgetId === "string"
      })
      .map((entry) => {
        const clean: FragmentWidgetPlacement = { fragmentId: entry.fragmentId, widgetId: entry.widgetId }
        if (isSize(entry.size)) clean.size = entry.size
        if (isCell(entry.col, FRAGMENT_WIDGET_COLUMNS)) clean.col = entry.col
        if (isCell(entry.row, MAX_BOARD_ROWS)) clean.row = entry.row
        if (isCell(entry.page, MAX_PAGES)) clean.page = entry.page
        return clean
      })
    const placements = normalize(kept)
    const used = placements.reduce((count, placement) => Math.max(count, pageOf(placement) + 1), 0)
    const declared = typeof stored?.pages === "number" ? Math.trunc(stored.pages) : 0
    const pages = Math.min(MAX_PAGES, Math.max(1, used, declared))
    const current = typeof stored?.page === "number" ? stored.page : 0
    return { placements, pages, page: clampPage(current, pages) }
  } catch {
    return { placements: [], pages: 1, page: 0 }
  }
}

function persist(board: StoredBoard): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(board))
  } catch {
    /* storage blocked: the board lasts until the window closes */
  }
}

/** The section of the Fragments page: the library of fragments, or the widget board editor. */
export type WidgetPanelSection = "fragments" | "widgets"

interface WidgetPanelState {
  placements: FragmentWidgetPlacement[]
  /** How many pages the board has — never fewer than one. */
  pages: number
  /** The page showing, shared by the panel and the editor. */
  page: number
  /** The board is showing (the bar expands). Never persisted: a fresh window starts closed. */
  open: boolean
  /** Which tab of the Fragments page is showing. */
  section: WidgetPanelSection
  setSection: (section: WidgetPanelSection) => void
  setPage: (page: number) => void
  /** Adds an empty page after the last one and goes to it. */
  addPage: () => void
  /** Removes the current page — only while it is empty, and never the last one. */
  removePage: () => void
  add: (fragmentId: string, widgetId: string, size?: FragmentWidgetSize) => void
  /** Puts a widget at an exact cell — what a drop on the board asks for. */
  insert: (
    index: number,
    fragmentId: string,
    widgetId: string,
    size?: FragmentWidgetSize,
    col?: number,
    row?: number,
  ) => void
  /**
   * Moves a widget already on the board to an exact cell. The size comes along when the drop
   * had to shrink it to fit (see dropTarget) — the card lands as the guide drew it.
   */
  placeAt: (index: number, col: number, row: number, size?: FragmentWidgetSize) => void
  removeAt: (index: number) => void
  setSize: (index: number, size: FragmentWidgetSize) => void
  move: (from: number, to: number) => void
  toggle: (open?: boolean) => void
}

export const useWidgetPanelStore = create<WidgetPanelState>((set, get) => {
  /** Writes the board, keeping the persisted copy in step with all three fields. */
  const save = (changes: Partial<Pick<WidgetPanelState, "placements" | "pages" | "page">>) => {
    const next = { ...get(), ...changes }
    persist({ placements: next.placements, pages: next.pages, page: next.page })
    set(changes)
  }

  const initial = readBoard()

  return {
    placements: initial.placements,
    pages: initial.pages,
    page: initial.page,
    open: false,
    section: "fragments",

    setSection: (section) => set({ section }),

    setPage: (page) => {
      save({ page: clampPage(page, get().pages) })
    },

    addPage: () => {
      const { pages } = get()
      if (pages >= MAX_PAGES) return
      save({ pages: pages + 1, page: pages })
    },

    removePage: () => {
      const { placements, pages, page } = get()
      if (pages <= 1 || onPage(placements, page).length > 0) return
      const next = placements
        .filter((placement) => pageOf(placement) !== page)
        .map((placement) =>
          pageOf(placement) > page ? { ...placement, page: pageOf(placement) - 1 } : { ...placement },
        )
      save({ placements: next, pages: pages - 1, page: Math.max(0, page - 1) })
    },

    add: (fragmentId, widgetId, size) => {
      const state = get()
      // Nothing is checked: the same widget can go on the board again, on this page or another.
      // normalize gives it the first free cell — or a new row at the bottom when there is none.
      const placements = normalize([...state.placements, { fragmentId, widgetId, size, page: state.page }])
      save({ placements })
    },

    insert: (index, fragmentId, widgetId, size, col, row) => {
      const state = get()
      const placements = [...state.placements]
      const placement: FragmentWidgetPlacement = { fragmentId, widgetId, size, page: state.page }
      if (col != null && row != null) {
        placement.col = col
        placement.row = row
      }
      placements.splice(Math.max(0, Math.min(index, placements.length)), 0, placement)
      save({ placements: normalize(placements) })
    },

    placeAt: (index, col, row, size) => {
      const state = get()
      const moving = state.placements[index]
      if (!moving) return
      const placements = state.placements.map((p) => ({ ...p }))
      // Whoever sat exactly on that cell takes over the one the moved card leaves behind —
      // only within the same page, since a cell only exists there.
      const other = placements.findIndex(
        (p, i) => i !== index && pageOf(p) === pageOf(moving) && p.col === col && p.row === row,
      )
      if (other >= 0 && moving.col != null && moving.row != null) {
        placements[other]!.col = moving.col
        placements[other]!.row = moving.row
      }
      placements[index]!.col = col
      placements[index]!.row = row
      if (size) placements[index]!.size = size
      save({ placements })
    },

    removeAt: (index) => {
      save({ placements: get().placements.filter((_, i) => i !== index) })
    },

    setSize: (index, size) => {
      const placements = get().placements.map((p, i) => (i === index ? { ...p, size } : { ...p }))
      save({ placements: normalize(placements) })
    },

    move: (from, to) => {
      const state = get()
      if (from === to || from < 0 || to < 0 || from >= state.placements.length || to >= state.placements.length) {
        return
      }
      const placements = [...state.placements]
      const [moved] = placements.splice(from, 1)
      if (!moved) return
      placements.splice(to, 0, moved)
      save({ placements })
    },

    toggle: (open) => set((state) => ({ open: open ?? !state.open })),
  }
})
