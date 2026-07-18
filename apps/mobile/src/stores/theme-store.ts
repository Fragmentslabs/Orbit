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
