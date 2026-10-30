import { describe, expect, it } from "vitest"
import { isBoardInView } from "./design-view"

const viewport = { w: 1000, h: 800 }
const board = { x: 0, y: 0, w: 400, h: 300 }

describe("isBoardInView", () => {
  it("sees the artboard at the origin, with the canvas without pan or zoom", () => {
    expect(isBoardInView(board, { x: 0, y: 0, zoom: 1 }, viewport)).toBe(true)
  })

  it("goes out of view when the pan takes the board far away", () => {
    // A pan of 2000px to the left: the board starts at -2000.
    expect(isBoardInView(board, { x: -2000, y: 0, zoom: 1 }, viewport)).toBe(false)
    // Touching the edge still counts (the board ends at 0).
    expect(isBoardInView(board, { x: -400, y: 0, zoom: 1 }, viewport)).toBe(false)
    expect(isBoardInView(board, { x: -399, y: 0, zoom: 1 }, viewport)).toBe(true)
  })

  it("the margin brings back what is just outside", () => {
    // The board ends at -100: outside the viewport, but within 200px of it.
    const outside = { x: -500, y: 0, zoom: 1 }
    expect(isBoardInView(board, outside, viewport)).toBe(false)
    expect(isBoardInView(board, outside, viewport, 200)).toBe(true)
  })

  it("zoom shrinks the board on screen: the same pan now fits", () => {
    const view = { x: -800, y: 0, zoom: 0.5 }
    // At 0.5x the board takes 200px and starts at -800 → it ends at -600.
    expect(isBoardInView(board, view, viewport)).toBe(false)
    // With the pan at -100 it ends at 100: the edge appears.
    expect(isBoardInView(board, { ...view, x: -100 }, viewport)).toBe(true)
  })

  it("a zero-sized viewport claims nothing (the first measurement)", () => {
    // The caller treats {0,0} as "mount everything"; here the rectangle is just empty.
    expect(isBoardInView(board, { x: 0, y: 0, zoom: 1 }, { w: 0, h: 0 })).toBe(false)
  })
})
