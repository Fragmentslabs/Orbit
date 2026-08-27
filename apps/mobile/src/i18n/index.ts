import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import { getLocales } from 'expo-localization'
import ptBR from './locales/pt-BR.json'
import en from './locales/en.json'

/** Idioma do dispositivo: pt-BR quando o celular está em português, inglês caso contrário. */
export function detectSystemLocale(): 'pt-BR' | 'en' {
  try {
    if (getLocales()[0]?.languageCode?.toLowerCase() === 'pt') return 'pt-BR'
  } catch {
    /* ignore */
  }
  return 'en'
}

const systemLocale = detectSystemLocale()

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
