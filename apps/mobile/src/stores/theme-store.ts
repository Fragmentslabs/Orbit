import { create } from 'zustand'
import { Storage } from '~/lib/storage'

const THEME_KEY = 'orbit_theme'

export type ThemePreference = 'light' | 'dark' | 'system'
export type ResolvedTheme = 'light' | 'dark'

interface ThemeState {
  preference: ThemePreference
  /** Tema resolvido (system → cor real do SO). */
  resolved: ResolvedTheme
  setPreference: (p: ThemePreference, systemIsDark?: boolean) => void
}

function resolveSystem(systemIsDark: boolean | undefined): ResolvedTheme {
  return systemIsDark ? 'dark' : 'light'
}

function resolvePreference(p: ThemePreference, systemIsDark?: boolean): ResolvedTheme {
  return p === 'system' ? resolveSystem(systemIsDark) : p
}

function getSystemColorSchemeSync(): ResolvedTheme {
  try {
    // Carregamento condicional de módulo opcional: import estático não
    // serve aqui (o módulo pode não existir no runtime — Expo Go, web,
    // build sem o nativo) e é justamente por isso que o require está
    // dentro do try/if.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Appearance } = require('react-native')
    return Appearance.getColorScheme() ?? 'dark'
  } catch {
    return 'dark'
  }
}

export const useThemeStore = create<ThemeState>((set) => ({
  preference: 'dark',
  resolved: getSystemColorSchemeSync(),

  setPreference: (p, systemIsDark) => {
    const resolved = resolvePreference(p, systemIsDark)
    set({ preference: p, resolved })
    // Persistência
    void Storage.setItem(THEME_KEY, p)
  },
}))

/** Hydrate async (chamar no root layout antes do primeiro render). */
export async function hydrateThemePreference(): Promise<ThemePreference> {
  const raw = await Storage.getItem(THEME_KEY)
  if (raw === 'light' || raw === 'dark' || raw === 'system') return raw
  return 'dark'
}
