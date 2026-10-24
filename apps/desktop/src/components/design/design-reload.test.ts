import { describe, expect, it } from "vitest"
import { planDesignReload } from "./design-reload"

describe("planDesignReload", () => {
  it("recarrega só o artboard que mudou", () => {
    expect(planDesignReload(["Hero.html"])).toEqual({ index: false, boards: ["Hero.html"], all: false })
  })

  it("o canvas.json re-lê o índice, sem mexer nos artboards", () => {
    expect(planDesignReload(["canvas.json"])).toEqual({ index: true, boards: [], all: false })
  })

  it("uma gravação do agente costuma trazer os dois: índice e telas", () => {
    expect(planDesignReload(["canvas.json", "Hero.html", "Pricing.html"])).toEqual({
      index: true,
      boards: ["Hero.html", "Pricing.html"],
      all: false,
    })
  })

  it("mudança fora dos artboards (CSS, imagem, fonte) recarrega todas as telas", () => {
    expect(planDesignReload(["base.css", "logo.svg"])).toEqual({ index: false, boards: [], all: true })
  })

  it("sem lista, recarrega tudo — como antes do watcher mandar os nomes", () => {
    expect(planDesignReload(undefined)).toEqual({ index: true, boards: [], all: true })
    expect(planDesignReload([])).toEqual({ index: true, boards: [], all: true })
  })

  it("artboard em subpasta mantém o caminho do canvas.json", () => {
    expect(planDesignReload(["pages/About.html"]).boards).toEqual(["pages/About.html"])
  })
})
