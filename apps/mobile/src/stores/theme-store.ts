import { create } from 'zustand'
import { Storage } from '~/lib/storage'

const THEME_KEY = 'orbit_theme'

export type ThemePreference = 'light' | 'dark' | 'system'
export type ResolvedTheme = 'light' | 'dark'

interface ThemeState {
  preference: ThemePreference
  /** Resolved theme (system → real color of the OS). */
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
    // Conditional loading of an optional module: a static import does not
    // work here (the module may not exist at runtime — Expo Go, web,
    // build without the native part) and that is exactly why the require is
    // inside the try/if.
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
    // Persistence
    void Storage.setItem(THEME_KEY, p)
  },
}))

/** Async hydrate (call in the root layout before the first render). */
export async function hydrateThemePreference(): Promise<ThemePreference> {
  const raw = await Storage.getItem(THEME_KEY)
  if (raw === 'light' || raw === 'dark' || raw === 'system') return raw
  return 'dark'
}
