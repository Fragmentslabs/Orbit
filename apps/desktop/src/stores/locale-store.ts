import { create } from "zustand"
import i18n from "@/src/i18n"

const LOCALE_KEY = "orbit_locale"

/** Opções de idioma. "system" faz o app seguir o idioma do sistema operacional. */
export type AppLocale = "system" | "pt-BR" | "en"
export const SUPPORTED_LOCALES: AppLocale[] = ["system", "pt-BR", "en"]

export const LOCALE_LABELS: Record<Exclude<AppLocale, "system">, string> = {
  "pt-BR": "Português",
  en: "English",
}

/** Nome do idioma em inglês, usado nos system prompts enviados ao modelo
 * (o modelo entende melhor "Portuguese"/"English" do que o código do locale). */
export const LOCALE_PROMPT_NAME: Record<Exclude<AppLocale, "system">, string> = {
  "pt-BR": "Portuguese",
  en: "English",
}

function detectDefaultLocale(): Exclude<AppLocale, "system"> {
  const nav = typeof navigator !== "undefined" ? navigator.language : "pt-BR"
  return nav.toLowerCase().startsWith("pt") ? "pt-BR" : "en"
}

/** Resolve "system" para o idioma efetivo do sistema. */
export function resolveActiveLocale(pref: AppLocale): Exclude<AppLocale, "system"> {
  return pref === "system" ? detectDefaultLocale() : pref
}

interface LocaleState {
  /** Preferência escolhida pelo usuário (pode ser "system"). */
  locale: AppLocale
  /** Idioma efetivo (pt-BR/en) usado em formatação e prompts. */
  activeLocale: Exclude<AppLocale, "system">
  setLocale: (locale: AppLocale) => void
}

const initial: AppLocale = (localStorage.getItem(LOCALE_KEY) as AppLocale | null) ?? "system"
void i18n.changeLanguage(resolveActiveLocale(initial))

export const useLocaleStore = create<LocaleState>((set) => ({
  locale: initial,
  activeLocale: resolveActiveLocale(initial),
  setLocale: (locale) => {
    localStorage.setItem(LOCALE_KEY, locale)
    void i18n.changeLanguage(resolveActiveLocale(locale))
    set({ locale, activeLocale: resolveActiveLocale(locale) })
  },
}))
