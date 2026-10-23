import { describe, expect, it } from 'vitest'
import { parseKeys } from './keys'

const CMD = 0x100000
const SHIFT = 0x20000
const CTRL = 0x40000

describe('parseKeys', () => {
  it('atalho com modificadores', () => {
    expect(parseKeys('cmd+shift+t')).toEqual([{ code: 17, flags: CMD | SHIFT }])
    expect(parseKeys('Cmd+S')).toEqual([{ code: 1, flags: CMD }])
  })

  it('teclas nomeadas e sinônimos', () => {
    expect(parseKeys('return')).toEqual([{ code: 36, flags: 0 }])
    expect(parseKeys('ArrowDown')).toEqual([{ code: 125, flags: 0 }])
    expect(parseKeys('esc')).toEqual([{ code: 53, flags: 0 }])
  })

  it('espaço separa uma sequência', () => {
    expect(parseKeys('ctrl+a ctrl+c')).toEqual([
      { code: 0, flags: CTRL },
      { code: 8, flags: CTRL },
    ])
  })

  it('recusa o que não é tecla — texto vai por type', () => {
    expect(() => parseKeys('olá')).toThrow(/Unknown key/)
    expect(() => parseKeys('cmd+shift')).toThrow(/only modifiers/)
    expect(() => parseKeys('a+b')).toThrow(/more than one/)
    expect(() => parseKeys('  ')).toThrow(/Empty/)
  })
})
