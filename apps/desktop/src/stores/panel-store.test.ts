import { beforeEach, describe, expect, it } from "vitest"
import { ORPHAN_KEY, usePanelStore } from "./panel-store"

/**
 * The tab selection screen (the "+") sits ON TOP of the active tab — that is exactly what
 * allows choosing a new tab with another one already open. That is why every action that
 * points the panel at a tab has to dismiss it: when one forgot, the
 * "Open in panel" of a conversation card created the tab and showed nothing —
 * it was born hidden behind the selector.
 */
function reset() {
  usePanelStore.setState({
    openBySession: {},
    // The screen shows "s1" in the tests: it is the bucket of the openings without a session.
    uiBucket: "s1",
    selectorOpen: false,
    tabsBySession: {},
    activeTabBySession: {},
  })
}

const tabsOf = (sessionId: string) => usePanelStore.getState().tabsBySession[sessionId] ?? []

describe("opening a tab from the conversation card", () => {
  beforeEach(reset)

  it("the artifact takes the front and the selector leaves the scene", () => {
    usePanelStore.getState().setSelectorOpen(true)

    usePanelStore.getState().openArtifactTab("s1", "art_1.html", "Vendas")

    const state = usePanelStore.getState()
    expect(state.openBySession.s1).toBe(true)
    expect(state.selectorOpen).toBe(false)
    const tabs = tabsOf("s1")
    expect(tabs).toHaveLength(1)
    expect(tabs[0]).toMatchObject({ type: "artifact", artifactId: "art_1.html", title: "Vendas" })
    expect(state.activeTabBySession.s1).toBe(tabs[0].id)
  })

  it("reopening the same artifact focuses the existing tab — and also dismisses the selector", () => {
    usePanelStore.getState().openArtifactTab("s1", "art_1.html", "Vendas")
    const first = tabsOf("s1")[0].id
    usePanelStore.getState().setSelectorOpen(true)

    usePanelStore.getState().openArtifactTab("s1", "art_1.html", "Vendas")

    const state = usePanelStore.getState()
    expect(tabsOf("s1")).toHaveLength(1)
    expect(state.activeTabBySession.s1).toBe(first)
    expect(state.selectorOpen).toBe(false)
  })

  it("a document and a source citation dismiss the selector just like an artifact", () => {
    usePanelStore.getState().setSelectorOpen(true)
    usePanelStore.getState().openDocumentTab("s1", { documentId: "doc_1.md", title: "Relatório" })
    expect(usePanelStore.getState().selectorOpen).toBe(false)

    usePanelStore.getState().setSelectorOpen(true)
    usePanelStore.getState().openSourceTab("s1", { docId: "src1", page: 1, title: "Contrato" })

    const state = usePanelStore.getState()
    expect(state.selectorOpen).toBe(false)
    const tabs = tabsOf("s1")
    expect(tabs).toHaveLength(2)
    expect(state.activeTabBySession.s1).toBe(tabs[1].id)
  })

  /**
   * The memory citation uses the same gesture — and the same rule: the tab is born
   * pointing at ONE memory, and clicking the same citation again focuses the tab
   * that is already there instead of stacking copies.
   */
  it("the cited memory opens a tab, and the same memory reuses the tab", () => {
    usePanelStore.getState().setSelectorOpen(true)
    usePanelStore.getState().openMemoryTab("s1", { memoryId: "mem_abc123", title: "Idioma" })

    const first = tabsOf("s1")
    expect(first).toHaveLength(1)
    expect(first[0]).toMatchObject({ type: "memory", memoryId: "mem_abc123", title: "Idioma", sessionId: "s1" })
    expect(usePanelStore.getState().selectorOpen).toBe(false)

    usePanelStore.getState().openMemoryTab("s1", { memoryId: "mem_def456", title: "Design system" })
    usePanelStore.getState().openMemoryTab("s1", { memoryId: "mem_abc123", title: "Idioma" })

    const tabs = tabsOf("s1")
    expect(tabs).toHaveLength(2)
    expect(usePanelStore.getState().activeTabBySession.s1).toBe(tabs[0].id)
  })
})

