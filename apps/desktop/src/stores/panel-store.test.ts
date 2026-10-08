import { beforeEach, describe, expect, it } from "vitest"
import { ORPHAN_KEY, usePanelStore } from "./panel-store"

/**
 * A tela de seleção de abas (o "+") fica POR CIMA da aba ativa — é justamente o
 * que permite escolher uma aba nova com outra já aberta. Por isso toda ação que
 * aponta o painel para uma aba precisa dispensá-la: quando alguma esquecia, o
 * "Abrir no painel" de um card da conversa criava a aba e não mostrava nada —
 * ela nascia escondida atrás do selector.
 */
function reset() {
  usePanelStore.setState({
    rightPanelOpen: false,
    selectorOpen: false,
    tabsBySession: {},
    activeTabBySession: {},
  })
}

const tabsOf = (sessionId: string) => usePanelStore.getState().tabsBySession[sessionId] ?? []

describe("abrir uma aba pelo card da conversa", () => {
  beforeEach(reset)

  it("o artefato assume a frente e o selector sai de cena", () => {
    usePanelStore.getState().setSelectorOpen(true)

    usePanelStore.getState().openArtifactTab("s1", "art_1.html", "Vendas")

    const state = usePanelStore.getState()
    expect(state.rightPanelOpen).toBe(true)
    expect(state.selectorOpen).toBe(false)
    const tabs = tabsOf("s1")
    expect(tabs).toHaveLength(1)
    expect(tabs[0]).toMatchObject({ type: "artifact", artifactId: "art_1.html", title: "Vendas" })
    expect(state.activeTabBySession.s1).toBe(tabs[0].id)
  })

  it("reabrir o mesmo artefato foca a aba existente — e também dispensa o selector", () => {
    usePanelStore.getState().openArtifactTab("s1", "art_1.html", "Vendas")
    const first = tabsOf("s1")[0].id
    usePanelStore.getState().setSelectorOpen(true)

    usePanelStore.getState().openArtifactTab("s1", "art_1.html", "Vendas")

    const state = usePanelStore.getState()
    expect(tabsOf("s1")).toHaveLength(1)
    expect(state.activeTabBySession.s1).toBe(first)
    expect(state.selectorOpen).toBe(false)
  })

  it("documento e citação de fonte dispensam o selector igual ao artefato", () => {
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
})

/**
 * A galeria abre artefato e documento no painel que está na tela — num chat
 * novo, o balde órfão. A aba não pode guardar "__orphan__" como sessão: o
 * adoptOrphanTabs só carimba a sessão nova em aba sem dona, e o "adicionar
 * como fonte" do documento iria para um chat que não existe.
 */
describe("abrir uma aba no chat novo, antes de ele virar sessão", () => {
  beforeEach(reset)

  it("a aba nasce sem sessão e herda a que o chat ganhar", () => {
    usePanelStore.getState().openArtifactTab(ORPHAN_KEY, "art_1.html", "Vendas")
    usePanelStore.getState().openDocumentTab(ORPHAN_KEY, { documentId: "doc_1.md", title: "Relatório" })
    usePanelStore.getState().openSourceTab(ORPHAN_KEY, { docId: "doc_2.pdf", page: 1, title: "Contrato" })
    expect(tabsOf(ORPHAN_KEY).map((t) => t.sessionId)).toEqual([undefined, undefined, undefined])

    usePanelStore.getState().adoptOrphanTabs("s1")

    expect(tabsOf(ORPHAN_KEY)).toHaveLength(0)
    expect(tabsOf("s1").map((t) => t.sessionId)).toEqual(["s1", "s1", "s1"])
  })

  it("num chat que já é sessão, a aba guarda a sessão dele", () => {
    usePanelStore.getState().openDocumentTab("s1", { documentId: "doc_1.md", title: "Relatório" })
    expect(tabsOf("s1")[0].sessionId).toBe("s1")
  })
})
