import { describe, expect, it } from "vitest"
import { formatDesignQuoteText } from "@shared/chat"
import { DESIGN_SOURCE, boardForHref, hexToRgb, hsvToHex, isTextPath, orderAfterMove, parseRuntimeMessage, rgbToHex, rgbToHsv, samePath, splitDeclarations, toHex, withDeclaration } from "./design-protocol"

describe("boardForHref", () => {
  const files = ["Tela1.html", "Pricing.html", "sub/Detail.html"]

  it("resolve o link relativo para o artboard, sem query/hash e sem ligar para a caixa", () => {
    expect(boardForHref("Pricing.html", files)).toBe("Pricing.html")
    expect(boardForHref("./pricing.html?x=1#topo", files)).toBe("Pricing.html")
    expect(boardForHref("/Tela1.html", files)).toBe("Tela1.html")
    expect(boardForHref("sub/Detail.html", files)).toBe("sub/Detail.html")
    expect(boardForHref("Pre%C3%A7os.html", ["Preços.html"])).toBe("Preços.html")
  })

  it("devolve null para o que não é um artboard do canvas", () => {
    expect(boardForHref("Outra.html", files)).toBeNull()
    expect(boardForHref("#secao", files)).toBeNull()
    expect(boardForHref("", files)).toBeNull()
    expect(boardForHref("%E0%A4%A.html", files)).toBeNull()
  })

  it("lê navigate e os links do ready", () => {
    expect(parseRuntimeMessage({ source: DESIGN_SOURCE, type: "navigate", href: "Pricing.html" })).toEqual({ type: "navigate", href: "Pricing.html" })
    expect(parseRuntimeMessage({ source: DESIGN_SOURCE, type: "navigate", href: 3 })).toBeNull()
    const ready = parseRuntimeMessage({
      source: DESIGN_SOURCE,
      type: "ready",
      tree: { tag: "body", path: [], kind: "box", children: [] },
      links: ["A.html", 7, "B.html"],
    })
    expect(ready).toMatchObject({ type: "ready", links: ["A.html", "B.html"] })
  })
})

describe("withDeclaration", () => {
  it("troca só a declaração pedida e mantém o resto como o autor escreveu", () => {
    expect(withDeclaration("padding: 8px 16px; color: #7c3aed", "color", "#111")).toBe("padding: 8px 16px; color: #111")
    expect(withDeclaration("padding: 8px", "background-color", "#7c3aed")).toBe("padding: 8px; background-color: #7c3aed")
    expect(withDeclaration("margin: 0; font-size: 32px", "margin", "")).toBe("font-size: 32px")
    expect(withDeclaration("margin: 0", "margin", "")).toBe("")
    expect(withDeclaration("", "gap", "  12px ")).toBe("gap: 12px")
  })

  it("não quebra um url(data:…;base64,…) nem o nome em outra caixa", () => {
    const style = "background: url(data:image/png;base64,AAA=) no-repeat; COLOR: red"
    expect(splitDeclarations(style)).toEqual([
      { prop: "background", value: "url(data:image/png;base64,AAA=) no-repeat" },
      { prop: "COLOR", value: "red" },
    ])
    expect(withDeclaration(style, "color", "blue")).toBe("background: url(data:image/png;base64,AAA=) no-repeat; COLOR: blue")
  })
})

