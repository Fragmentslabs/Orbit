import { create } from "zustand"

/**
 * Estado global do painel direito + browser do agente:
 * - abertura automática quando o main pede (panel:event via tools panel_*)
 * - modo seleção: o usuário clica num elemento do webview e ele vira um
 *   badge/anexo no input do code mode (enviado junto com a mensagem)
 */

export interface BrowserSelection {
  id: string
  tag: string
  selector: string
  text: string
  html: string
  url: string
}

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
  /** Aplica um panel:event vindo do main */
  applyEvent: (event: { type: "open"; url?: string }) => void
  /** Abre uma aba de chat no painel direito (ex: "enviar para chat lateral") */
  openChatTab: (sessionId: string, title: string) => void
  /** Consumido pelo RightPanel; incrementa a cada solicitação */
  pendingChatTab: number
  pendingChatTabSession?: string
  pendingChatTabTitle?: string
}

export const usePanelStore = create<PanelState>((set) => ({
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
  applyEvent: (event) => {
    if (event.type === "open") {
      set((state) => ({
        rightPanelOpen: true,
        browserRequestId: state.browserRequestId + 1,
        browserUrl: event.url ?? state.browserUrl,
      }))
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
}))
