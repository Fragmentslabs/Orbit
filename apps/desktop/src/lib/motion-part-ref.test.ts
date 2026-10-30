import { describe, expect, it } from "vitest"
import type { ToolPart } from "@shared/chat"
import { motionFormatInReport, motionNameInReport, motionRefOf } from "./motion-part-ref"

/** The report of a piece that opened well (the tool's real text, summarized). */
const OK =
  'Motion "orbit-apresentacao" is open in the Motion tab of the right panel (edit/animations/orbit-apresentacao/index.html) ' +
  "and loads fine: 1920x1080, 1140 frames at 30 fps (38.00 s).\nLayers (when each enters and leaves the frame):\n…"

/** The report of a piece that opened and did NOT load. */
const FAILED =
  'Motion "orbit-apresentacao" is open in the Motion tab, but it DID NOT LOAD: no orbit-motion meta. ' +
  "The user is looking at an empty stage — fix it with motion_edit."

function part(tool: string, input: Record<string, unknown>, output?: string): ToolPart {
  return { id: "p1", type: "tool", tool, state: "done", input, output }
}

describe("name and format in the report", () => {
  it("reads the piece name between quotes", () => {
    expect(motionNameInReport(OK)).toBe("orbit-apresentacao")
    expect(motionNameInReport(FAILED)).toBe("orbit-apresentacao")
    expect(motionNameInReport(undefined)).toBeNull()
    expect(motionNameInReport("nada aqui")).toBeNull()
  })

  it("reads the measured format — and only when the piece loaded", () => {
    expect(motionFormatInReport(OK)).toBe("1920×1080 · 38s")
    // Without the measurements there is nothing to show: the card does not invent a format.
    expect(motionFormatInReport(FAILED)).toBeNull()
  })
})

describe("the card's reference", () => {
  it("code mode: the piece is the project folder, addressed by path", () => {
    const ref = motionRefOf(part("motion_preview", { path: "edit/animations/orbit-apresentacao/index.html" }, OK))
    expect(ref).toMatchObject({
      path: "edit/animations/orbit-apresentacao/index.html",
      label: "orbit-apresentacao",
      format: "1920×1080 · 38s",
    })
    // Main's path is the path the agent gave — the card does not rewrite it.
    expect(ref?.name).toBeUndefined()
  })

  it("chat mode: with no path, the piece is addressed by NAME", () => {
    // motion_write({ name, html }) has no `path` at all: it was exactly here
    // that the card returned null and the chat composition was left without a card.
    const ref = motionRefOf(part("motion_write", { name: "Intro do Orbit!", html: "<html/>" }, OK))
    expect(ref).toMatchObject({ name: "orbit-apresentacao", label: "orbit-apresentacao" })
    expect(ref?.path).toBeUndefined()
  })

  it("the report's name beats the path's in the title", () => {
    const ref = motionRefOf(part("motion_preview", { path: "some/folder/index.html" }, OK))
    expect(ref?.label).toBe("orbit-apresentacao")
  })

  it("with no report, the path still names the card", () => {
    const ref = motionRefOf(part("motion_preview", { path: "edit/animations/orbit-apresentacao" }))
    expect(ref).toMatchObject({ path: "edit/animations/orbit-apresentacao", label: "orbit-apresentacao" })
    expect(ref?.format).toBeUndefined()
  })

  it("with no path AND no name there is no card — nor a button that opens nothing", () => {
    expect(motionRefOf(part("motion_write", { html: "<html/>" }))).toBeNull()
    expect(motionRefOf(part("motion_preview", {}))).toBeNull()
  })
})
