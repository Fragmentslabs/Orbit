import { beforeEach, describe, expect, it, vi } from 'vitest'
import { STT_MODEL_DEFS } from './catalog'

const maquina = { memGb: 16 }

vi.mock('node:os', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:os')>()
  const os = { ...real, arch: () => 'x64', totalmem: () => maquina.memGb * 1024 ** 3 }
  return { ...os, default: os }
})

// The real catalog, without the rest of the engine (which pulls in Electron).
vi.mock('./stt', () => ({
  STT_MODELS: STT_MODEL_DEFS.map((m) => ({ id: m.id, kind: 'stt', engine: m.engine, bytes: m.bytes })),
}))
vi.mock('./manifest', () => ({
  modelInfo: (id: string) => STT_MODEL_DEFS.find((m) => m.id === id) ?? null,
}))

const { detectHardware } = await import('./hardware')
const engineOf = (id: string) => STT_MODEL_DEFS.find((m) => m.id === id)?.engine

beforeEach(() => {
  maquina.memGb = 16
})

describe('detectHardware', () => {
  it('a 16 GB machine that the system reports as 15.3 GB still gets the Parakeet', () => {
    maquina.memGb = 15.3
    const info = detectHardware()
    expect(info.recommendedEngine).toBe('parakeet')
    expect(info.recommendedModel).toBe('parakeet-tdt-0.6b-v3')
  })

  it('with little RAM it recommends whisper WITH a whisper model — never the Parakeet', () => {
    maquina.memGb = 7.8
    const info = detectHardware()
    expect(info.recommendedEngine).toBe('whisper')
    expect(info.recommendedModel).toBe('whisper-small')
    expect(engineOf(info.recommendedModel)).toBe('whisper')
  })

  it('below 7 GB the recommended whisper is base', () => {
    maquina.memGb = 3.8
    const info = detectHardware()
    expect(info.recommendedModel).toBe('whisper-base')
  })

  it('the recommended model always belongs to the recommended engine', () => {
    for (const memGb of [2, 4, 6, 8, 12, 16, 32]) {
      maquina.memGb = memGb
      const info = detectHardware()
      expect(engineOf(info.recommendedModel)).toBe(info.recommendedEngine)
    }
  })
})
