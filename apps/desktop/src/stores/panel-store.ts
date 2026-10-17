import { create } from "zustand"

export type TabType = "chat" | "terminal" | "process" | "folders" | "browser" | "diff" | "media" | "artifact" | "sources" | "source" | "document" | "motion"

export interface PanelTab {
  id: string
  type: TabType
  title: string
  sessionId?: string
  messageId?: string
  /** Aba Diff de uma task da esteira (em vez de mensagem de chat) */
  esteiraId?: string
  taskId?: string
  pending?: boolean
  /** URL inicial da aba Browser (ausente = abre a tela padrão com busca). */
  url?: string
  /** Aba Processo: PID do processo em background cuja saída a aba acompanha. */
  processPid?: number
  /** Aba Artefato: id do registro (art_xxx.html) que a aba renderiza. */
  artifactId?: string
  /** Aba Documento: id do registro (doc_xxx.md) aberto no canvas de Markdown. */
  documentId?: string
  /** Aba Motion: id do registro (mv_xxx) da composição que a aba renderiza. */
  motionId?: string
  /** Caminho da entrada da composição DENTRO da pasta registrada — é o que a
   *  URL `orbit-motion://<id>/<caminho-relativo>` serve. */
  motionEntry?: string
  /** Caminho ABSOLUTO da entrada — o que a nota de motion entrega ao agente
   *  (a entrada sozinha, "index.html", não diz de qual composição se fala). */
  motionPath?: string
  /** Aba Fonte: documento aberto por uma citacao, e o trecho a grifar. */
  sourceDocId?: string
  sourcePage?: number
  sourceFromLine?: number
  sourceToLine?: number
}

export interface BrowserSelection {
  id: string
  tag: string
  selector: string
  text: string
  html: string
  url: string
}

/**
 * Trecho citado do visualizador de documento, esperando para ser enviado.
 *
 * Vive no mesmo lugar das seleções do browser do painel porque é o mesmo
 * gesto: algo selecionado num painel que vira anexo da próxima mensagem. O
 * compositor lê daqui na hora de enviar.
 */
export interface DocumentQuote {
  id: string
  /** Documento do agente ou fonte da conversa — ver DocumentQuotePayload. */
  kind: "document" | "source"
  docId: string
  /** Nome exibível do documento — é o que aparece no chip. */
  name: string
  page?: number
  fromLine?: number
  toLine?: number
  text: string
}

/**
 * Instante apontado na aba Motion, esperando para ser enviado.
 *
 * Mesmo lugar e mesmo gesto dos trechos citados — apontar algo num painel e
 * anexar à próxima mensagem — mas o que se aponta é um INSTANTE, não um trecho
 * de texto: por isso os campos são outros (composição, quadro, fps). O quadro é
 * a verdade; os segundos são derivados para exibição (ver MotionQuotePayload).
 */
export interface MotionQuote {
  id: string
  kind: "motion"
  /** Caminho da entrada DENTRO da pasta registrada (ver PanelTab.motionEntry). */
  file: string
  /** Nome exibível da composição. */
  name: string
  /** Quadro inteiro do playhead no momento do clique. */
  frame: number
  fps: number
  /** Caminho absoluto da entrada (ver PanelTab.motionPath). */
  path?: string
  /** Camada selecionada na faixa de camadas, quando houver. */
  layer?: string
  /** Faixa de som selecionada, quando o foco é um som e não um elemento do DOM
   *  (o áudio da peça vive fora do palco — ver motion-audio.ts). */
  audio?: string
  /** Camadas em cena naquele quadro. */
  onScreen?: string[]
}

/** O que um anexo de citação pode ser — ver QuotePayload. */
export type PanelQuote = DocumentQuote | MotionQuote

export interface Viewport {
  width: number
  height: number
  label: string
}

export interface ActivityEntry {
  id: string
  label: string
  at: number
}

