import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import { getLocales } from 'expo-localization'
import ptBR from './locales/pt-BR.json'
import en from './locales/en.json'

/** Device language: pt-BR when the phone is in Portuguese, English otherwise. */
export function detectSystemLocale(): 'pt-BR' | 'en' {
  try {
    if (getLocales()[0]?.languageCode?.toLowerCase() === 'pt') return 'pt-BR'
  } catch {
    /* ignore */
  }
  return 'en'
}

const systemLocale = detectSystemLocale()

// `i18n.use()` is the documented i18next API; the coincidence with the named
// export `use` of the module belongs to the lib itself, not a swapped import.
// eslint-disable-next-line import/no-named-as-default-member
void i18n.use(initReactI18next).init({
  resources: {
    'pt-BR': { translation: ptBR },
    en: { translation: en },
  },
  lng: systemLocale,
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
})

export default i18n
