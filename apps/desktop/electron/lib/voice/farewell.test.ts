import { describe, expect, it } from 'vitest'
import { isFarewellUtterance } from '@shared/voice'

/**
 * O fim da chamada não pode depender de o modelo escolher a tool `end_call`
 * (na prática ele escreve o "tchau" e não chama nada). Esta função é a rede
 * determinística — e por isso precisa ser estreita: só encerra quando a frase
 * inteira é um adeus.
 */
describe('isFarewellUtterance', () => {
  it.each([
    'tchau',
    'Tchau!',
    'tchau Orbit',
    'Tchau, obrigado!',
    'ok, tchau',
    'pode fechar, por favor',
    'Encerra.',
    'encerrar',
    'não era nada',
    'Era só isso.',
    'não era nada, tchau',
    'bye bye',
    'até logo',
    'até mais',
    'falou',
    'nada mais',
    'pode encerrar',
    'ciao',
  ])('encerra a chamada com %s', (text) => {
    expect(isFarewellUtterance(text)).toBe(true)
  })

  it.each([
    '',
    '   ',
    'como se diz tchau em japonês',
    'tchau, amanhã a gente se fala',
    'não sei',
    'pode fechar a porta',
    'obrigado',
    'até que enfim',
    'e aí',
    'tchau mundo',
    'me explica isso de novo',
  ])('segue a conversa com %s', (text) => {
    expect(isFarewellUtterance(text)).toBe(false)
  })
})
