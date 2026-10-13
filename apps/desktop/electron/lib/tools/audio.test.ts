import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/orbit-audio-tool-test' },
  protocol: { handle: () => {}, registerSchemesAsPrivileged: () => {} },
  BrowserWindow: class {},
  ipcMain: { handle: () => {} },
  net: { fetch: () => {} },
  session: {},
}))

const { clock, timestampedText } = await import('./audio')

describe('transcrição com tempos', () => {
  it('relógio em m:ss, com hora só quando precisa', () => {
    expect(clock(0)).toBe('0:00')
    expect(clock(65_400)).toBe('1:05')
    expect(clock(3_725_000)).toBe('1:02:05')
    expect(clock(5_000, true)).toBe('0:00:05')
  })

  it('uma linha [tempo] por trecho; áudio de mais de uma hora mostra a hora em todas', () => {
    const segments = [
      { startMs: 0, endMs: 3000, text: 'Primeiro.' },
      { startMs: 4200, endMs: 8000, text: 'Segundo.' },
    ]
    expect(timestampedText(segments, 12_000)).toBe('[0:00] Primeiro.\n[0:04] Segundo.')
    expect(timestampedText(segments, 4_000_000)).toBe('[0:00:00] Primeiro.\n[0:00:04] Segundo.')
  })
})