/**
 * The gallery opens artifact and document in the panel that is on the screen — in a new
 * chat, the orphan bucket. The tab cannot keep "__orphan__" as its session: the
 * adoptOrphanTabs only stamps the new session on a tab without an owner, and the document's "add
 * as source" would go to a chat that does not exist.
 */
describe("opening a tab in the new chat, before it becomes a session", () => {
  beforeEach(reset)

  it("the tab is born with no session and inherits the one the chat gets", () => {
    usePanelStore.getState().openArtifactTab(ORPHAN_KEY, "art_1.html", "Vendas")
    usePanelStore.getState().openDocumentTab(ORPHAN_KEY, { documentId: "doc_1.md", title: "Relatório" })
    usePanelStore.getState().openSourceTab(ORPHAN_KEY, { docId: "doc_2.pdf", page: 1, title: "Contrato" })
    expect(tabsOf(ORPHAN_KEY).map((t) => t.sessionId)).toEqual([undefined, undefined, undefined])

    usePanelStore.getState().adoptOrphanTabs("s1")

    expect(tabsOf(ORPHAN_KEY)).toHaveLength(0)
    expect(tabsOf("s1").map((t) => t.sessionId)).toEqual(["s1", "s1", "s1"])
  })

  it("in a chat that is already a session, the tab keeps its session", () => {
    usePanelStore.getState().openDocumentTab("s1", { documentId: "doc_1.md", title: "Relatório" })
    expect(tabsOf("s1")[0].sessionId).toBe("s1")
  })
})

/**
 * The motion tab has no selector: it is born from the event main fires
 * when the agent registers a composition (the motion_preview tool). The bucket comes
 * in the event; without a session in it, the App resolves the ACTIVE chat's and what is left is the
 * orphan — the bucket the panel shows when there is no chat open.
 */
describe("opening the motion tab from the main event", () => {
  beforeEach(reset)

  const motionEvent = (id: string, sessionId?: string) => ({
    type: "motion" as const,
    id,
    entry: "index.html",
    title: "Título",
    sessionId,
  })

  it("opens the tab in the event's session and dismisses the selector", () => {
    usePanelStore.getState().setSelectorOpen(true)

    usePanelStore.getState().applyEvent(motionEvent("mv_abc", "s1"))

    const state = usePanelStore.getState()
    expect(state.openBySession.s1).toBe(true)
    expect(state.selectorOpen).toBe(false)
    const tabs = tabsOf("s1")
    expect(tabs).toHaveLength(1)
    expect(tabs[0]).toMatchObject({
      type: "motion",
      motionId: "mv_abc",
      motionEntry: "index.html",
      title: "Título",
      sessionId: "s1",
    })
    expect(state.activeTabBySession.s1).toBe(tabs[0].id)
  })

  /**
   * The piece is one per CONVERSATION. The agent may touch the same composition from
   * another chat, and taking the tab from the chat where the user opened it would be touching
   * what they are seeing — each bucket has its own, and since the panel only shows the
   * active chat's tabs, there are never two in sight.
   */
  it("a composition opened in another conversation stays where it is", () => {
    usePanelStore.getState().applyEvent(motionEvent("mv_abc", "s1"))
    const first = tabsOf("s1")[0].id

    usePanelStore.getState().applyEvent(motionEvent("mv_abc", "s2"))

    const state = usePanelStore.getState()
    expect(tabsOf("s1")).toHaveLength(1)
    expect(tabsOf("s1")[0].id).toBe(first)
    expect(tabsOf("s2")).toHaveLength(1)
    expect(tabsOf("s2")[0]).toMatchObject({ type: "motion", motionId: "mv_abc", sessionId: "s2" })
    expect(state.activeTabBySession.s2).toBe(tabsOf("s2")[0].id)
  })

  it("a background chat's tab opens ITS panel, not the screen's", () => {
    // The screen is on "s1" (see reset) and the agent works on "s2".
    usePanelStore.getState().applyEvent(motionEvent("mv_abc", "s2"))

    const { openBySession } = usePanelStore.getState()
    expect(openBySession.s2).toBe(true)
    expect(openBySession.s1 ?? false).toBe(false)
  })

  it("closing one chat's panel does not close the other's", () => {
    usePanelStore.getState().setUiBucket("s2")
    usePanelStore.getState().setRightPanelOpen(true)
    usePanelStore.getState().setUiBucket("s1")
    usePanelStore.getState().setRightPanelOpen(false)

    expect(usePanelStore.getState().openBySession).toEqual({ s2: true, s1: false })
  })

  it("the panel opened in the new chat stays open in the session it gets", () => {
    usePanelStore.getState().applyEvent(motionEvent("mv_abc"))
    expect(usePanelStore.getState().openBySession[ORPHAN_KEY]).toBe(true)

    usePanelStore.getState().adoptOrphanTabs("s1")

    expect(usePanelStore.getState().openBySession.s1).toBe(true)
  })

  it("the same composition, already adopted by the chat, is reused instead of duplicated", () => {
    usePanelStore.getState().applyEvent(motionEvent("mv_abc"))
    const orphanId = tabsOf(ORPHAN_KEY)[0].id

    usePanelStore.getState().adoptOrphanTabs("s1")
    usePanelStore.getState().applyEvent(motionEvent("mv_abc", "s1"))

    expect(tabsOf("s1")).toHaveLength(1)
    expect(tabsOf("s1")[0].id).toBe(orphanId)
    expect(usePanelStore.getState().activeTabBySession.s1).toBe(orphanId)
  })

  it("different compositions open different tabs", () => {
    usePanelStore.getState().applyEvent(motionEvent("mv_1", "s1"))
    usePanelStore.getState().applyEvent(motionEvent("mv_2", "s1"))

    expect(tabsOf("s1").map((t) => t.motionId)).toEqual(["mv_1", "mv_2"])
    expect(usePanelStore.getState().activeTabBySession.s1).toBe(tabsOf("s1")[1].id)
  })

  it("with no session in the event, the tab falls into the orphan bucket and the new chat adopts it", () => {
    // The event contract is {id, entry, title}: whoever resolves the chat's session
    // is the App; with no chat at all, the bucket is the orphan.
    usePanelStore.getState().applyEvent(motionEvent("mv_xyz"))
    expect(tabsOf(ORPHAN_KEY)).toHaveLength(1)
    expect(tabsOf(ORPHAN_KEY)[0].sessionId).toBeUndefined()

    usePanelStore.getState().adoptOrphanTabs("s1")

    expect(tabsOf(ORPHAN_KEY)).toHaveLength(0)
    expect(tabsOf("s1")[0]).toMatchObject({ type: "motion", motionId: "mv_xyz", sessionId: "s1" })
  })
})

