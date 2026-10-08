import { beforeEach, describe, expect, it } from "vitest"
import { usePanelStore } from "./panel-store"

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
