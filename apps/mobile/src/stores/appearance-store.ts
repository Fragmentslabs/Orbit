import { create } from 'zustand'
import { Storage } from '~/lib/storage'
import { useThemeStore, type ThemePreference } from './theme-store'

const MODES_IN_ROW_KEY = 'orbit_modes_in_row'
const PERSONA_VISIBLE_KEY = 'orbit_persona_visible'

/** Modos que podem aparecer como toggles na barra inferior do input.
 *  "thinking" não está na lista: para modelos com reasoning ele é sempre
 *  ativo e o nível (ou o desligar, quando suportado) é controlado pelo
 *  seletor de reasoning — não é um modo. */
export const MODE_IDS = [
  'search',
  'browser',
  'plan',
  'simple',
  'brain',
  'subagents',
  'orchestra',
  'loop',
  'vision',
] as const
export type ModeId = (typeof MODE_IDS)[number]
/** "brain" fica fora da barra por padrão: o modo Memória também vem
 *  desativado por padrão nas preferências (model-mode-prefs) — só entra na
 *  barra se o usuário ativá-lo aqui ou no menu "+". */
export const DEFAULT_MODES_IN_ROW: ModeId[] = [
  'search',
  'browser',
  'plan',
  'simple',
  'subagents',
  'orchestra',
  'loop',
  'vision',
]

interface AppearanceState {
  /** Modos visíveis como toggles na barra inferior (o menu "+" mostra todos) */
  modesInRow: ModeId[]
  setModesInRow: (modes: ModeId[]) => Promise<void>
  personaVisible: boolean
  setPersonaVisible: (visible: boolean) => Promise<void>
  /** Define tema e persiste (delega ao theme-store). */
  setTheme: (pref: ThemePreference) => void
}

export const useAppearanceStore = create<AppearanceState>((set) => ({
  modesInRow: DEFAULT_MODES_IN_ROW,
  personaVisible: true,

  setModesInRow: async (modes) => {
    set({ modesInRow: modes })
    await Storage.setItem(MODES_IN_ROW_KEY, JSON.stringify(modes))
  },

  setPersonaVisible: async (visible) => {
    set({ personaVisible: visible })
    await Storage.setItem(PERSONA_VISIBLE_KEY, String(visible))
  },

  setTheme: (pref) => {
    useThemeStore.getState().setPreference(pref)
  },
}))

/** Carrega preferência persistida (chamar no root). */
export async function hydrateModesInRow(): Promise<ModeId[]> {
  try {
    const raw = await Storage.getItem(MODES_IN_ROW_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as unknown
      if (Array.isArray(parsed)) {
        const valid = parsed.filter((m): m is ModeId => MODE_IDS.includes(m as ModeId))
        if (valid.length > 0) return valid
      }
    }
  } catch { /* ignore */ }
  return DEFAULT_MODES_IN_ROW
}

export async function hydratePersonaVisible(): Promise<boolean> {
  try {
    const raw = await Storage.getItem(PERSONA_VISIBLE_KEY)
    if (raw === 'false') return false
  } catch { /* ignore */ }
  return true
}
