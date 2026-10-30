import { create } from "zustand"
import i18n from "@/src/i18n"
import { appApi } from "@/src/lib/ipc"

const LOCALE_KEY = "orbit_locale"

/** Language options. "system" makes the app follow the operating system's language. */
export type AppLocale = "system" | "pt-BR" | "en"
export const SUPPORTED_LOCALES: AppLocale[] = ["system", "pt-BR", "en"]

export const LOCALE_LABELS: Record<Exclude<AppLocale, "system">, string> = {
  "pt-BR": "Português",
  en: "English",
}

/** Language name in English, used in the system prompts sent to the model
 * (the model understands "Portuguese"/"English" better than the locale code). */
export const LOCALE_PROMPT_NAME: Record<Exclude<AppLocale, "system">, string> = {
  "pt-BR": "Portuguese",
  en: "English",
}

function detectDefaultLocale(): Exclude<AppLocale, "system"> {
  const nav = typeof navigator !== "undefined" ? navigator.language : "pt-BR"
  return nav.toLowerCase().startsWith("pt") ? "pt-BR" : "en"
}

/** Resolves "system" to the system's effective language. */
export function resolveActiveLocale(pref: AppLocale): Exclude<AppLocale, "system"> {
  return pref === "system" ? detectDefaultLocale() : pref
}

interface LocaleState {
  /** Preference chosen by the user (it may be "system"). */
  locale: AppLocale
  /** Effective language (pt-BR/en) used in formatting and prompts. */
  activeLocale: Exclude<AppLocale, "system">
  setLocale: (locale: AppLocale) => void
}

const initial: AppLocale = (localStorage.getItem(LOCALE_KEY) as AppLocale | null) ?? "en"
void i18n.changeLanguage(resolveActiveLocale(initial))

/**
 * Mirrors the effective language into the main process. It does not read the
 * renderer's localStorage, and the routine scheduler fires agents without any
 * request coming from here — without this mirror, those agents would answer in
 * the prompt's language (English).
 * Published on boot and on every switch, so changing the language applies to
 * the routines that already exist.
 */
function publishLanguage(locale: AppLocale): void {
  void appApi
    .setLanguage(LOCALE_PROMPT_NAME[resolveActiveLocale(locale)])
    .catch(() => {
      // The mirror is best-effort: failing here cannot break the language switch.
    })
}
publishLanguage(initial)

export const useLocaleStore = create<LocaleState>((set) => ({
  locale: initial,
  activeLocale: resolveActiveLocale(initial),
  setLocale: (locale) => {
    localStorage.setItem(LOCALE_KEY, locale)
    void i18n.changeLanguage(resolveActiveLocale(locale))
    publishLanguage(locale)
    set({ locale, activeLocale: resolveActiveLocale(locale) })
  },
}))
