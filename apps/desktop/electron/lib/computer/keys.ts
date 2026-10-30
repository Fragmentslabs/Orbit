import { ComputerError } from './types'

/**
 * Keys → OS virtual codes and modifier flags. On macOS, codes of the ANSI physical
 * layout: on a non-US layout, "cmd+z" is still the key where Z sits on the American
 * keyboard. On Windows, Virtual-Key codes (VK_*), which for letters and digits already
 * are the character itself. For TEXT use `type`, which sends Unicode and does not
 * depend on the layout.
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

/**
 * Windows Virtual-Key codes. Symbols use the VK_OEM_* of the American layout (the same
 * physical-position criterion as macOS).
 */
const WIN_KEY_CODES: Record<string, number> = {
  ...Object.fromEntries('abcdefghijklmnopqrstuvwxyz'.split('').map((c) => [c, c.toUpperCase().charCodeAt(0)])),
  ...Object.fromEntries('0123456789'.split('').map((c) => [c, c.charCodeAt(0)])),
  ';': 0xba, '=': 0xbb, ',': 0xbc, '-': 0xbd, '.': 0xbe, '/': 0xbf, '`': 0xc0, '[': 0xdb, '\\': 0xdc, ']': 0xdd, "'": 0xde,
  return: 0x0d, enter: 0x0d, tab: 0x09, space: 0x20, backspace: 0x08, delete: 0x2e, forwarddelete: 0x2e, escape: 0x1b, esc: 0x1b,
  home: 0x24, end: 0x23, pageup: 0x21, pagedown: 0x22, insert: 0x2d,
  left: 0x25, up: 0x26, right: 0x27, down: 0x28,
  ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`f${i + 1}`, 0x70 + i])),
}

/**
 * Windows host flags. "cmd" becomes Ctrl: the model sends "cmd+s" out of Mac habit,
 * and the equivalent shortcut on Windows is Ctrl+S. The Windows key has a name of its
 * own (win/super/meta).
 */
export const WIN_FLAGS = { shift: 1, ctrl: 2, alt: 4, win: 8 } as const

const WIN_MODIFIERS: Record<string, number> = {
  cmd: WIN_FLAGS.ctrl, command: WIN_FLAGS.ctrl, ctrl: WIN_FLAGS.ctrl, control: WIN_FLAGS.ctrl,
  shift: WIN_FLAGS.shift,
  alt: WIN_FLAGS.alt, option: WIN_FLAGS.alt, opt: WIN_FLAGS.alt,
  win: WIN_FLAGS.win, windows: WIN_FLAGS.win, super: WIN_FLAGS.win, meta: WIN_FLAGS.win,
}

/** Synonyms the models usually send (xdotool / Anthropic format). */
const ALIASES: Record<string, string> = {
  arrowleft: 'left', arrowright: 'right', arrowup: 'up', arrowdown: 'down',
  page_up: 'pageup', page_down: 'pagedown', kp_enter: 'return', bksp: 'backspace',
}

export interface KeyCombo {
  code: number
  flags: number
}

/** "cmd+shift+t", "return", "ctrl+a ctrl+c" (a space separates a sequence). */
export function parseKeys(input: string, platform: NodeJS.Platform = process.platform): KeyCombo[] {
  const codes = platform === 'win32' ? WIN_KEY_CODES : KEY_CODES
  const modifiers = platform === 'win32' ? WIN_MODIFIERS : MODIFIERS
  const chords = input.trim().split(/\s+/).filter(Boolean)
  if (!chords.length) throw new ComputerError('badRequest', 'Empty key.')
  return chords.map((chord) => {
    const parts = chord.toLowerCase().split('+').filter(Boolean)
    // "cmd++" (the + key) arrives as ['cmd'] after the filter — unsupported: use shift+=.
    let flags = 0
    let code: number | null = null
    for (const raw of parts) {
      const part = ALIASES[raw] ?? raw
      if (part in modifiers) {
        flags |= modifiers[part]
        continue
      }
      if (code !== null) throw new ComputerError('badRequest', `"${chord}" has more than one non-modifier key.`)
      if (!(part in codes)) {
        throw new ComputerError('badRequest', `Unknown key "${raw}". Use names like return, tab, escape, backspace, up, f5, or a single letter/digit; for text use action "type".`)
      }
      code = codes[part]
    }
    if (code === null) throw new ComputerError('badRequest', `"${chord}" has only modifiers.`)
    return { code, flags }
  })
}
