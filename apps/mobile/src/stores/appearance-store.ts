import { create } from 'zustand'
import {
  personaVisibilityFrom,
  DEFAULT_PERSONA_VISIBILITY,
  type PersonaVisibility,
} from '@orbit/shared'
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
  /** Onde a persona aparece — ver PersonaVisibility no @orbit/shared. */
  personaVisibility: PersonaVisibility
  setPersonaVisibility: (visibility: PersonaVisibility) => Promise<void>
  /** Define tema e persiste (delega ao theme-store). */
  setTheme: (pref: ThemePreference) => void
}

export const useAppearanceStore = create<AppearanceState>((set) => ({
  modesInRow: DEFAULT_MODES_IN_ROW,
  personaVisibility: DEFAULT_PERSONA_VISIBILITY,

  setModesInRow: async (modes) => {
    set({ modesInRow: modes })
    await Storage.setItem(MODES_IN_ROW_KEY, JSON.stringify(modes))
  },

  setPersonaVisibility: async (visibility) => {
    set({ personaVisibility: visibility })
    await Storage.setItem(PERSONA_VISIBLE_KEY, visibility)
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

/** A chave é a mesma de quando isto era um booleano: personaVisibilityFrom
 *  entende o "false" de quem já tinha desligado e o mantém desligado. */
export async function hydratePersonaVisibility(): Promise<PersonaVisibility> {
  try {
    return personaVisibilityFrom(await Storage.getItem(PERSONA_VISIBLE_KEY))
  } catch {
    return DEFAULT_PERSONA_VISIBILITY
  }
}
