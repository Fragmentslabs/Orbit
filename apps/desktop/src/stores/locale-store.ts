import { create } from "zustand"
import i18n from "@/src/i18n"
import { appApi } from "@/src/lib/ipc"

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

const initial: AppLocale = (localStorage.getItem(LOCALE_KEY) as AppLocale | null) ?? "en"
void i18n.changeLanguage(resolveActiveLocale(initial))

/**
 * Espelha o idioma efetivo no main. Ele não lê o localStorage do renderer, e o
 * scheduler de rotinas dispara agentes sem nenhum pedido vindo daqui — sem este
 * espelho, esses agentes responderiam no idioma do prompt (inglês).
 * Publicado no boot e a cada troca, então mudar o idioma vale para as rotinas
 * já existentes.
 */
function publicarIdioma(locale: AppLocale): void {
  void appApi
    .setLanguage(LOCALE_PROMPT_NAME[resolveActiveLocale(locale)])
    .catch(() => {
      // Espelho é best-effort: falhar aqui não pode quebrar a troca de idioma.
    })
}
publicarIdioma(initial)

export const useLocaleStore = create<LocaleState>((set) => ({
  locale: initial,
  activeLocale: resolveActiveLocale(initial),
  setLocale: (locale) => {
    localStorage.setItem(LOCALE_KEY, locale)
    void i18n.changeLanguage(resolveActiveLocale(locale))
    publicarIdioma(locale)
    set({ locale, activeLocale: resolveActiveLocale(locale) })
  },
}))
