import { create } from "zustand"
import i18n from "@/src/i18n"

const LOCALE_KEY = "orbit_locale"

export type AppLocale = "pt-BR" | "en"
export const SUPPORTED_LOCALES: AppLocale[] = ["pt-BR", "en"]

export const LOCALE_LABELS: Record<AppLocale, string> = {
  "pt-BR": "Português",
  en: "English",
}

/** Nome do idioma em inglês, usado nos system prompts enviados ao modelo
 * (o modelo entende melhor "Portuguese"/"English" do que o código do locale). */
export const LOCALE_PROMPT_NAME: Record<AppLocale, string> = {
  "pt-BR": "Portuguese",
  en: "English",
}

function detectDefaultLocale(): AppLocale {
  const nav = typeof navigator !== "undefined" ? navigator.language : "pt-BR"
  return nav.toLowerCase().startsWith("pt") ? "pt-BR" : "en"
}

interface LocaleState {
  locale: AppLocale
  setLocale: (locale: AppLocale) => void
}

const initial = (localStorage.getItem(LOCALE_KEY) as AppLocale | null) ?? detectDefaultLocale()
void i18n.changeLanguage(initial)

export const useLocaleStore = create<LocaleState>((set) => ({
  locale: initial,
  setLocale: (locale) => {
    localStorage.setItem(LOCALE_KEY, locale)
    void i18n.changeLanguage(locale)
    set({ locale })
  },
}))
