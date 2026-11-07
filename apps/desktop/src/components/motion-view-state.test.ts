import { describe, expect, it } from "vitest"
import { motionViewState } from "./motion-view-state"
import { designViewState } from "./design/design-view-state"

describe("motionViewState", () => {
  it("describes the playhead and the timeline", () => {
    const state = motionViewState({
      title: "Intro", selected: "Title", frame: 45, durationInFrames: 90, fps: 30,
      layers: [{ name: "Title", spans: [[0, 30], [60, 90]] }, { name: "Logo", spans: [] }],
    })
    expect(state.selected).toBe("Title")
    expect(state.playhead).toBe("frame 45 of 90 (1.50s of 3.00s, 30 fps)")
    expect(state.timeline).toEqual(["Title: frames 0-30, 60-90", "Logo: frames none"])
  })

  it("has no playhead for an empty composition", () => {
    expect(motionViewState({ title: "x", selected: null, frame: 0, durationInFrames: 0, fps: 30, layers: [] }).playhead).toBeNull()
  })
})

describe("designViewState", () => {
  it("names the artboard, the element and the group", () => {
    const state = designViewState({
      title: "Landing",
      boards: [{ file: "Main.html", w: 1440.4, h: 900 }],
      selection: { file: "Main.html", path: [0, 2] },
      extraSelected: 1,
      element: { tag: "h1", text: "Hello" },
    })
    expect(state.artboards).toEqual(["Main.html (1440x900)"])
    expect(state["active artboard"]).toBe("Main.html")
    expect(state["selected element"]).toBe('<h1> at path 0.2 with text "Hello"')
    expect(state["also selected"]).toBe("1 more element in the group")
  })

  it("says the whole artboard when no element is picked, and nothing without a selection", () => {
    const base = { title: "t", boards: [], extraSelected: 0, element: null }
    expect(designViewState({ ...base, selection: { file: "A.html", path: null } })["selected element"]).toBe("the whole artboard")
    expect(designViewState({ ...base, selection: null })["selected element"]).toBeNull()
  })
})
