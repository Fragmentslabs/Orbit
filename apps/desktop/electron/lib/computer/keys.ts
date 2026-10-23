import { ComputerError } from './types'

/**
 * Teclas → códigos virtuais do macOS (layout físico ANSI) e flags de
 * modificador. Letras e símbolos seguem a posição física: num layout não-US,
 * "cmd+z" ainda é a tecla onde fica o Z no teclado americano — para TEXTO use
 * `type`, que manda Unicode e independe do layout.
 */

const KEY_CODES: Record<string, number> = {
  a: 0, s: 1, d: 2, f: 3, h: 4, g: 5, z: 6, x: 7, c: 8, v: 9, b: 11, q: 12, w: 13, e: 14, r: 15,
  y: 16, t: 17, '1': 18, '2': 19, '3': 20, '4': 21, '6': 22, '5': 23, '=': 24, '9': 25, '7': 26,
  '-': 27, '8': 28, '0': 29, ']': 30, o: 31, u: 32, '[': 33, i: 34, p: 35, l: 37, j: 38, "'": 39,
  k: 40, ';': 41, '\\': 42, ',': 43, '/': 44, n: 45, m: 46, '.': 47, '`': 50,
  return: 36, enter: 36, tab: 48, space: 49, backspace: 51, delete: 51, escape: 53, esc: 53,
  forwarddelete: 117, home: 115, end: 119, pageup: 116, pagedown: 121,
  left: 123, right: 124, down: 125, up: 126,
  f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97, f7: 98, f8: 100, f9: 101, f10: 109, f11: 103, f12: 111,
}

const MODIFIERS: Record<string, number> = {
  cmd: 0x100000, command: 0x100000, meta: 0x100000, super: 0x100000,
  shift: 0x20000,
  alt: 0x80000, option: 0x80000, opt: 0x80000,
  ctrl: 0x40000, control: 0x40000,
  fn: 0x800000,
}

/** Sinônimos que os modelos costumam mandar (formato xdotool / Anthropic). */
const ALIASES: Record<string, string> = {
  arrowleft: 'left', arrowright: 'right', arrowup: 'up', arrowdown: 'down',
  page_up: 'pageup', page_down: 'pagedown', kp_enter: 'return', bksp: 'backspace',
}

export interface KeyCombo {
  code: number
  flags: number
}

/** "cmd+shift+t", "return", "ctrl+a ctrl+c" (espaço separa uma sequência). */
export function parseKeys(input: string): KeyCombo[] {
  const chords = input.trim().split(/\s+/).filter(Boolean)
  if (!chords.length) throw new ComputerError('badRequest', 'Empty key.')
  return chords.map((chord) => {
    const parts = chord.toLowerCase().split('+').filter(Boolean)
    // "cmd++" (a tecla +) chega como ['cmd'] depois do filter — sem suporte: use shift+=.
    let flags = 0
    let code: number | null = null
    for (const raw of parts) {
      const part = ALIASES[raw] ?? raw
      if (part in MODIFIERS) {
        flags |= MODIFIERS[part]
        continue
      }
      if (code !== null) throw new ComputerError('badRequest', `"${chord}" has more than one non-modifier key.`)
      if (!(part in KEY_CODES)) {
        throw new ComputerError('badRequest', `Unknown key "${raw}". Use names like return, tab, escape, backspace, up, f5, or a single letter/digit; for text use action "type".`)
      }
      code = KEY_CODES[part]
    }
    if (code === null) throw new ComputerError('badRequest', `"${chord}" has only modifiers.`)
    return { code, flags }
  })
}