describe("parseRuntimeMessage", () => {
  it("aceita só mensagens da ponte, com a forma certa", () => {
    expect(parseRuntimeMessage(null)).toBeNull()
    expect(parseRuntimeMessage({ type: "ready" })).toBeNull()
    expect(parseRuntimeMessage({ source: "outra", type: "hover", path: [0] })).toBeNull()
    expect(parseRuntimeMessage({ source: DESIGN_SOURCE, type: "desconhecido" })).toBeNull()
  })

  it("valida caminhos e retângulos", () => {
    expect(parseRuntimeMessage({ source: DESIGN_SOURCE, type: "hover", path: [1, 0], rect: { x: 1, y: 2, w: 3, h: 4 } })).toEqual({
      type: "hover",
      path: [1, 0],
      rect: { x: 1, y: 2, w: 3, h: 4 },
    })
    // Caminho com índice negativo ou não inteiro não endereça nada — a não
    // ser no último lugar, que é o do texto solto (visto adiante).
    expect(parseRuntimeMessage({ source: DESIGN_SOURCE, type: "hover", path: [-1, 0], rect: null })).toEqual({
      type: "hover",
      path: null,
      rect: null,
    })
    expect(parseRuntimeMessage({ source: DESIGN_SOURCE, type: "textEdited", path: [0.5], html: "x" })).toBeNull()
  })

  it("lê a árvore e descarta nós malformados", () => {
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

  it("lê o reorder e só aceita permutação completa", () => {
    expect(parseRuntimeMessage({ source: DESIGN_SOURCE, type: "reorder", parent: [0], order: [2, 0, 1] })).toEqual({
      type: "reorder",
      parent: [0],
      order: [2, 0, 1],
    })
    // No body o caminho é vazio, mas continua sendo um caminho.
    expect(parseRuntimeMessage({ source: DESIGN_SOURCE, type: "reorder", parent: [], order: [1, 0] })).toMatchObject({ parent: [] })
    for (const order of [[0, 0], [0, 2], [-1, 0], [0.5, 1], [], "x"]) {
      expect(parseRuntimeMessage({ source: DESIGN_SOURCE, type: "reorder", parent: [0], order })).toBeNull()
    }
    expect(parseRuntimeMessage({ source: DESIGN_SOURCE, type: "reorder", order: [0] })).toBeNull()
  })

  it("lê o move e exige origens, destino e índice", () => {
    const base = { source: DESIGN_SOURCE, type: "move", paths: [[0, 1]], parent: [2], index: 0 }
    expect(parseRuntimeMessage(base)).toEqual({ type: "move", paths: [[0, 1]], parent: [2], index: 0 })
    expect(parseRuntimeMessage({ ...base, paths: [[0, 1], [0, 2]] })).toEqual({
      type: "move",
      paths: [[0, 1], [0, 2]],
      parent: [2],
      index: 0,
    })
    // O <body> pode ser o destino, mas nunca a origem.
    expect(parseRuntimeMessage({ ...base, parent: [] })).toMatchObject({ parent: [] })
    for (const paths of [[], [[]], [[0], [0]], [[-1]], [null], "x", undefined]) {
      expect(parseRuntimeMessage({ ...base, paths })).toBeNull()
    }
    for (const index of [-1, 1.5, "0", undefined]) {
      expect(parseRuntimeMessage({ ...base, index })).toBeNull()
    }
    expect(parseRuntimeMessage({ ...base, parent: "x" })).toBeNull()
  })

  it("lê o grupo da seleção múltipla, ignorando o que não endereça nada", () => {
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

  it("lê o caminho de um texto solto (último índice negativo) e recusa negativo no meio", () => {
    // O texto solto dentro de um elemento é endereçável: o último índice é o
    // do nó na lista de filhos, com o sinal trocado.
    expect(parseRuntimeMessage({ source: DESIGN_SOURCE, type: "hover", path: [1, -2] })).toMatchObject({ path: [1, -2] })
    expect(parseRuntimeMessage({ source: DESIGN_SOURCE, type: "hover", path: [-1, 2] })).toMatchObject({ path: null })
    expect(parseRuntimeMessage({ source: DESIGN_SOURCE, type: "hover", path: [1, -2] })).toMatchObject({ type: "hover" })
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
  it("troca o elemento de lugar e devolve a ordem nova (posição → índice original)", () => {
    // [A B C D]: A solto depois de C → [B C A D]
    expect(orderAfterMove(4, 0, 3)).toEqual([1, 2, 0, 3])
    // [A B C D]: A solto antes de C → [B A C D]
    expect(orderAfterMove(4, 0, 2)).toEqual([1, 0, 2, 3])
    // [A B C D]: C solto antes de A → [C A B D]
    expect(orderAfterMove(4, 2, 0)).toEqual([2, 0, 1, 3])
    // [A B C D]: D solto antes de B → [A D B C]
    expect(orderAfterMove(4, 3, 1)).toEqual([0, 3, 1, 2])
    // Já está onde cai: nada muda.
    expect(orderAfterMove(4, 2, 2)).toEqual([0, 1, 2, 3])
    // Índice fora da lista não mexe em nada.
    expect(orderAfterMove(3, 9, 1)).toEqual([0, 1, 2])
  })
})

describe("cores do seletor", () => {
  it("lê e escreve o hex", () => {
    expect(hexToRgb("#0a99ff")).toEqual({ r: 10, g: 153, b: 255 })
    expect(hexToRgb("#0af")).toEqual({ r: 0, g: 170, b: 255 })
    expect(hexToRgb("laranja")).toBeNull()
    expect(rgbToHex({ r: 10, g: 153, b: 255 })).toBe("#0a99ff")
  })

  it("vai e volta entre RGB e HSV sem perder a cor", () => {
    for (const hex of ["#000000", "#ffffff", "#0a99ff", "#ff8a00", "#12c48b"]) {
      const rgb = hexToRgb(hex)!
      expect(hsvToHex(rgbToHsv(rgb))).toBe(hex)
    }
  })

  it("o matiz é o do vermelho quando não há saturação", () => {
    expect(rgbToHsv({ r: 128, g: 128, b: 128 }).s).toBe(0)
    expect(rgbToHsv({ r: 255, g: 0, b: 0 }).h).toBe(0)
    expect(rgbToHsv({ r: 0, g: 255, b: 0 }).h).toBe(120)
    expect(rgbToHsv({ r: 0, g: 0, b: 255 }).h).toBe(240)
  })
})

describe("toHex", () => {
  it("converte rgb, rgba e hex curto", () => {
    expect(toHex("rgb(255, 0, 128)")).toBe("#ff0080")
    expect(toHex("rgba(16, 32, 48, 0.5)")).toBe("#102030")
    expect(toHex("#AbC")).toBe("#aabbcc")
    expect(toHex("#112233")).toBe("#112233")
  })

  it("devolve null para transparente e o que não é cor", () => {
    expect(toHex("rgba(0, 0, 0, 0)")).toBeNull()
    expect(toHex("linear-gradient(red, blue)")).toBeNull()
    expect(toHex("")).toBeNull()
  })
})

describe("samePath", () => {
  it("compara caminhos de elementos", () => {
    expect(samePath([1, 2], [1, 2])).toBe(true)
    expect(samePath([1, 2], [1])).toBe(false)
    expect(samePath(null, [1])).toBe(false)
  })
})

describe("isTextPath", () => {
  it("reconhece o caminho de um nó de texto (último índice negativo)", () => {
    expect(isTextPath([1, 2])).toBe(false)
    expect(isTextPath([])).toBe(false)
    expect(isTextPath([1, -2])).toBe(true)
    expect(isTextPath([-3])).toBe(true)
  })
})

describe("formatDesignQuoteText", () => {
  it("diz ao agente qual artboard e qual elemento, com o texto do usuário", () => {
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

  it("no modo código aponta a pasta, e sem elemento fala do artboard inteiro", () => {
    const text = formatDesignQuoteText({ kind: "design", name: "logo", path: "C:/proj/design/logo", file: "A.html" })
    expect(text).toContain("Canvas folder: C:/proj/design/logo")
    expect(text).toContain("Selection: the whole artboard.")
    expect(text).not.toContain("---")
  })
})