export type PanelEvent =
  | { type: "ensure"; url?: string; sessionId: string }
  | { type: "resize"; width: number | null; height: number | null; label: string }
  | { type: "fullscreen"; on: boolean }
  | { type: "activity"; label: string; sessionId?: string }
  /**
   * A tool registrou uma composição de motion e quer o preview no painel.
   * `id` é o registro do main (mv_xxx), `entry` a entrada dentro da pasta que o
   * scheme serve e `title` o nome exibível. `sessionId` é opcional: o contrato
   * do evento é só `{id, entry, title}`, e sem ele a aba cai no balde do chat
   * ativo (resolvido no App) ou no órfão.
   */
  | { type: "motion"; id: string; entry: string; title: string; sessionId?: string; path?: string }

/** Registro do browser do agente por sessão de chat/task. */
export interface AgentBrowserEntry {
  /** Última URL que o agente abriu/está vendo. */
  url: string
  /** Último instante em que o agente mexeu no browser (mantém o indicador fresco). */
  at: number
}

/** Janela de "recentemente usado" do indicador de browser do agente (ms). */
export const AGENT_BROWSER_FRESH_MS = 30_000

interface PanelState {
  rightPanelOpen: boolean
  setRightPanelOpen: (open: boolean) => void

  /** SelectorScreen aberto pelo "+" mesmo com aba ativa — a tela inicial do
   *  painel, onde ficam a grade de abas e os processos em background. */
  selectorOpen: boolean
  setSelectorOpen: (open: boolean) => void
  /** Abre (ou reaproveita) a aba que acompanha a saída de um processo em
   *  background. `sessionId` é a chave do balde de abas (chat ativo ou órfão). */
  openProcessTab: (sessionId: string, pid: number, title: string, ownerSessionId?: string) => void

  /** Tabs por sessão de chat */
  tabsBySession: Record<string, PanelTab[]>
  activeTabBySession: Record<string, string | null>
  addTab: (sessionId: string, tab: PanelTab) => void
  removeTab: (sessionId: string, tabId: string) => void
  /** Fecha as abas das composições de motion que foram excluídas (em qualquer conversa). */
  closeMotionTabs: (motionIds: string[]) => void
  setActiveTab: (sessionId: string, tabId: string | null) => void
  setTabsForSession: (sessionId: string, tabs: PanelTab[], activeId: string | null) => void
  /** Abre (ou reaproveita) a aba que renderiza um artefato em tela cheia.
   *  Chamada pelo card na conversa e pela galeria. */
  openArtifactTab: (sessionId: string, artifactId: string, title: string) => void
  /** Abre (ou reaproveita) o preview de uma composição de motion. Chamada pelo
   *  evento `motion` do main (a tool registrou a pasta) — nunca pelo seletor.
   *  Reabrir a MESMA composição foca a aba onde ela estiver. */
  openMotionTab: (ref: { id: string; entry: string; title: string; sessionId?: string; path?: string }) => void
  /** Abre (ou reaproveita) o canvas de Markdown de um documento vivo — o que
   *  foi PEDIDO como PDF/Word abre no visualizador, pelo openSourceTab. */
  openDocumentTab: (sessionId: string, ref: { documentId: string; title: string }) => void
  /** Abre (ou reaproveita) a aba que mostra uma fonte no trecho citado.
   *  Chamada pela citacao na conversa. */
  openSourceTab: (
    sessionId: string,
    ref: { docId: string; page: number; fromLine?: number; toLine?: number; title: string },
  ) => void
  /** Chat novo virou sessão: as abas abertas no balde órfão passam a ser dela. */
  adoptOrphanTabs: (sessionId: string) => void
  getTabs: (sessionId: string) => PanelTab[]
  getActiveTabId: (sessionId: string) => string | null
  /** Atualiza o título das abas de chat que apontam para uma sessão (ex.: agente nomeou o chat). */
  renameChatTabs: (sessionId: string, title: string) => void
  /** URL atual de uma aba de browser — chamada pelo pool a cada navegação,
   *  inclusive com a aba desmontada (agente navegando em background). É o que
   *  faz a aba voltar na mesma página ao sair e entrar do chat. */
  setTabUrl: (sessionId: string, tabId: string, url: string) => void

