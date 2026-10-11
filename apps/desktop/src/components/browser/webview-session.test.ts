import { describe, expect, it, vi } from "vitest"

/**
 * O pool do painel não dá para testar de ponta a ponta aqui: exige Electron, e o
 * `<webview>` recria o guest a cada re-parent. Mas o DEFEITO morava na decisão
 * pura de quando (re)carregar a URL — dois guardas que comparavam a URL PEDIDA
 * em vez do que o guest tinha carregado, e prendiam a aba em about:blank até um
 * F5. É essa tabela de decisão que os testes abaixo fixam.
 *
 * `window` é stubado ANTES do import: o ipc.ts lê `window.platform` no escopo do
 * módulo, e no ambiente node ele não existe.
 */
vi.stubGlobal("window", { platform: "test" })

const { shouldNavigate, shouldRestoreGuest } = await import("./webview-session")

const URL_A = "https://exemplo.com/painel"
const URL_B = "https://exemplo.com/outra"

describe("shouldRestoreGuest", () => {
  it("carrega quando o guest está em branco, mesmo já tendo pedido a URL", () => {
    // O defeito: a tentativa anterior abortou (ERR_ABORTED é o normal num guest
    // recém-reparentado) e deixou o guest em about:blank. `requestedUrl` dizia
    // "já pedi" e o restauro se recusava para sempre.
    expect(shouldRestoreGuest(URL_A, "about:blank", URL_A)).toBe(true)
    expect(shouldRestoreGuest(URL_A, "", URL_A)).toBe(true)
  })

  it("não recarrega quando o guest já está na URL", () => {
    expect(shouldRestoreGuest(URL_A, URL_A, null)).toBe(false)
  })

  it("mantém a trava contra o laço de normalização do Chromium", () => {
    // O guest já carregou uma página REAL (URL normalizada pelo Chromium) e já
    // pedimos essa URL: insistir aqui realimentaria dom-ready + loadURL num laço.
    expect(shouldRestoreGuest(URL_A, "https://exemplo.com/painel/", URL_A)).toBe(false)
  })

  it("não age sem URL real na aba", () => {
    expect(shouldRestoreGuest("", "about:blank", null)).toBe(false)
    expect(shouldRestoreGuest("about:blank", "about:blank", null)).toBe(false)
  })
})

describe("shouldNavigate", () => {
  it("navega quando o guest está em branco, mesmo com a URL atual igual", () => {
    // O outro lado do mesmo defeito: `currentUrl` já era a URL certa, então o
    // early-return por igualdade recusava a carga e nada acontecia.
    expect(shouldNavigate(URL_A, URL_A, "about:blank")).toBe(true)
    expect(shouldNavigate(URL_A, URL_A, "")).toBe(true)
  })

  it("não navega quando o guest já está na URL", () => {
    expect(shouldNavigate(URL_A, URL_A, URL_A)).toBe(false)
  })

  it("navega para uma URL nova ou a partir do vazio", () => {
    expect(shouldNavigate(URL_A, URL_B, URL_A)).toBe(true)
    expect(shouldNavigate("", URL_A, "about:blank")).toBe(true)
  })

  it("ignora url vazia ou about:blank", () => {
    expect(shouldNavigate(URL_A, "", URL_A)).toBe(false)
    expect(shouldNavigate(URL_A, "about:blank", URL_A)).toBe(false)
  })
})
