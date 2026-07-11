import { create } from "zustand"

/**
 * Estado global do painel direito + browser do agente:
 * - abertura automática quando o main pede (panel:event via tools panel_*)
 * - modo seleção: o usuário clica num elemento do webview e ele vira um
 *   badge/anexo no input do code mode (enviado junto com a mensagem)
 * - viewport (responsividade), tela cheia e feed de atividade do agente
 */

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
  | { type: "open"; url?: string }
  | { type: "resize"; width: number | null; height: number | null; label: string }
  | { type: "fullscreen"; on: boolean }
  | { type: "activity"; label: string }

interface PanelState {
  rightPanelOpen: boolean
  setRightPanelOpen: (open: boolean) => void
  /** Incrementa a cada pedido do agente — right-panel garante/ativa a aba Browser */
  browserRequestId: number
  /** URL do pedido mais recente (src inicial do webview) */
  browserUrl?: string
  selectMode: boolean
  setSelectMode: (value: boolean) => void
  selections: BrowserSelection[]
  addSelection: (selection: Omit<BrowserSelection, "id">) => void
  removeSelection: (id: string) => void
  clearSelections: () => void
  /** Viewport atual (null = preenche o painel) — controlado por agente e usuário */
  viewport: Viewport | null
  setViewport: (viewport: Viewport | null) => void
  /** Tela cheia do browser */
  fullscreen: boolean
  setFullscreen: (value: boolean) => void
  /** Browser sendo dirigido pelo agente agora (indicador visual) */
  agentActive: boolean
  /** Feed do que o agente está fazendo no browser (mais recente primeiro) */
  activity: ActivityEntry[]
  pushActivity: (label: string) => void
  /** Aplica um panel:event vindo do main */
  applyEvent: (event: PanelEvent) => void
  /** Abre uma aba de chat no painel direito (ex: "enviar para chat lateral") */
  openChatTab: (sessionId: string, title: string) => void
  /** Consumido pelo RightPanel; incrementa a cada solicitação */
  pendingChatTab: number
  pendingChatTabSession?: string
  pendingChatTabTitle?: string
}

// Auto-desliga o indicador "agente usando" após um período sem atividade
let activeTimer: ReturnType<typeof setTimeout> | null = null
const ACTIVE_TIMEOUT_MS = 6000

export const usePanelStore = create<PanelState>((set) => {
  const markActive = () => {
    if (activeTimer) clearTimeout(activeTimer)
    activeTimer = setTimeout(() => set({ agentActive: false }), ACTIVE_TIMEOUT_MS)
    set({ agentActive: true })
  }

  return {
    rightPanelOpen: false,
    setRightPanelOpen: (open) => set({ rightPanelOpen: open }),
    browserRequestId: 0,
    browserUrl: undefined,
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
          set((state) => ({
            rightPanelOpen: true,
            browserRequestId: state.browserRequestId + 1,
            browserUrl: event.url ?? state.browserUrl,
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
  }
})