  /** Browser do agente por sessão (chat/task): URL atual + último uso. Alimenta
   *  o indicador "testando…" no header e na conversa. A entrada só some quando
   *  a sessão é encerrada; a frescura é medida por `at` + AGENT_BROWSER_FRESH_MS. */
  agentBrowser: Record<string, AgentBrowserEntry>
  /** Garante a aba Browser do agente na sessão (cria/atualiza), sem abrir o painel. */
  ensureAgentBrowserTab: (sessionId: string, url?: string) => void
  /** Abre o painel lateral com o browser do agente da sessão (clique do usuário). */
  openAgentBrowser: (sessionId: string) => void
  /** Link clicado no terminal: abre uma NOVA aba de browser com a URL, na sessão do terminal. */
  openTerminalLink: (sessionId: string, url: string) => void
  selectMode: boolean
  setSelectMode: (value: boolean) => void
  selections: BrowserSelection[]
  addSelection: (selection: Omit<BrowserSelection, "id">) => void
  removeSelection: (id: string) => void
  clearSelections: () => void
  quotes: PanelQuote[]
  /** Anexa um trecho citado ou um instante de motion. O instante SUBSTITUI o
   *  anterior em vez de acumular: dois quadros da mesma composição não formam um
   *  pedido só — o usuário quer "este ponto", não "estes pontos". */
  addQuote: (quote: Omit<DocumentQuote, "id"> | Omit<MotionQuote, "id">) => void
  removeQuote: (id: string) => void
  clearQuotes: () => void
  viewport: Viewport | null
  setViewport: (viewport: Viewport | null) => void
  fullscreen: boolean
  setFullscreen: (value: boolean) => void
  agentActive: boolean
  activity: ActivityEntry[]
  pushActivity: (label: string) => void
  applyEvent: (event: PanelEvent) => void

  openChatTab: (sessionId: string, title: string) => void
  pendingChatTab: number
  pendingChatTabSession?: string
  pendingChatTabTitle?: string

  openChatTabWithPendingInput: (sessionId: string, title: string, input: string) => void
  pendingInput: { sessionId: string; text: string } | null
  setPendingInput: (val: { sessionId: string; text: string } | null) => void

  openDiff: (sessionId: string, messageId: string, title: string) => void
  /** Diff de uma task da esteira — mesmo painel, outra fonte do patch */
  openTaskDiff: (esteiraId: string, taskId: string, title: string) => void
  pendingDiff: number
  pendingDiffSessionId?: string
  pendingDiffMessageId?: string
  pendingDiffEsteiraId?: string
  pendingDiffTaskId?: string
  pendingDiffTitle?: string
}

/** Balde das abas de um chat que ainda nao virou sessao (ver adoptOrphanTabs). */
export const ORPHAN_KEY = "__orphan__"

/**
 * Sessão gravada na aba. No balde órfão não há sessão ainda: a aba fica sem
 * dona, e o adoptOrphanTabs carimba a que nascer — gravar "__orphan__" nela
 * a prenderia a um id que não existe.
 */
function tabSession(sessionId: string): string | undefined {
  return sessionId === ORPHAN_KEY ? undefined : sessionId
}

let activeTimer: ReturnType<typeof setTimeout> | null = null
const ACTIVE_TIMEOUT_MS = 6000

let _nextTabId = 0
export function nextTabId(): number {
  return ++_nextTabId
}

