import { describe, expect, it } from "vitest"
import { formatDesignQuoteText } from "@shared/chat"
import { DESIGN_SOURCE, boardForHref, hexToRgb, hsvToHex, isTextPath, orderAfterMove, parseRuntimeMessage, rgbToHex, rgbToHsv, samePath, splitDeclarations, toHex, withDeclaration } from "./design-protocol"

describe("boardForHref", () => {
  const files = ["Tela1.html", "Pricing.html", "sub/Detail.html"]

  it("resolves the relative link to the artboard, without query/hash and ignoring case", () => {
    expect(boardForHref("Pricing.html", files)).toBe("Pricing.html")
    expect(boardForHref("./pricing.html?x=1#topo", files)).toBe("Pricing.html")
    expect(boardForHref("/Tela1.html", files)).toBe("Tela1.html")
    expect(boardForHref("sub/Detail.html", files)).toBe("sub/Detail.html")
    expect(boardForHref("Pre%C3%A7os.html", ["Preços.html"])).toBe("Preços.html")
  })

  it("returns null for whatever is not an artboard of the canvas", () => {
    expect(boardForHref("Outra.html", files)).toBeNull()
    expect(boardForHref("#secao", files)).toBeNull()
    expect(boardForHref("", files)).toBeNull()
    expect(boardForHref("%E0%A4%A.html", files)).toBeNull()
  })

  it("reads navigate and the links from ready", () => {
    expect(parseRuntimeMessage({ source: DESIGN_SOURCE, type: "navigate", href: "Pricing.html" })).toEqual({ type: "navigate", href: "Pricing.html" })
    expect(parseRuntimeMessage({ source: DESIGN_SOURCE, type: "navigate", href: 3 })).toBeNull()
    const ready = parseRuntimeMessage({
      source: DESIGN_SOURCE,
      type: "ready",
      tree: { tag: "body", path: [], kind: "box", children: [] },
      links: ["A.html", 7, "B.html"],
    })
    expect(ready).toMatchObject({ type: "ready", links: ["A.html", "B.html"] })
    // The tree is optional: the bridge only sends it when the Layers ask for it.
    expect(parseRuntimeMessage({ source: DESIGN_SOURCE, type: "ready", links: ["A.html"] })).toMatchObject({
      type: "ready",
      tree: null,
      links: ["A.html"],
    })
  })
})

describe("withDeclaration", () => {
  it("replaces only the requested declaration and keeps the rest as the author wrote it", () => {
    expect(withDeclaration("padding: 8px 16px; color: #7c3aed", "color", "#111")).toBe("padding: 8px 16px; color: #111")
    expect(withDeclaration("padding: 8px", "background-color", "#7c3aed")).toBe("padding: 8px; background-color: #7c3aed")
    expect(withDeclaration("margin: 0; font-size: 32px", "margin", "")).toBe("font-size: 32px")
    expect(withDeclaration("margin: 0", "margin", "")).toBe("")
    expect(withDeclaration("", "gap", "  12px ")).toBe("gap: 12px")
  })

  it("does not break a url(data:…;base64,…) nor the name in another case", () => {
    const style = "background: url(data:image/png;base64,AAA=) no-repeat; COLOR: red"
    expect(splitDeclarations(style)).toEqual([
      { prop: "background", value: "url(data:image/png;base64,AAA=) no-repeat" },
      { prop: "COLOR", value: "red" },
    ])
    expect(withDeclaration(style, "color", "blue")).toBe("background: url(data:image/png;base64,AAA=) no-repeat; COLOR: blue")
  })
})

