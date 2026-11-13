// @vitest-environment jsdom
import { describe, expect, it } from "vitest"
import {
  DESIGN_SOURCE,
  buildClip,
  copyFileName,
  hasContent,
  layoutFromRects,
  looseDocument,
  looseFileName,
  parseRuntimeMessage,
  pasteClip,
  stripPageRules,
} from "./design-protocol"

const SOURCE = `<!doctype html>
<html lang="en"><head><link rel="stylesheet" href="base.css"><style>body { background: #111 } .card { padding: 8px } .btn { color: red }</style></head>
<body class="dark"><header><h1>Title</h1></header><section><div class="card" id="a">Hello <b>there</b></div><div class="card" id="b">Second</div></section></body></html>`

const TARGET = `<!doctype html>
<html><head><style>.other { margin: 0 }</style></head><body><main><p>one</p><p>two</p></main></body></html>`

describe("buildClip", () => {
  it("copies the nodes in DOM order with the styles they depend on", () => {
    const clip = buildClip(SOURCE, [[1, 1], [1, 0]], { designId: "dsg_a", file: "A.html" })
    expect(clip).not.toBeNull()
    expect(clip!.items).toHaveLength(2)
    // DOM order, whatever order the paths came in.
    expect(clip!.items[0]).toContain('id="a"')
    expect(clip!.items[1]).toContain('id="b"')
    expect(clip!.links).toEqual(["base.css"])
    expect(clip!.styles[0]).toContain(".card")
    expect(clip!.body).toEqual({ class: "dark" })
    expect(clip!.html).toEqual({ lang: "en" })
    expect(clip!.label).toBe("Hello there")
  })

  it("counts a node nested inside another copied one only once", () => {
    const clip = buildClip(SOURCE, [[1], [1, 0]], { designId: null, file: "A.html" })
    expect(clip!.items).toHaveLength(1)
    expect(clip!.items[0].startsWith("<section")).toBe(true)
  })

  it("turns a loose text node into a span", () => {
    const clip = buildClip(SOURCE, [[1, 0, -1]], { designId: null, file: "A.html" })
    expect(clip!.items).toEqual(["<span>Hello </span>"])
  })

  it("returns null when no path resolves", () => {
    expect(buildClip(SOURCE, [[9, 9]], { designId: null, file: "A.html" })).toBeNull()
  })
})

describe("pasteClip", () => {
  const clip = buildClip(SOURCE, [[1, 0]], { designId: "dsg_a", file: "A.html" })!

  it("inserts after an element, reports the new path and brings the styles of another artboard", () => {
    const result = pasteClip(TARGET, clip, { kind: "after", path: [0, 0] }, { sameFile: false, sameDesign: true })
    expect(result.paths).toEqual([[0, 1]])
    const doc = new DOMParser().parseFromString(result.html, "text/html")
    expect(doc.querySelector("main")!.children[1].id).toBe("a")
    expect(doc.querySelector("main")!.children).toHaveLength(3)
    // The shared sheet stays linked (same canvas) and the artboard's own CSS comes along,
    // without its page-level `body` rule.
    expect(doc.head.querySelector('link[href="base.css"]')).not.toBeNull()
    const pasted = doc.head.querySelector("style[data-orbit-pasted]")!.textContent!
    expect(pasted).toContain(".card")
    expect(pasted).not.toContain("background: #111")
  })

  it("appends to the end of the body and does not touch the styles when it is the same file", () => {
    const result = pasteClip(SOURCE, clip, { kind: "end" }, { sameFile: true, sameDesign: true })
    expect(result.paths).toEqual([[2]])
    expect(result.html).not.toContain("data-orbit-pasted")
  })

  it("does not paste the same stylesheet twice", () => {
    const once = pasteClip(TARGET, clip, { kind: "end" }, { sameFile: false, sameDesign: true })
    const twice = pasteClip(once.html, clip, { kind: "end" }, { sameFile: false, sameDesign: true })
    const doc = new DOMParser().parseFromString(twice.html, "text/html")
    expect(doc.head.querySelectorAll("style[data-orbit-pasted]")).toHaveLength(1)
    expect(doc.head.querySelectorAll('link[href="base.css"]')).toHaveLength(1)
  })

  it("inlines the stylesheet when the paste goes to another canvas", () => {
    const result = pasteClip(
      TARGET,
      clip,
      { kind: "inside", parent: [0], index: 0 },
      { sameFile: false, sameDesign: false, inlineCss: { "base.css": ".tok { color: blue }" } },
    )
    const doc = new DOMParser().parseFromString(result.html, "text/html")
    expect(doc.head.querySelector("link")).toBeNull()
    expect(Array.from(doc.head.querySelectorAll("style[data-orbit-pasted]")).some((s) => s.textContent!.includes(".tok"))).toBe(true)
    expect(doc.querySelector("main")!.children[0].id).toBe("a")
    expect(result.paths).toEqual([[0, 0]])
  })

  it("refuses a target that is not in the source", () => {
    expect(() => pasteClip(TARGET, clip, { kind: "inside", parent: [7], index: 0 }, { sameFile: false, sameDesign: true })).toThrow()
  })
})