export const usePanelStore = create<PanelState>((set, get) => {
  const markActive = () => {
    if (activeTimer) clearTimeout(activeTimer)
    activeTimer = setTimeout(() => set({ agentActive: false }), ACTIVE_TIMEOUT_MS)
    set({ agentActive: true })
  }

  return {
    rightPanelOpen: false,
    setRightPanelOpen: (open) => set({ rightPanelOpen: open }),

    selectorOpen: false,
    setSelectorOpen: (open) => set({ selectorOpen: open }),

    // Uma aba por processo: clicar de novo no mesmo card foca a aba que já
    // acompanha a saída em vez de empilhar duas visões do mesmo stdout.
    openProcessTab: (sessionId, pid, title, ownerSessionId) =>
      set((state) => {
        const tabs = state.tabsBySession[sessionId] ?? []
        const existing = tabs.find((t) => t.type === "process" && t.processPid === pid)
        const id = existing?.id ?? `process-${nextTabId()}`
        const nextTabs = existing
          ? tabs
          : [
              {
                id,
                type: "process" as const,
                title,
                processPid: pid,
                // Dono do processo: no modo "todos os chats" uma linha abre a
                // saída de um processo de OUTRO chat, e o main só devolve output
                // para o dono (getProcessOutput). A aba continua no balde atual.
                sessionId: ownerSessionId,
              },
            ]
        return {
          rightPanelOpen: true,
          selectorOpen: false,
          tabsBySession: { ...state.tabsBySession, [sessionId]: nextTabs },
          activeTabBySession: { ...state.activeTabBySession, [sessionId]: id },
        }
      }),

    tabsBySession: {},
    activeTabBySession: {},

    addTab: (sessionId, tab) =>
      set((state) => ({
        tabsBySession: {
          ...state.tabsBySession,
          [sessionId]: [...(state.tabsBySession[sessionId] ?? []), tab],
        },
      })),

    closeMotionTabs: (motionIds) =>
      set((state) => {
        if (motionIds.length === 0) return state
        const gone = new Set(motionIds)
        const tabsBySession: typeof state.tabsBySession = {}
        const activeTabBySession = { ...state.activeTabBySession }
        for (const [key, tabs] of Object.entries(state.tabsBySession)) {
          const next = tabs.filter((t) => !(t.type === "motion" && t.motionId && gone.has(t.motionId)))
          tabsBySession[key] = next
          if (next.length !== tabs.length && !next.some((t) => t.id === activeTabBySession[key])) {
            activeTabBySession[key] = next.length > 0 ? next[0].id : null
          }
        }
        return { tabsBySession, activeTabBySession }
      }),

    removeTab: (sessionId, tabId) =>
      set((state) => {
        const tabs = state.tabsBySession[sessionId]
        if (!tabs) return state
        const next = tabs.filter((t) => t.id !== tabId)
        const activeId = state.activeTabBySession[sessionId]
        let nextActive = state.activeTabBySession
        if (activeId === tabId || next.length === 0) {
          const newActive = next.length > 0 ? next[Math.min(0, next.length - 1)].id : null
          nextActive = { ...state.activeTabBySession, [sessionId]: newActive }
        }
        return {
          tabsBySession: { ...state.tabsBySession, [sessionId]: next },
          activeTabBySession: nextActive,
        }
      }),

    setActiveTab: (sessionId, tabId) =>
      set((state) => ({
        activeTabBySession: { ...state.activeTabBySession, [sessionId]: tabId },
      })),

    setTabsForSession: (sessionId, tabs, activeId) =>
      set((state) => ({
        tabsBySession: { ...state.tabsBySession, [sessionId]: tabs },
        activeTabBySession: { ...state.activeTabBySession, [sessionId]: activeId },
      })),

    // Abrir uma aba a partir da CONVERSA (card de artefato/documento, citação
    // de fonte) aponta o painel para ela — então o selector de abas sai de
    // cena, como já fazem o card de processo e o link do terminal. Sem isto,
    // quem estava com a tela de seleção aberta (o "+") clicava "Abrir no
    // painel" e nada acontecia: a aba nascia escondida atrás do selector.
    openArtifactTab: (sessionId, artifactId, title) =>
      set((state) => {
        const tabs = state.tabsBySession[sessionId] ?? []
        // Reabrir o mesmo artefato foca a aba existente em vez de empilhar
        // cópias — o artefato é um só, a aba também.
        const existing = tabs.find((t) => t.type === "artifact" && t.artifactId === artifactId)
        if (existing) {
          return {
            rightPanelOpen: true,
            selectorOpen: false,
            activeTabBySession: { ...state.activeTabBySession, [sessionId]: existing.id },
          }
        }
        const tab: PanelTab = {
          id: `artifact-${nextTabId()}`,
          type: "artifact",
          title,
          sessionId: tabSession(sessionId),
          artifactId,
        }
        return {
          rightPanelOpen: true,
          selectorOpen: false,
          tabsBySession: { ...state.tabsBySession, [sessionId]: [...tabs, tab] },
          activeTabBySession: { ...state.activeTabBySession, [sessionId]: tab.id },
        }
      }),

    // A composição de motion é um recurso do PROJETO, não de uma mensagem: a
    // aba nasce do evento do main que registrou a pasta. A mesma peça é UMA
    // aba, onde ela estiver — duas seriam dois iframes e dois playheads da
    // mesma coisa.
    openMotionTab: (ref) =>
      set((state) => {
        const bucket = ref.sessionId ?? ORPHAN_KEY
        const tabsBySession = { ...state.tabsBySession }
        for (const [key, tabs] of Object.entries(tabsBySession)) {
          // A mesma composição pelo id OU pelo arquivo: uma aba antiga (de antes
          // do id estável) é reaproveitada e passa a apontar para o id novo.
          const existing = tabs.find(
            (t) => t.type === "motion" && (t.motionId === ref.id || (ref.path != null && t.motionPath === ref.path)),
          )
          if (!existing) continue
          if (key === bucket) {
            const refreshed: PanelTab = {
              ...existing,
              motionId: ref.id,
              motionEntry: ref.entry,
              motionPath: ref.path ?? existing.motionPath,
            }
            tabsBySession[key] = tabs.map((t) => (t === existing ? refreshed : t))
            return {
              rightPanelOpen: true,
              selectorOpen: false,
              tabsBySession,
              activeTabBySession: { ...state.activeTabBySession, [bucket]: existing.id },
            }
          }
          // Já aberta em OUTRO balde: a aba VEM para o balde em que o usuário
          // está. O painel só mostra as abas do chat ativo — "focar" uma aba
          // de outro balde seria focar no que não se vê. É o mesmo movimento do
          // adoptOrphanTabs, com o sessionId do balde novo.
          const rest = tabs.filter((t) => t !== existing)
          if (rest.length > 0) tabsBySession[key] = rest
          else delete tabsBySession[key]
          const moved: PanelTab = {
            ...existing,
            title: ref.title,
            motionId: ref.id,
            motionEntry: ref.entry,
            motionPath: ref.path ?? existing.motionPath,
            sessionId: tabSession(bucket),
          }
          tabsBySession[bucket] = [...(tabsBySession[bucket] ?? []), moved]
          return {
            rightPanelOpen: true,
            selectorOpen: false,
            tabsBySession,
            activeTabBySession: { ...state.activeTabBySession, [bucket]: moved.id },
          }
        }
        // Sem sessão no evento, o balde é o do chat ativo — resolvido pelo
        // consumidor do evento (App), que conhece o modo corrente; aqui sobra o
        // órfão, que é o balde que o painel mostra quando não há chat ativo.
        const tab: PanelTab = {
          id: `motion-${nextTabId()}`,
          type: "motion",
          title: ref.title,
          sessionId: tabSession(bucket),
          motionId: ref.id,
          motionEntry: ref.entry,
          motionPath: ref.path,
        }
        return {
          rightPanelOpen: true,
          selectorOpen: false,
          tabsBySession: { ...tabsBySession, [bucket]: [...(tabsBySession[bucket] ?? []), tab] },
          activeTabBySession: { ...state.activeTabBySession, [bucket]: tab.id },
        }
      }),

    openDocumentTab: (sessionId, ref) =>
      set((state) => {
        const tabs = state.tabsBySession[sessionId] ?? []
        // Uma aba por documento, como no artefato: o documento é um só, e
        // abrir o mesmo duas vezes daria dois editores sobre o mesmo arquivo.
        const existing = tabs.find((t) => t.type === "document" && t.documentId === ref.documentId)
        if (existing) {
          return {
            rightPanelOpen: true,
            selectorOpen: false,
            activeTabBySession: { ...state.activeTabBySession, [sessionId]: existing.id },
          }
        }
        const tab: PanelTab = {
          id: `document-${nextTabId()}`,
          type: "document",
          title: ref.title,
          sessionId: tabSession(sessionId),
          documentId: ref.documentId,
        }
        return {
          rightPanelOpen: true,
          selectorOpen: false,
          tabsBySession: { ...state.tabsBySession, [sessionId]: [...tabs, tab] },
          activeTabBySession: { ...state.activeTabBySession, [sessionId]: tab.id },
        }
      }),

    openSourceTab: (sessionId, ref) =>
      set((state) => {
        const tabs = state.tabsBySession[sessionId] ?? []
        // Uma aba por documento: clicar em outra citação do MESMO arquivo
        // reaproveita a aba e só troca o trecho grifado — empilhar uma aba por
        // citação encheria o painel numa resposta com dez referências.
        const existing = tabs.find((t) => t.type === "source" && t.sourceDocId === ref.docId)
        const patch = {
          sourcePage: ref.page,
          sourceFromLine: ref.fromLine,
          sourceToLine: ref.toLine,
        }
        if (existing) {
          return {
            rightPanelOpen: true,
            selectorOpen: false,
            tabsBySession: {
              ...state.tabsBySession,
              [sessionId]: tabs.map((t) => (t.id === existing.id ? { ...t, ...patch } : t)),
            },
            activeTabBySession: { ...state.activeTabBySession, [sessionId]: existing.id },
          }
        }
        const tab: PanelTab = {
          id: `source-${nextTabId()}`,
          type: "source",
          title: ref.title,
          sessionId: tabSession(sessionId),
          sourceDocId: ref.docId,
          ...patch,
        }
        return {
          rightPanelOpen: true,
          selectorOpen: false,
          tabsBySession: { ...state.tabsBySession, [sessionId]: [...tabs, tab] },
          activeTabBySession: { ...state.activeTabBySession, [sessionId]: tab.id },
        }
      }),

    adoptOrphanTabs: (sessionId) =>
      set((state) => {
        const orphans = state.tabsBySession[ORPHAN_KEY]
        if (!orphans || orphans.length === 0) return state
        // A sessão nova não tem abas; se tivesse, as dela mandam — o órfão é
        // um rascunho, não pode sobrescrever o que já existe.
        if ((state.tabsBySession[sessionId] ?? []).length > 0) return state
        const tabsBySession = { ...state.tabsBySession }
        delete tabsBySession[ORPHAN_KEY]
        tabsBySession[sessionId] = orphans.map((tab) =>
          // A aba de chat pendente segue apontando para o que ela criou.
          tab.sessionId || tab.pending ? tab : { ...tab, sessionId },
        )
        const activeTabBySession = { ...state.activeTabBySession }
        activeTabBySession[sessionId] = activeTabBySession[ORPHAN_KEY] ?? null
        delete activeTabBySession[ORPHAN_KEY]
        return { tabsBySession, activeTabBySession }
      }),

    getTabs: (sessionId) => get().tabsBySession[sessionId] ?? [],

    getActiveTabId: (sessionId) => get().activeTabBySession[sessionId] ?? null,

    renameChatTabs: (sessionId, title) =>
      set((state) => {
        let changed = false
        const tabsBySession: Record<string, PanelTab[]> = {}
        for (const [sk, tabs] of Object.entries(state.tabsBySession)) {
          const next = tabs.map((t) =>
            t.sessionId === sessionId && t.type === "chat" && t.title !== title ? { ...t, title } : t,
          )
          if (next.some((t, i) => t !== tabs[i])) changed = true
          tabsBySession[sk] = next
        }
        return changed ? { tabsBySession } : state
      }),

    setTabUrl: (sessionId, tabId, url) =>
      set((state) => {
        const tabs = state.tabsBySession[sessionId]
        if (!tabs) return state
        const index = tabs.findIndex((t) => t.id === tabId)
        if (index < 0 || tabs[index].url === url) return state
        const next = [...tabs]
        next[index] = { ...next[index], url }
        return { tabsBySession: { ...state.tabsBySession, [sessionId]: next } }
      }),

    agentBrowser: {},

    ensureAgentBrowserTab: (sessionId, url) => {
      if (!sessionId) return
      set((state) => {
        const tabs = state.tabsBySession[sessionId] ?? []
        const id = "browser-agent"
        const existing = tabs.find((t) => t.id === id)
        let nextTabs = tabs
        if (!existing) {
          nextTabs = [...tabs, { id, type: "browser", title: "Browser", url }]
        } else if (url && existing.url !== url) {
          nextTabs = tabs.map((t) => (t.id === id ? { ...t, url } : t))
        }
        const activeId = state.activeTabBySession[sessionId] ?? id
        return {
          tabsBySession: { ...state.tabsBySession, [sessionId]: nextTabs },
          activeTabBySession: { ...state.activeTabBySession, [sessionId]: activeId },
        }
      })
    },

    openAgentBrowser: (sessionId) => {
      if (!sessionId) return
      const { agentBrowser } = get()
      get().ensureAgentBrowserTab(sessionId, agentBrowser[sessionId]?.url)
      set({ rightPanelOpen: true, selectorOpen: false })
    },

    // Cada clique em link no terminal cria uma aba própria (semântica de
    // "nova aba", como um browser de verdade) — não reusa a aba do agente.
    openTerminalLink: (sessionId, url) =>
      set((state) => {
        const id = `browser-${nextTabId()}`
        const tabs = state.tabsBySession[sessionId] ?? []
        return {
          rightPanelOpen: true,
          // Clique do usuário (link do terminal / card do processo): a aba nova
          // assume a frente, então o selector deixa de estar em exibição.
          selectorOpen: false,
          tabsBySession: {
            ...state.tabsBySession,
            [sessionId]: [...tabs, { id, type: "browser", title: "Browser", url }],
          },
          activeTabBySession: { ...state.activeTabBySession, [sessionId]: id },
        }
      }),
    selectMode: false,
    setSelectMode: (value) => set({ selectMode: value }),
    selections: [],
    addSelection: (selection) =>
      set((state) => ({
        selections: [
          ...state.selections,
          { ...selection, id: `sel_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}` },
        ],
        selectMode: false,
      })),
    removeSelection: (id) =>
      set((state) => ({ selections: state.selections.filter((s) => s.id !== id) })),
    clearSelections: () => set({ selections: [] }),

    quotes: [],
    addQuote: (quote) =>
      set((state) => {
        // Um instante de motion substitui o anterior (ver PanelState.addQuote);
        // os trechos de documento seguem acumulando.
        const atuais = quote.kind === "motion" ? state.quotes.filter((q) => q.kind !== "motion") : state.quotes
        return {
          quotes: [...atuais, { ...quote, id: `quote-${Date.now()}-${atuais.length}` } as PanelQuote],
        }
      }),
    removeQuote: (id) => set((state) => ({ quotes: state.quotes.filter((q) => q.id !== id) })),
    clearQuotes: () => set({ quotes: [] }),
    viewport: null,
    setViewport: (viewport) => set({ viewport }),
    fullscreen: false,
    setFullscreen: (value) => set({ fullscreen: value }),
    agentActive: false,
    activity: [],
    pushActivity: (label) => {
      markActive()
      set((state) => ({
        activity: [
          { id: `act_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, label, at: Date.now() },
          ...state.activity,
        ].slice(0, 30),
      }))
    },

    applyEvent: (event) => {
      switch (event.type) {
        case "ensure": {
          markActive()
          // Nunca abre o painel: só registra o browser do agente da sessão e
          // garante a aba (o webview em si é criado pelo App.tsx, no host
          // oculto). A UI aparece quando o usuário clica no indicador.
          set((state) => ({
            agentBrowser: {
              ...state.agentBrowser,
              [event.sessionId]: {
                url: event.url ?? state.agentBrowser[event.sessionId]?.url ?? "",
                at: Date.now(),
              },
            },
          }))
          get().ensureAgentBrowserTab(event.sessionId, event.url)
          break
        }
        case "resize":
          markActive()
          set({
            viewport:
              event.width && event.height
                ? { width: event.width, height: event.height, label: event.label }
                : null,
          })
          break
        case "fullscreen":
          markActive()
          set({ fullscreen: event.on })
          break
        case "motion":
          markActive()
          // Espelha o "ensure" do browser: o evento é do main (o agente
          // registrou a composição) e abre a aba — aqui o painel abre sozinho,
          // porque a composição é o que o usuário pediu para ver.
          get().openMotionTab({
            id: event.id,
            entry: event.entry,
            title: event.title,
            sessionId: event.sessionId,
            path: event.path,
          })
          break
        case "activity": {
          usePanelStore.getState().pushActivity(event.label)
          // Mantém o indicador da sessão fresco enquanto o agente mexe no browser.
          const activitySessionId = event.sessionId
          if (activitySessionId) {
            set((state) => ({
              agentBrowser: {
                ...state.agentBrowser,
                [activitySessionId]: {
                  url: state.agentBrowser[activitySessionId]?.url ?? "",
                  at: Date.now(),
                },
              },
            }))
          }
          break
        }
      }
    },

    openChatTab: (sessionId, title) =>
      set((state) => ({
        rightPanelOpen: true,
        pendingChatTab: state.pendingChatTab + 1,
        pendingChatTabSession: sessionId,
        pendingChatTabTitle: title,
      })),
    pendingChatTab: 0,
    pendingChatTabSession: undefined,
    pendingChatTabTitle: undefined,

    openDiff: (sessionId, messageId, title) =>
      set((state) => ({
        rightPanelOpen: true,
        pendingDiff: state.pendingDiff + 1,
        pendingDiffSessionId: sessionId,
        pendingDiffMessageId: messageId,
        pendingDiffEsteiraId: undefined,
        pendingDiffTaskId: undefined,
        pendingDiffTitle: title,
      })),

    openTaskDiff: (esteiraId, taskId, title) =>
      set((state) => ({
        rightPanelOpen: true,
        pendingDiff: state.pendingDiff + 1,
        pendingDiffSessionId: undefined,
        pendingDiffMessageId: undefined,
        pendingDiffEsteiraId: esteiraId,
        pendingDiffTaskId: taskId,
        pendingDiffTitle: title,
      })),
    pendingDiff: 0,
    pendingDiffSessionId: undefined,
    pendingDiffMessageId: undefined,
    pendingDiffTitle: undefined,

    openChatTabWithPendingInput: (sessionId, title, input) =>
      set((state) => ({
        rightPanelOpen: true,
        pendingInput: { sessionId, text: input },
        pendingChatTab: state.pendingChatTab + 1,
        pendingChatTabSession: sessionId,
        pendingChatTabTitle: title,
      })),
    pendingInput: null,
    setPendingInput: (val) => set({ pendingInput: val }),
  }
})
