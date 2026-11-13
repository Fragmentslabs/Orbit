import { describe, expect, it } from "vitest"
import { composerLayoutFor } from "./use-composer-layout"

/**
 * The three steps of the composer: the row only drops one control at a time —
 * first the thinking label, then the model — and never ends up with a step that
 * shows nothing.
 */
describe("composerLayoutFor", () => {
  it("keeps the thinking label while there is room for it", () => {
    expect(composerLayoutFor(672).band).toBe("wide")
    expect(composerLayoutFor(576).band).toBe("wide")
  })

  it("turns the thinking into an icon before dropping the model", () => {
    expect(composerLayoutFor(575).band).toBe("medium")
    expect(composerLayoutFor(512).band).toBe("medium")
  })

  it("falls back to the single button only when the two selectors no longer fit", () => {
    expect(composerLayoutFor(511).band).toBe("narrow")
    expect(composerLayoutFor(320).band).toBe("narrow")
  })

  it("does not repeat the autonomy selector while it is still on the row", () => {
    // Single button in use, but the autonomy selector is still visible: only thinking and model.
    expect(composerLayoutFor(511).permissionVisible).toBe(true)
    expect(composerLayoutFor(448).permissionVisible).toBe(true)
    // Selector gone: the single button has to carry all three.
    expect(composerLayoutFor(447).permissionVisible).toBe(false)
  })
})
