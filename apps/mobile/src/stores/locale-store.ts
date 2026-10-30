import { create } from 'zustand'
import { Storage } from '~/lib/storage'
import i18n, { detectSystemLocale } from '~/i18n'

const LOCALE_KEY = 'orbit_locale'

export type AppLocale = 'pt-BR' | 'en'
export const SUPPORTED_LOCALES: AppLocale[] = ['pt-BR', 'en']

export const LOCALE_LABELS: Record<AppLocale, string> = {
  'pt-BR': 'Português',
  en: 'English',
}

/** Language name in English, used in the system prompts sent to the model
 * (same convention as the desktop — companion/settingsStore passes this on when
 * sending messages, once that integration exists on the mobile side). */
export const LOCALE_PROMPT_NAME: Record<AppLocale, string> = {
  'pt-BR': 'Portuguese',
  en: 'English',
}

interface LocaleState {
  locale: AppLocale
  setLocale: (locale: AppLocale) => void
}

export const useLocaleStore = create<LocaleState>((set) => ({
  locale: detectSystemLocale(),
  setLocale: (locale) => {
    set({ locale })
    void i18n.changeLanguage(locale)
    void Storage.setItem(LOCALE_KEY, locale)
  },
}))

/** Async hydrate (call in the root layout before the first render). */
export async function hydrateLocale(): Promise<AppLocale> {
  try {
    const raw = await Storage.getItem(LOCALE_KEY)
    if (raw === 'pt-BR' || raw === 'en') return raw
  } catch { /* ignore */ }
  return detectSystemLocale()
}
