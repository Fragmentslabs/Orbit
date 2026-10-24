import { describe, expect, it } from "vitest"
import { isBoardInView } from "./design-view"

const viewport = { w: 1000, h: 800 }
const board = { x: 0, y: 0, w: 400, h: 300 }

describe("isBoardInView", () => {
  it("enxerga o artboard na origem, com o canvas sem pan nem zoom", () => {
    expect(isBoardInView(board, { x: 0, y: 0, zoom: 1 }, viewport)).toBe(true)
  })

  it("sai da vista quando o pan leva o board para longe", () => {
    // Pan de 2000px para a esquerda: o board começa em -2000.
    expect(isBoardInView(board, { x: -2000, y: 0, zoom: 1 }, viewport)).toBe(false)
    // Encostando na borda ainda conta (o board termina em 0).
    expect(isBoardInView(board, { x: -400, y: 0, zoom: 1 }, viewport)).toBe(false)
    expect(isBoardInView(board, { x: -399, y: 0, zoom: 1 }, viewport)).toBe(true)
  })

  it("a margem traz de volta o que está logo fora", () => {
    // O board termina em -100: fora da viewport, mas dentro de 200px dela.
    const outside = { x: -500, y: 0, zoom: 1 }
    expect(isBoardInView(board, outside, viewport)).toBe(false)
    expect(isBoardInView(board, outside, viewport, 200)).toBe(true)
  })

  it("o zoom encolhe o board na tela: o mesmo pan passa a caber", () => {
    const view = { x: -800, y: 0, zoom: 0.5 }
    // Em 0.5x o board ocupa 200px e começa em -800 → termina em -600.
    expect(isBoardInView(board, view, viewport)).toBe(false)
    // Com o pan em -100 ele termina em 100: a borda aparece.
    expect(isBoardInView(board, { ...view, x: -100 }, viewport)).toBe(true)
  })

  it("viewport de tamanho zero não afirma nada (a primeira medição)", () => {
    // Quem chama trata {0,0} como "monta tudo"; aqui o retângulo é só vazio.
    expect(isBoardInView(board, { x: 0, y: 0, zoom: 1 }, { w: 0, h: 0 })).toBe(false)
  })
})