describe("parseRuntimeMessage", () => {
  it("accepts only bridge messages, with the right shape", () => {
    expect(parseRuntimeMessage(null)).toBeNull()
    expect(parseRuntimeMessage({ type: "ready" })).toBeNull()
    expect(parseRuntimeMessage({ source: "outra", type: "hover", path: [0] })).toBeNull()
    expect(parseRuntimeMessage({ source: DESIGN_SOURCE, type: "desconhecido" })).toBeNull()
  })

  it("validates paths and rectangles", () => {
    expect(parseRuntimeMessage({ source: DESIGN_SOURCE, type: "hover", path: [1, 0], rect: { x: 1, y: 2, w: 3, h: 4 } })).toEqual({
      type: "hover",
      path: [1, 0],
      rect: { x: 1, y: 2, w: 3, h: 4 },
    })
    // A path with a negative or non-integer index addresses nothing — except
    // in the last place, which is the loose text one (seen further on).
    expect(parseRuntimeMessage({ source: DESIGN_SOURCE, type: "hover", path: [-1, 0], rect: null })).toEqual({
      type: "hover",
      path: null,
      rect: null,
    })
    expect(parseRuntimeMessage({ source: DESIGN_SOURCE, type: "textEdited", path: [0.5], html: "x" })).toBeNull()
  })

  it("reads the tree and discards malformed nodes", () => {
    const msg = parseRuntimeMessage({
      source: DESIGN_SOURCE,
      type: "tree",
      tree: {
        tag: "body",
        path: [],
        kind: "box",
        children: [
          { tag: "h1", path: [0], kind: "text", text: "Oi", label: ".title", children: [] },
          { tag: 42, path: [1] },
        ],
      },
    })
    expect(msg?.type).toBe("tree")
    if (msg?.type !== "tree") return
    expect(msg.tree.children).toHaveLength(1)
    expect(msg.tree.children[0]).toMatchObject({ tag: "h1", text: "Oi", label: ".title", kind: "text" })
  })

  it("reads the reorder and accepts only a complete permutation", () => {
    expect(parseRuntimeMessage({ source: DESIGN_SOURCE, type: "reorder", parent: [0], order: [2, 0, 1] })).toEqual({
      type: "reorder",
      parent: [0],
      order: [2, 0, 1],
    })
    // On the body the path is empty, but it is still a path.
    expect(parseRuntimeMessage({ source: DESIGN_SOURCE, type: "reorder", parent: [], order: [1, 0] })).toMatchObject({ parent: [] })
    for (const order of [[0, 0], [0, 2], [-1, 0], [0.5, 1], [], "x"]) {
      expect(parseRuntimeMessage({ source: DESIGN_SOURCE, type: "reorder", parent: [0], order })).toBeNull()
    }
    expect(parseRuntimeMessage({ source: DESIGN_SOURCE, type: "reorder", order: [0] })).toBeNull()
  })

  it("reads the move and requires origins, destination and index", () => {
    const base = { source: DESIGN_SOURCE, type: "move", paths: [[0, 1]], parent: [2], index: 0 }
    expect(parseRuntimeMessage(base)).toEqual({ type: "move", paths: [[0, 1]], parent: [2], index: 0 })
    expect(parseRuntimeMessage({ ...base, paths: [[0, 1], [0, 2]] })).toEqual({
      type: "move",
      paths: [[0, 1], [0, 2]],
      parent: [2],
      index: 0,
    })
    // The <body> can be the destination, but never the origin.
    expect(parseRuntimeMessage({ ...base, parent: [] })).toMatchObject({ parent: [] })
    for (const paths of [[], [[]], [[0], [0]], [[-1]], [null], "x", undefined]) {
      expect(parseRuntimeMessage({ ...base, paths })).toBeNull()
    }
    for (const index of [-1, 1.5, "0", undefined]) {
      expect(parseRuntimeMessage({ ...base, index })).toBeNull()
    }
    expect(parseRuntimeMessage({ ...base, parent: "x" })).toBeNull()
  })

  it("reads the multi-selection group, ignoring whatever addresses nothing", () => {
    expect(
      parseRuntimeMessage({ source: DESIGN_SOURCE, type: "select", path: [1], info: null, group: [[1], [3], [-1], [0.5], []] }),
    ).toMatchObject({ type: "select", path: [1], group: [[1], [3]] })
    expect(parseRuntimeMessage({ source: DESIGN_SOURCE, type: "select", path: [1], info: null })).toMatchObject({ group: [] })
    expect(
      parseRuntimeMessage({
        source: DESIGN_SOURCE,
        type: "rects",
        selected: { x: 0, y: 0, w: 1, h: 1 },
        hover: null,
        group: [{ x: 2, y: 3, w: 4, h: 5 }, { x: "x" }, null],
      }),
    ).toMatchObject({ type: "rects", group: [{ x: 2, y: 3, w: 4, h: 5 }] })
  })

  it("reads the path of a loose text (last index negative) and rejects a negative in the middle", () => {
    // The loose text inside an element is addressable: the last index is the
    // one of the node in the children list, with the sign flipped.
    expect(parseRuntimeMessage({ source: DESIGN_SOURCE, type: "hover", path: [1, -2] })).toMatchObject({ path: [1, -2] })
    expect(parseRuntimeMessage({ source: DESIGN_SOURCE, type: "hover", path: [-1, 2] })).toMatchObject({ path: null })
    expect(parseRuntimeMessage({ source: DESIGN_SOURCE, type: "hover", path: [1, -2] })).toMatchObject({ type: "hover" })
  })

  it("reads what differs among the selected (the mixed value)", () => {
    const info = parseRuntimeMessage({
      source: DESIGN_SOURCE,
      type: "info",
      path: [0],
      info: { tag: "div", kind: "box", mixed: ["width", "height"], mixedAttrs: ["class"], mixedText: true },
    })
    expect(info).toMatchObject({
      type: "info",
      path: [0],
      info: { mixed: ["width", "height"], mixedAttrs: ["class"], mixedText: true },
    })
    // Without the group, nothing is mixed.
    const single = parseRuntimeMessage({ source: DESIGN_SOURCE, type: "info", path: [0], info: { tag: "div", kind: "box" } })
    expect(single).toMatchObject({ info: { mixed: [], mixedAttrs: [], mixedText: false } })
  })

  it("normaliza a roda e as teclas", () => {
    expect(parseRuntimeMessage({ source: DESIGN_SOURCE, type: "wheel", dx: 0, dy: 10, ctrl: true, shift: false, x: 5, y: 6 })).toEqual({
      type: "wheel",
      dx: 0,
      dy: 10,
      mode: 0,
      ctrl: true,
      shift: false,
      x: 5,
      y: 6,
    })
    expect(parseRuntimeMessage({ source: DESIGN_SOURCE, type: "wheel", dx: 0, dy: 10, shift: true, x: 5, y: 6 })).toMatchObject({
      type: "wheel",
      shift: true,
    })
    expect(parseRuntimeMessage({ source: DESIGN_SOURCE, type: "key", key: "Delete", phase: "down" })).toMatchObject({
      type: "key",
      key: "Delete",
      phase: "down",
      ctrl: false,
    })
  })
})