describe("looseDocument", () => {
  it("is a transparent page with the piece, its styles and the free marker", () => {
    const clip = buildClip(SOURCE, [[1, 0], [1, 1]], {
      designId: "dsg_a",
      file: "A.html",
      rects: [
        { x: 0, y: 0, w: 100, h: 40 },
        { x: 0, y: 52, w: 100, h: 40 },
      ],
    })!
    const html = looseDocument(clip, clip.size.w, { sameFile: false, sameDesign: true })
    const doc = new DOMParser().parseFromString(html, "text/html")
    expect(doc.documentElement.hasAttribute("data-orbit-free")).toBe(true)
    expect(doc.body.children).toHaveLength(2)
    expect(doc.body.className).toBe("dark")
    expect(doc.head.querySelector('link[href="base.css"]')).not.toBeNull()
    const reset = doc.head.querySelector("style[data-orbit-free]")!.textContent!
    expect(reset).toContain("flex-direction:column")
    expect(reset).toContain("gap:12px")
    expect(reset).toContain("width:100px")
    // Unlike a frame, the piece keeps the origin's body rules (it has no page of its own).
    expect(Array.from(doc.head.querySelectorAll("style")).some((s) => s.textContent!.includes("background: #111"))).toBe(true)
  })

  it("a single piece is a plain block", () => {
    const clip = buildClip(SOURCE, [[1, 0]], { designId: null, file: "A.html" })!
    const html = looseDocument(clip, 240, { sameFile: false, sameDesign: true })
    expect(html).toContain("display:block !important")
    expect(html).toContain("width:240px")
  })
})

describe("layoutFromRects", () => {
  it("measures the block and finds the direction and gap of siblings", () => {
    expect(layoutFromRects([])).toEqual({ size: { w: 0, h: 0 }, layout: null })
    expect(layoutFromRects([{ x: 10, y: 10, w: 50, h: 20 }])).toEqual({ size: { w: 50, h: 20 }, layout: null })
    expect(
      layoutFromRects([
        { x: 0, y: 0, w: 50, h: 20 },
        { x: 60, y: 0, w: 50, h: 20 },
        { x: 130, y: 0, w: 50, h: 20 },
      ]),
    ).toEqual({ size: { w: 180, h: 20 }, layout: { direction: "row", gap: 15 } })
    expect(
      layoutFromRects([
        { x: 0, y: 0, w: 50, h: 20 },
        { x: 0, y: 30, w: 50, h: 20 },
      ]).layout,
    ).toEqual({ direction: "column", gap: 10 })
  })
})

