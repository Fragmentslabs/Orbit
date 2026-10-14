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

/**
 * A aba de motion não tem seletor: ela nasce do evento que o main dispara
 * quando o agente registra uma composição (a tool motion_preview). O balde vem
 * no evento; sem sessão nele, o App resolve a do chat ATIVO e o que sobra é o
 * órfão — o balde que o painel mostra quando não há chat aberto.
 */
describe("abrir a aba de motion pelo evento do main", () => {
  beforeEach(reset)

  const motionEvent = (id: string, sessionId?: string) => ({
    type: "motion" as const,
    id,
    entry: "index.html",
    title: "Título",
    sessionId,
  })

  it("abre a aba na sessão do evento e dispensa o selector", () => {
    usePanelStore.getState().setSelectorOpen(true)

    usePanelStore.getState().applyEvent(motionEvent("mv_abc", "s1"))

    const state = usePanelStore.getState()
    expect(state.rightPanelOpen).toBe(true)
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

  it("registrar a MESMA composição de novo traz a aba para o chat atual — uma só", () => {
    usePanelStore.getState().applyEvent(motionEvent("mv_abc", "s1"))
    const first = tabsOf("s1")[0].id
    usePanelStore.getState().setSelectorOpen(true)

    // O usuário trocou de chat: a composição é uma só, e o painel só mostra as
    // abas do chat ATIVO — então a aba vem para o balde dele, mantendo o id.
    // (Focar no balde antigo seria focar numa aba que não está à vista.)
    usePanelStore.getState().applyEvent(motionEvent("mv_abc", "s2"))

    const state = usePanelStore.getState()
    expect(tabsOf("s1")).toHaveLength(0)
    expect(tabsOf("s2")).toHaveLength(1)
    expect(tabsOf("s2")[0].id).toBe(first)
    expect(tabsOf("s2")[0]).toMatchObject({ type: "motion", motionId: "mv_abc", sessionId: "s2" })
    expect(state.activeTabBySession.s2).toBe(first)
    expect(state.selectorOpen).toBe(false)
  })

  it("a mesma composição, já adotada pelo chat, é reusada em vez de duplicada", () => {
    usePanelStore.getState().applyEvent(motionEvent("mv_abc"))
    const orphanId = tabsOf(ORPHAN_KEY)[0].id

    usePanelStore.getState().adoptOrphanTabs("s1")
    usePanelStore.getState().applyEvent(motionEvent("mv_abc", "s1"))

    expect(tabsOf("s1")).toHaveLength(1)
    expect(tabsOf("s1")[0].id).toBe(orphanId)
    expect(usePanelStore.getState().activeTabBySession.s1).toBe(orphanId)
  })

  it("composições diferentes abrem abas diferentes", () => {
    usePanelStore.getState().applyEvent(motionEvent("mv_1", "s1"))
    usePanelStore.getState().applyEvent(motionEvent("mv_2", "s1"))

    expect(tabsOf("s1").map((t) => t.motionId)).toEqual(["mv_1", "mv_2"])
    expect(usePanelStore.getState().activeTabBySession.s1).toBe(tabsOf("s1")[1].id)
  })

  it("sem sessão no evento, a aba cai no balde órfão e o chat novo a adota", () => {
    // O contrato do evento é {id, entry, title}: quem resolve a sessão do chat
    // ativo é o App; sem chat nenhum, o balde é o órfão.
    usePanelStore.getState().applyEvent(motionEvent("mv_xyz"))
    expect(tabsOf(ORPHAN_KEY)).toHaveLength(1)
    expect(tabsOf(ORPHAN_KEY)[0].sessionId).toBeUndefined()

    usePanelStore.getState().adoptOrphanTabs("s1")

    expect(tabsOf(ORPHAN_KEY)).toHaveLength(0)
    expect(tabsOf("s1")[0]).toMatchObject({ type: "motion", motionId: "mv_xyz", sessionId: "s1" })
  })
})

/**
 * O instante de motion é um só: o gesto é apontar UM ponto da composição
 * ("faça isso neste quadro"), então clicar de novo troca o anexo em vez de
 * empilhar dois instantes que não formam um pedido só. Os trechos de documento
 * seguem acumulando — são pedaços diferentes de uma leitura.
 */
describe("anexos de citação no compositor", () => {
  beforeEach(() => usePanelStore.setState({ quotes: [] }))

  const instante = (frame: number) =>
    ({ kind: "motion" as const, file: "index.html", name: "Título", frame, fps: 30 })

  it("o segundo comentário substitui o primeiro instante", () => {
    usePanelStore.getState().addQuote(instante(30))
    usePanelStore.getState().addQuote(instante(69))

    const quotes = usePanelStore.getState().quotes
    expect(quotes).toHaveLength(1)
    expect(quotes[0]).toMatchObject({ kind: "motion", frame: 69 })
  })

  it("o instante não apaga os trechos de documento já anexados", () => {
    usePanelStore.getState().addQuote({ kind: "source", docId: "src1", name: "contrato.pdf", text: "prazo" })
    usePanelStore.getState().addQuote(instante(69))

    expect(usePanelStore.getState().quotes.map((q) => q.kind)).toEqual(["source", "motion"])
  })

  it("os trechos de documento continuam acumulando", () => {
    usePanelStore.getState().addQuote({ kind: "source", docId: "src1", name: "contrato.pdf", text: "prazo" })
    usePanelStore.getState().addQuote({ kind: "document", docId: "doc_1.md", name: "relatório.md", text: "resumo" })

    expect(usePanelStore.getState().quotes).toHaveLength(2)
  })

  it("enviar a mensagem limpa o anexo (mesmo ciclo de vida da citação)", () => {
    usePanelStore.getState().addQuote(instante(69))
    usePanelStore.getState().clearQuotes()

    expect(usePanelStore.getState().quotes).toHaveLength(0)
  })
})
