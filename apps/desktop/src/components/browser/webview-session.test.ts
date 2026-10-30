import { describe, expect, it, vi } from "vitest"

/**
 * The panel pool cannot be tested end to end here: it requires Electron, and the
 * `<webview>` recreates the guest on every re-parent. But the DEFECT lived in the
 * pure decision of when to (re)load the URL — two guards that compared the REQUESTED URL
 * instead of what the guest had loaded, and kept the tab in about:blank until an
 * F5. It is that decision table that the tests below pin down.
 *
 * `window` is stubbed BEFORE the import: ipc.ts reads `window.platform` in the module
 * scope, and in the node environment it does not exist.
 */
vi.stubGlobal("window", { platform: "test" })

const { shouldNavigate, shouldRestoreGuest } = await import("./webview-session")

const URL_A = "https://example.com/painel"
const URL_B = "https://example.com/outra"

describe("shouldRestoreGuest", () => {
  it("loads when the guest is blank, even having already requested the URL", () => {
    // The defect: the previous attempt aborted (ERR_ABORTED is normal in a guest
    // just re-parented) and left the guest in about:blank. `requestedUrl` said
    // "already asked" and the restore refused forever.
    expect(shouldRestoreGuest(URL_A, "about:blank", URL_A)).toBe(true)
    expect(shouldRestoreGuest(URL_A, "", URL_A)).toBe(true)
  })

  it("does not reload when the guest is already at the URL", () => {
    expect(shouldRestoreGuest(URL_A, URL_A, null)).toBe(false)
  })

  it("keeps the lock against Chromium's normalization loop", () => {
    // The guest has already loaded a REAL page (URL normalized by Chromium) and we already
    // asked for that URL: insisting here would feed dom-ready + loadURL back in a loop.
    expect(shouldRestoreGuest(URL_A, "https://example.com/painel/", URL_A)).toBe(false)
  })

  it("does not act without a real URL in the tab", () => {
    expect(shouldRestoreGuest("", "about:blank", null)).toBe(false)
    expect(shouldRestoreGuest("about:blank", "about:blank", null)).toBe(false)
  })
})

describe("shouldNavigate", () => {
  it("navigates when the guest is blank, even with the current URL the same", () => {
    // The other side of the same defect: `currentUrl` was already the right URL, so the
    // early-return by equality refused the load and nothing happened.
    expect(shouldNavigate(URL_A, URL_A, "about:blank")).toBe(true)
    expect(shouldNavigate(URL_A, URL_A, "")).toBe(true)
  })

  it("does not navigate when the guest is already at the URL", () => {
    expect(shouldNavigate(URL_A, URL_A, URL_A)).toBe(false)
  })

  it("navigates to a new URL or from empty", () => {
    expect(shouldNavigate(URL_A, URL_B, URL_A)).toBe(true)
    expect(shouldNavigate("", URL_A, "about:blank")).toBe(true)
  })

  it("ignores an empty url or about:blank", () => {
    expect(shouldNavigate(URL_A, "", URL_A)).toBe(false)
    expect(shouldNavigate(URL_A, "about:blank", URL_A)).toBe(false)
  })
})
