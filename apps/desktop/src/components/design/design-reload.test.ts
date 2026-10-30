import { describe, expect, it } from "vitest"
import { planDesignReload } from "./design-reload"

describe("planDesignReload", () => {
  it("reloads only the artboard that changed", () => {
    expect(planDesignReload(["Hero.html"])).toEqual({ index: false, boards: ["Hero.html"], all: false })
  })

  it("canvas.json re-reads the index, without touching the artboards", () => {
    expect(planDesignReload(["canvas.json"])).toEqual({ index: true, boards: [], all: false })
  })

  it("an agent write usually brings both: index and screens", () => {
    expect(planDesignReload(["canvas.json", "Hero.html", "Pricing.html"])).toEqual({
      index: true,
      boards: ["Hero.html", "Pricing.html"],
      all: false,
    })
  })

  it("a change outside the artboards (CSS, image, font) reloads every screen", () => {
    expect(planDesignReload(["base.css", "logo.svg"])).toEqual({ index: false, boards: [], all: true })
  })

  it("with no list, it reloads everything — as before the watcher sent the names", () => {
    expect(planDesignReload(undefined)).toEqual({ index: true, boards: [], all: true })
    expect(planDesignReload([])).toEqual({ index: true, boards: [], all: true })
  })

  it("an artboard in a subfolder keeps the canvas.json path", () => {
    expect(planDesignReload(["pages/About.html"]).boards).toEqual(["pages/About.html"])
  })
})