describe("orderAfterMove", () => {
  it("moves the element and returns the new order (position → original index)", () => {
    // [A B C D]: A dropped after C → [B C A D]
    expect(orderAfterMove(4, 0, 3)).toEqual([1, 2, 0, 3])
    // [A B C D]: A dropped before C → [B A C D]
    expect(orderAfterMove(4, 0, 2)).toEqual([1, 0, 2, 3])
    // [A B C D]: C dropped before A → [C A B D]
    expect(orderAfterMove(4, 2, 0)).toEqual([2, 0, 1, 3])
    // [A B C D]: D dropped before B → [A D B C]
    expect(orderAfterMove(4, 3, 1)).toEqual([0, 3, 1, 2])
    // It is already where it lands: nothing changes.
    expect(orderAfterMove(4, 2, 2)).toEqual([0, 1, 2, 3])
    // An index outside the list touches nothing.
    expect(orderAfterMove(3, 9, 1)).toEqual([0, 1, 2])
  })
})

describe("selector colors", () => {
  it("reads and writes the hex", () => {
    expect(hexToRgb("#0a99ff")).toEqual({ r: 10, g: 153, b: 255 })
    expect(hexToRgb("#0af")).toEqual({ r: 0, g: 170, b: 255 })
    expect(hexToRgb("laranja")).toBeNull()
    expect(rgbToHex({ r: 10, g: 153, b: 255 })).toBe("#0a99ff")
  })

  it("goes back and forth between RGB and HSV without losing the color", () => {
    for (const hex of ["#000000", "#ffffff", "#0a99ff", "#ff8a00", "#12c48b"]) {
      const rgb = hexToRgb(hex)!
      expect(hsvToHex(rgbToHsv(rgb))).toBe(hex)
    }
  })

  it("the hue is red's when there is no saturation", () => {
    expect(rgbToHsv({ r: 128, g: 128, b: 128 }).s).toBe(0)
    expect(rgbToHsv({ r: 255, g: 0, b: 0 }).h).toBe(0)
    expect(rgbToHsv({ r: 0, g: 255, b: 0 }).h).toBe(120)
    expect(rgbToHsv({ r: 0, g: 0, b: 255 }).h).toBe(240)
  })
})

describe("toHex", () => {
  it("converts rgb, rgba and short hex", () => {
    expect(toHex("rgb(255, 0, 128)")).toBe("#ff0080")
    expect(toHex("rgba(16, 32, 48, 0.5)")).toBe("#102030")
    expect(toHex("#AbC")).toBe("#aabbcc")
    expect(toHex("#112233")).toBe("#112233")
  })

  it("returns null for transparent and for whatever is not a color", () => {
    expect(toHex("rgba(0, 0, 0, 0)")).toBeNull()
    expect(toHex("linear-gradient(red, blue)")).toBeNull()
    expect(toHex("")).toBeNull()
  })
})

describe("samePath", () => {
  it("compares element paths", () => {
    expect(samePath([1, 2], [1, 2])).toBe(true)
    expect(samePath([1, 2], [1])).toBe(false)
    expect(samePath(null, [1])).toBe(false)
  })
})

describe("isTextPath", () => {
  it("recognizes the path of a text node (last index negative)", () => {
    expect(isTextPath([1, 2])).toBe(false)
    expect(isTextPath([])).toBe(false)
    expect(isTextPath([1, -2])).toBe(true)
    expect(isTextPath([-3])).toBe(true)
  })
})

describe("formatDesignQuoteText", () => {
  it("tells the agent which artboard and which element, with the user's text", () => {
    const text = formatDesignQuoteText(
      { kind: "design", name: "landing", file: "Main.html", boardTitle: "Hero", elementPath: [0, 2], tag: "button", label: ".cta", text: "Comprar", html: "<button class=\"cta\">Comprar</button>" },
      "deixe este botão maior",
    )
    expect(text).toContain('canvas "landing", artboard Main.html ("Hero")')
    expect(text).toContain('design_edit({ name: "landing", file: "Main.html" })')
    expect(text).toContain("Element: <button> .cta — child path from <body>: 0 > 2")
    expect(text).toContain("HTML: <button")
    expect(text.endsWith("---\ndeixe este botão maior")).toBe(true)
  })

  it("in code mode it points at the folder, and with no element it talks about the whole artboard", () => {
    const text = formatDesignQuoteText({ kind: "design", name: "logo", path: "C:/proj/design/logo", file: "A.html" })
    expect(text).toContain("Canvas folder: C:/proj/design/logo")
    expect(text).toContain("Selection: the whole artboard.")
    expect(text).not.toContain("---")
  })
})
