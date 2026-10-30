import { describe, expect, it } from 'vitest'
import { detectSpeechLang, pickSpeechLang } from './lang-detect'

describe('detectSpeechLang', () => {
  it.each([
    ['pt', 'Claro, eu posso te ajudar com isso agora. Você quer que eu gere o áudio em português?'],
    ['en', 'Sure, I can help you with that. Do you want me to generate the audio in English?'],
    ['es', 'Claro, puedo ayudarte con eso ahora. ¿Quieres que genere el audio en español?'],
    ['fr', "Bien sûr, je peux vous aider avec ça. Voulez-vous que je fasse l'audio en français ?"],
    ['de', 'Natürlich kann ich dir dabei helfen. Soll ich das Audio auf Deutsch erstellen?'],
    ['it', 'Certo, posso aiutarti con questo. Vuoi che generi l’audio in italiano?'],
    ['ru', 'Конечно, я могу помочь вам с этим.'],
    ['ja', 'もちろん、お手伝いできます。'],
    ['ko', '물론이죠, 도와드릴게요.'],
  ])('reconhece %s numa frase inteira', (lang, text) => {
    expect(detectSpeechLang(text)).toEqual({ lang, confident: true })
  })

  it('a short, ambiguous sentence is not confident', () => {
    expect(detectSpeechLang('Claro.')?.confident ?? false).toBe(false)
    expect(detectSpeechLang('Ok!')?.confident ?? false).toBe(false)
  })
})

describe('pickSpeechLang', () => {
  it('a fixed language is forced, whatever the text', () => {
    expect(pickSpeechLang('en', 'Olá, tudo bem com você?', 'pt')).toBe('en')
  })

  it('in auto mode a Portuguese reply comes out in Portuguese even with the UI in English', () => {
    expect(pickSpeechLang('auto', 'Claro, eu posso te ajudar com isso agora.', 'en')).toBe('pt')
  })

  it('the ambiguous sentence inherits the language already decided in the same utterance', () => {
    const memory: { lang?: string } = {}
    expect(pickSpeechLang('auto', 'Sure, I can help you with that right now.', 'pt', memory)).toBe('en')
    expect(pickSpeechLang('auto', 'Ok.', 'pt', memory)).toBe('en')
  })

  it('with no evidence and no memory, the fallback applies', () => {
    expect(pickSpeechLang('auto', 'Ok.', 'pt')).toBe('pt')
    expect(pickSpeechLang(undefined, '12345', 'en')).toBe('en')
  })
})
