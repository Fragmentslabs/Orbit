import { beforeEach, describe, expect, it, vi } from 'vitest'
import { STT_MODEL_DEFS } from './catalog'

const maquina = { memGb: 16 }

vi.mock('node:os', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:os')>()
  const os = { ...real, arch: () => 'x64', totalmem: () => maquina.memGb * 1024 ** 3 }
  return { ...os, default: os }
})

// O catálogo de verdade, sem o resto do motor (que puxa o Electron).
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
  it('uma máquina de 16 GB que o sistema reporta como 15,3 GB ainda leva o Parakeet', () => {
    maquina.memGb = 15.3
    const info = detectHardware()
    expect(info.recommendedEngine).toBe('parakeet')
    expect(info.recommendedModel).toBe('parakeet-tdt-0.6b-v3')
  })

  it('com pouca RAM recomenda whisper COM um modelo de whisper — nunca o Parakeet', () => {
    maquina.memGb = 7.8
    const info = detectHardware()
    expect(info.recommendedEngine).toBe('whisper')
    expect(info.recommendedModel).toBe('whisper-small')
    expect(engineOf(info.recommendedModel)).toBe('whisper')
  })

  it('abaixo de 7 GB o whisper recomendado é o base', () => {
    maquina.memGb = 3.8
    const info = detectHardware()
    expect(info.recommendedModel).toBe('whisper-base')
  })

  it('o modelo recomendado é sempre do motor recomendado', () => {
    for (const memGb of [2, 4, 6, 8, 12, 16, 32]) {
      maquina.memGb = memGb
      const info = detectHardware()
      expect(engineOf(info.recommendedModel)).toBe(info.recommendedEngine)
    }
  })
})
