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

// `i18n.use()` é a API documentada do i18next; a coincidência com o export
// nomeado `use` do módulo é da própria lib, não um import trocado.
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
