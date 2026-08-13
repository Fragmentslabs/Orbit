import { create } from "zustand"

export type TabType = "chat" | "terminal" | "folders" | "browser" | "diff" | "media"

export interface PanelTab {
  id: string
  type: TabType
  title: string
  sessionId?: string
  messageId?: string
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
  | { type: "open"; url?: string; sessionId: string }
  | { type: "resize"; width: number | null; height: number | null; label: string }
  | { type: "fullscreen"; on: boolean }
  | { type: "activity"; label: string }

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

  browserRequestId: number
  browserUrl?: string
  /** Sessão de chat que originou o pedido de abrir o browser do painel. */
  browserRequestSessionId?: string
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
  pendingDiff: number
  pendingDiffSessionId?: string
  pendingDiffMessageId?: string
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

    browserRequestId: 0,
    browserUrl: undefined,
    browserRequestSessionId: undefined,

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
        case "open":
          markActive()
          // Não força rightPanelOpen aqui: quem decide se abre a UI é o
          // RightPanel, que sabe se essa sessão é a que está ativa agora —
          // senão o painel "vaza" pra qualquer chat que o usuário abrir depois.
          set((state) => ({
            browserRequestId: state.browserRequestId + 1,
            browserUrl: event.url ?? state.browserUrl,
            browserRequestSessionId: event.sessionId,
          }))
          break
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
        case "activity":
          usePanelStore.getState().pushActivity(event.label)
          break
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
