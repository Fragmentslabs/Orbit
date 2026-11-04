import { describe, expect, it, vi } from 'vitest'

const saved: Array<{ buffer: Buffer; ext: string; meta: Record<string, unknown> }> = []
vi.mock('../audio-store', () => ({
  saveAudio: async (buffer: Buffer, ext: string, meta: Record<string, unknown>) => {
    saved.push({ buffer, ext, meta })
    return { id: 'aud_test123.wav', url: 'orbit-audio://aud_test123.wav', path: '/tmp/aud_test123.wav' }
  },
}))
vi.mock('../voice', () => ({ synthesizeToWav: vi.fn() }))
vi.mock('../app-settings', () => ({ getAppSettings: () => ({ voice: { stt: { enabled: false } } }) }))
vi.mock('../video/transcript', () => ({ transcribeVideo: vi.fn() }))

import { createSfxGenerateTool } from './audio'

type Out = { audioUrl?: string; ref?: string; durationMs?: number; title?: string; message: string }
async function run(input: Record<string, unknown>): Promise<Out> {
  const t = createSfxGenerateTool('s1', null) as unknown as { execute: (i: Record<string, unknown>, o: unknown) => Promise<Out> }
  return t.execute(input, { toolCallId: 't', messages: [] })
}

describe('sfx_generate', () => {
  it('stores a mono PCM16 wav at 44.1 kHz and returns the player url, the ref and the duration', async () => {
    saved.length = 0
    const out = await run({ kind: 'whoosh', duration: 0.5 })
    expect(out.audioUrl).toBe('orbit-audio://aud_test123.wav')
    expect(out.ref).toBe('aud_test123.wav')
    expect(out.durationMs).toBe(500)
    expect(out.title).toBe('whoosh')
    const wav = saved[0].buffer
    expect(saved[0].ext).toBe('wav')
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF')
    expect(wav.readUInt16LE(22)).toBe(1) // mono
    expect(wav.readUInt32LE(24)).toBe(44100)
    expect(wav.readUInt16LE(34)).toBe(16)
    expect(wav.readUInt32LE(40)).toBe(Math.round(0.5 * 44100) * 2)
    expect(out.message).toContain('motion_asset')
    expect(saved[0].meta).toMatchObject({ sessionId: 's1', source: 'chat', name: 'whoosh' })
  })

  it('uses the title as the media name when given', async () => {
    saved.length = 0
    const out = await run({ kind: 'bell', title: 'Ding de entrada' })
    expect(out.title).toBe('Ding de entrada')
    expect(saved[0].meta.name).toBe('Ding de entrada')
  })

  it('says why instead of throwing when the kind does not exist', async () => {
    saved.length = 0
    const out = await run({ kind: 'laser' })
    expect(out.message).toMatch(/unknown kind "laser"/)
    expect(out.audioUrl).toBeUndefined()
    expect(saved).toHaveLength(0)
  })
})