/**
 * The motion instant is a single one: the gesture is pointing at ONE point of the composition
 * ("do this on this frame"), so clicking again swaps the attachment instead of
 * stacking two instants that do not form a single request. The document stretches
 * keep accumulating — they are different pieces of one reading.
 */
describe("citation attachments in the composer", () => {
  beforeEach(() => usePanelStore.setState({ quotes: [] }))

  const instante = (frame: number) =>
    ({ kind: "motion" as const, file: "index.html", name: "Título", frame, fps: 30 })

  it("the second comment replaces the first instant", () => {
    usePanelStore.getState().addQuote(instante(30))
    usePanelStore.getState().addQuote(instante(69))

    const quotes = usePanelStore.getState().quotes
    expect(quotes).toHaveLength(1)
    expect(quotes[0]).toMatchObject({ kind: "motion", frame: 69 })
  })

  it("the instant does not erase document excerpts already attached", () => {
    usePanelStore.getState().addQuote({ kind: "source", docId: "src1", name: "contrato.pdf", text: "prazo" })
    usePanelStore.getState().addQuote(instante(69))

    expect(usePanelStore.getState().quotes.map((q) => q.kind)).toEqual(["source", "motion"])
  })

  it("the document excerpts keep piling up", () => {
    usePanelStore.getState().addQuote({ kind: "source", docId: "src1", name: "contrato.pdf", text: "prazo" })
    usePanelStore.getState().addQuote({ kind: "document", docId: "doc_1.md", name: "relatório.md", text: "resumo" })

    expect(usePanelStore.getState().quotes).toHaveLength(2)
  })

  it("sending the message clears the attachment (same lifecycle as the citation)", () => {
    usePanelStore.getState().addQuote(instante(69))
    usePanelStore.getState().clearQuotes()

    expect(usePanelStore.getState().quotes).toHaveLength(0)
  })
})
