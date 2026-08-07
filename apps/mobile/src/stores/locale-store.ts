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

/** Nome do idioma em inglês, usado nos system prompts enviados ao modelo
 * (mesma convenção do desktop — companion/settingsStore repassa isso ao
 * enviar mensagens, quando essa integração existir no lado mobile). */
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

/** Hydrate async (chamar no root layout antes do primeiro render). */
export async function hydrateLocale(): Promise<AppLocale> {
  try {
    const raw = await Storage.getItem(LOCALE_KEY)
    if (raw === 'pt-BR' || raw === 'en') return raw
  } catch { /* ignore */ }
  return detectSystemLocale()
}
