import { describe, expect, it } from 'vitest'
import { detectUserName } from '@shared/user-name'

/**
 * A regra é conservadora: só reconhece apresentação explícita. Um falso
 * positivo aparece na saudação e no system prompt, então o teste abaixo fixa
 * também os casos em que NÃO se deve adivinhar.
 */
describe('detectUserName', () => {
  it('reconhece as formas explícitas em português', () => {
    expect(detectUserName('meu nome é Desknik')).toBe('Desknik')
    expect(detectUserName('Meu nome é João Silva.')).toBe('João Silva')
    expect(detectUserName('pode me chamar de Ana')).toBe('Ana')
    expect(detectUserName('me chama de o João')).toBe('João')
    expect(detectUserName('meu nome eh Pedro')).toBe('Pedro')
  })

  it('reconhece as formas explícitas em inglês', () => {
    expect(detectUserName('my name is John')).toBe('John')
    expect(detectUserName('call me alex')).toBe('Alex')
  })

  it('capitaliza quando a pessoa escreveu tudo minúsculo', () => {
    expect(detectUserName('meu nome é ana clara')).toBe('Ana Clara')
  })

  it('preserva a grafia de quem já escreveu com maiúscula', () => {
    expect(detectUserName('meu nome é McDonald')).toBe('McDonald')
  })

  it('aceita hífen e apóstrofo', () => {
    expect(detectUserName('me chama de Ana-Clara')).toBe('Ana-Clara')
    expect(detectUserName("call me D'Ávila")).toBe("D'Ávila")
  })

  it('não inventa nome quando a frase não é uma apresentação', () => {
    expect(detectUserName('o que é um nome?')).toBeNull()
    expect(detectUserName('como eu troco meu nome no git?')).toBeNull()
    expect(detectUserName('meu nome é')).toBeNull()
    expect(detectUserName('meu nome é 123')).toBeNull()
    expect(detectUserName('')).toBeNull()
  })

  it('ignora mensagem gigante (código colado não é apresentação)', () => {
    expect(detectUserName(`meu nome é X ${'a'.repeat(3000)}`)).toBeNull()
  })
})
