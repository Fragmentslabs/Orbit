import { create } from "zustand"

const MODES_IN_ROW_KEY = "orbit_modes_in_row"
const MODE_LABEL_STYLE_KEY = "orbit_mode_label_style"
const PERSONA_VISIBLE_KEY = "orbit_persona_visible"
const TAB_CLOSE_POSITION_KEY = "orbit_tab_close_position"
const DEFAULT_TAB_CLOSE_POSITION: TabClosePosition = "left"

export type ModeLabelStyle = "label" | "icon"

/** Modos que podem aparecer como toggles na barra inferior do input.
 *  "thinking" não está na lista: para modelos com reasoning ele é sempre
 *  ativo e o nível (ou o desligar, quando suportado) é controlado pelo
 *  seletor de reasoning — não é um modo. */
export const MODE_IDS = [
  "search",
  "browser",
  "plan",
  "simple",
  "brain",
  "subagents",
  "orchestra",
  "loop",
  "vision",
] as const
export type ModeId = (typeof MODE_IDS)[number]
/** "brain" fica fora da barra por padrão: o modo Memória também vem
 *  desativado por padrão nas preferências (model-mode-prefs) — só entra na
 *  barra se o usuário ativá-lo aqui ou no menu "+". */
export const DEFAULT_MODES_IN_ROW: ModeId[] = [
  "search",
  "browser",
  "plan",
  "simple",
  "subagents",
  "orchestra",
  "loop",
  "vision",
]

export type TabClosePosition = "left" | "right"

interface AppearanceState {
  /** Modos visíveis como toggles na barra inferior (o menu "+" mostra todos) */
  modesInRow: ModeId[]
  setModesInRow: (modes: ModeId[]) => void
  /** Ícone + texto ou somente ícone na barra inferior */
  modeLabelStyle: ModeLabelStyle
  setModeLabelStyle: (style: ModeLabelStyle) => void
  personaVisible: boolean
  setPersonaVisible: (visible: boolean) => void
  tabClosePosition: TabClosePosition
  setTabClosePosition: (position: TabClosePosition) => void
}

function loadModesInRow(): ModeId[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(MODES_IN_ROW_KEY) ?? "null")
    if (Array.isArray(raw)) {
      const valid = raw.filter((m): m is ModeId => MODE_IDS.includes(m as ModeId))
      if (valid.length > 0) return valid
    }
  } catch {
    /* localStorage corrompido → default */
  }
  return DEFAULT_MODES_IN_ROW
}

export const useAppearanceStore = create<AppearanceState>((set) => ({
  modesInRow: loadModesInRow(),
  setModesInRow: (modes) => {
    localStorage.setItem(MODES_IN_ROW_KEY, JSON.stringify(modes))
    set({ modesInRow: modes })
  },
  modeLabelStyle: (localStorage.getItem(MODE_LABEL_STYLE_KEY) as ModeLabelStyle) ?? "icon",
  setModeLabelStyle: (style) => {
    localStorage.setItem(MODE_LABEL_STYLE_KEY, style)
    set({ modeLabelStyle: style })
  },
  personaVisible: localStorage.getItem(PERSONA_VISIBLE_KEY) !== "false",
  setPersonaVisible: (visible) => {
    localStorage.setItem(PERSONA_VISIBLE_KEY, String(visible))
    set({ personaVisible: visible })
  },
  tabClosePosition: (localStorage.getItem(TAB_CLOSE_POSITION_KEY) as TabClosePosition) ?? DEFAULT_TAB_CLOSE_POSITION,
  setTabClosePosition: (position) => {
    localStorage.setItem(TAB_CLOSE_POSITION_KEY, position)
    set({ tabClosePosition: position })
  },
}))
