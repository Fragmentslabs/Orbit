import { describe, expect, it } from 'vitest'
import { parseKeys } from './keys'

const CMD = 0x100000
const SHIFT = 0x20000
const CTRL = 0x40000

describe('parseKeys', () => {
  it('shortcut with modifiers', () => {
    expect(parseKeys('cmd+shift+t')).toEqual([{ code: 17, flags: CMD | SHIFT }])
    expect(parseKeys('Cmd+S')).toEqual([{ code: 1, flags: CMD }])
  })

  it('named keys and synonyms', () => {
    expect(parseKeys('return')).toEqual([{ code: 36, flags: 0 }])
    expect(parseKeys('ArrowDown')).toEqual([{ code: 125, flags: 0 }])
    expect(parseKeys('esc')).toEqual([{ code: 53, flags: 0 }])
  })

  it('a space separates a sequence', () => {
    expect(parseKeys('ctrl+a ctrl+c')).toEqual([
      { code: 0, flags: CTRL },
      { code: 8, flags: CTRL },
    ])
  })

  it('refuses what is not a key — text goes through type', () => {
    expect(() => parseKeys('olá')).toThrow(/Unknown key/)
    expect(() => parseKeys('cmd+shift')).toThrow(/only modifiers/)
    expect(() => parseKeys('a+b')).toThrow(/more than one/)
    expect(() => parseKeys('  ')).toThrow(/Empty/)
  })
})

describe('parseKeys no Windows', () => {
  it('VK e flags do host; cmd vira Ctrl', () => {
    expect(parseKeys('ctrl+s', 'win32')).toEqual([{ code: 0x53, flags: 2 }])
    expect(parseKeys('cmd+shift+t', 'win32')).toEqual([{ code: 0x54, flags: 2 | 1 }])
    expect(parseKeys('alt+f4', 'win32')).toEqual([{ code: 0x73, flags: 4 }])
    expect(parseKeys('win+d', 'win32')).toEqual([{ code: 0x44, flags: 8 }])
  })

  it('named keys, digits and symbols', () => {
    expect(parseKeys('return tab ArrowDown pagedown', 'win32').map((c) => c.code)).toEqual([0x0d, 0x09, 0x28, 0x22])
    expect(parseKeys('ctrl+0', 'win32')).toEqual([{ code: 0x30, flags: 2 }])
    expect(parseKeys('ctrl+.', 'win32')).toEqual([{ code: 0xbe, flags: 2 }])
    expect(parseKeys('delete', 'win32')).toEqual([{ code: 0x2e, flags: 0 }])
  })

  it('macOS keeps its own codes', () => {
    expect(parseKeys('cmd+s', 'darwin')).toEqual([{ code: 1, flags: 0x100000 }])
  })
})