describe("stripPageRules", () => {
  it("drops html/body rules and keeps the rest", () => {
    const css = `/* c */ html, body { margin: 0 } @import url(x.css); :root { --a: 1 } .a { color: red } @media (min-width: 1px) { body { x: y } .b { z: 1 } } body { padding: 1px }`
    const out = stripPageRules(css)
    expect(out).not.toContain("margin: 0")
    expect(out).not.toContain("padding: 1px")
    expect(out).toContain("@import url(x.css);")
    expect(out).toContain(":root { --a: 1 }")
    expect(out).toContain(".a { color: red }")
    // Inside an at-rule it is left alone.
    expect(out).toContain("@media")
  })
})

describe("names and content", () => {
  it("names a loose piece uniquely and a copy of an artboard from its own name", () => {
    const first = looseFileName([])
    expect(first).toMatch(/^piece-[a-z0-9]+\.html$/)
    expect(looseFileName([first])).not.toBe(first)
    expect(copyFileName("Hero.html", ["Hero.html"])).toBe("Hero-copy.html")
    expect(copyFileName("Hero-copy.html", ["Hero.html", "Hero-copy.html"])).toBe("Hero-copy-2.html")
    expect(copyFileName("Hero.html", ["Hero.html", "hero-copy.html"])).toBe("Hero-copy-2.html")
  })

  it("knows when a document was emptied", () => {
    expect(hasContent("<html><body><div></div></body></html>")).toBe(true)
    expect(hasContent("<html><body>  \n </body></html>")).toBe(false)
    expect(hasContent("<html><body>text</body></html>")).toBe(true)
  })
})

describe("runtime messages for the cross-artboard drag", () => {
  const base = { source: DESIGN_SOURCE }

  it("reads the drag that left the artboard", () => {
    const msg = parseRuntimeMessage({
      ...base,
      type: "crossDrag",
      phase: "end",
      x: -20,
      y: 40,
      mod: true,
      paths: [[0, 1], "bad", [-3]],
      rects: [{ x: 1, y: 2, w: 3, h: 4 }, { x: "a" }],
      grab: { x: 5, y: 6 },
    })
    expect(msg).toEqual({
      type: "crossDrag",
      phase: "end",
      x: -20,
      y: 40,
      mod: true,
      // A moved element is an element: loose text paths and garbage are dropped.
      paths: [[0, 1]],
      rects: [{ x: 1, y: 2, w: 3, h: 4 }],
      grab: { x: 5, y: 6 },
    })
    expect(parseRuntimeMessage({ ...base, type: "crossDrag", phase: "nope", x: 1, y: 1 })).toBeNull()
    expect(parseRuntimeMessage({ ...base, type: "crossDrag", phase: "move", x: "1", y: 1 })).toBeNull()
  })

  it("reads the loose-piece drag, the drop target and the size", () => {
    expect(parseRuntimeMessage({ ...base, type: "boardDrag", phase: "start", sx: 10, sy: 20, x: 3, y: 4 })).toEqual({
      type: "boardDrag",
      phase: "start",
      sx: 10,
      sy: 20,
      x: 3,
      y: 4,
      mod: false,
    })
    expect(parseRuntimeMessage({ ...base, type: "boardDrag", phase: "start", sx: 10 })).toBeNull()
    expect(parseRuntimeMessage({ ...base, type: "dropTarget", parent: [0, 2], index: 3 })).toEqual({ type: "dropTarget", parent: [0, 2], index: 3 })
    expect(parseRuntimeMessage({ ...base, type: "dropTarget", parent: null, index: 0 })).toEqual({ type: "dropTarget", parent: null, index: 0 })
    expect(parseRuntimeMessage({ ...base, type: "dropTarget", parent: "x", index: 0 })).toBeNull()
    expect(parseRuntimeMessage({ ...base, type: "size", w: 120, h: 40 })).toEqual({ type: "size", w: 120, h: 40 })
    expect(parseRuntimeMessage({ ...base, type: "size", w: -1, h: 40 })).toBeNull()
  })
})
