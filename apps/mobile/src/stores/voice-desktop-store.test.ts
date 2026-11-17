import { describe, expect, it, vi } from 'vitest'

vi.mock('./connection-store', () => ({ useConnectionStore: { getState: () => ({ http: null }) } }))

import { callAllowedByDesktop } from './voice-desktop-store'

const base = { ready: true, engines: [] }

describe('callAllowedByDesktop', () => {
  it('needs the desktop call switch and its dictation on', () => {
    expect(callAllowedByDesktop({ ...base, call: { enabled: true, silenceMs: 1300 }, stt: { enabled: true } })).toBe(true)
    expect(callAllowedByDesktop({ ...base, call: { enabled: false, silenceMs: 1300 }, stt: { enabled: true } })).toBe(false)
    expect(callAllowedByDesktop({ ...base, call: { enabled: true, silenceMs: 1300 }, stt: { enabled: false } })).toBe(false)
  })

  it('keeps the call on a desktop that does not report it yet', () => {
    expect(callAllowedByDesktop(base)).toBe(true)
  })
})
