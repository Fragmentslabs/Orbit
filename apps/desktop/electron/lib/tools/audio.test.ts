import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/orbit-audio-tool-test' },
  protocol: { handle: () => {}, registerSchemesAsPrivileged: () => {} },
  BrowserWindow: class {},
  ipcMain: { handle: () => {} },
  net: { fetch: () => {} },
  session: {},
}))

const { clock } = await import('./audio')

describe('duration clock', () => {
  it('clock in m:ss, with hours only when needed', () => {
    expect(clock(0)).toBe('0:00')
    expect(clock(65_400)).toBe('1:05')
    expect(clock(3_725_000)).toBe('1:02:05')
    expect(clock(5_000, true)).toBe('0:00:05')
  })
})
