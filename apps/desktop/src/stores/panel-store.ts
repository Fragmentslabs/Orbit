import { create } from "zustand"

export type TabType = "chat" | "terminal" | "folders" | "browser" | "diff" | "media"

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
}

export interface BrowserSelection {
  id: string
  tag: string
  selector: string
  text: string
  html: string
  url: string
}

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

  /** Tabs por sessão de chat */
  tabsBySession: Record<string, PanelTab[]>
  activeTabBySession: Record<string, string | null>
  addTab: (sessionId: string, tab: PanelTab) => void
  removeTab: (sessionId: string, tabId: string) => void
  setActiveTab: (sessionId: string, tabId: string | null) => void
  setTabsForSession: (sessionId: string, tabs: PanelTab[], activeId: string | null) => void
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

    tabsBySession: {},
    activeTabBySession: {},

    addTab: (sessionId, tab) =>
      set((state) => ({
        tabsBySession: {
          ...state.tabsBySession,
          [sessionId]: [...(state.tabsBySession[sessionId] ?? []), tab],
        },
      })),

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
      set({ rightPanelOpen: true })
    },

    // Cada clique em link no terminal cria uma aba própria (semântica de
    // "nova aba", como um browser de verdade) — não reusa a aba do agente.
    openTerminalLink: (sessionId, url) =>
      set((state) => {
        const id = `browser-${nextTabId()}`
        const tabs = state.tabsBySession[sessionId] ?? []
        return {
          rightPanelOpen: true,
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
