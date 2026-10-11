import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { VoiceEngineId, VoiceModelInfo } from '@shared/voice'

/**
 * A fachada é o que o resto do main consome: o catálogo que o manifesto do
 * núcleo publica, o estado dos motores e o ciclo de vida da sessão. Nada aqui
 * toca num modelo de verdade — o que se fecha é o CONTRATO (tipos, erros claros
 * e os caminhos de "sessão inexistente", que o caminho quente do áudio usa).
 */

const userData = path.join(os.tmpdir(), `orbit-voice-stt-${process.pid}`)

vi.mock('electron', () => ({
  app: { getPath: () => userData },
}))

const stt = await import('./stt')

beforeEach(async () => {
  await fsp.rm(userData, { recursive: true, force: true })
})

afterAll(async () => {
  await fsp.rm(userData, { recursive: true, force: true })
})

describe('STT_MODELS', () => {
  it('segue VoiceModelInfo: kind stt, motor conhecido, bytes/url/langs', () => {
    expect(stt.STT_MODELS.length).toBe(6)
    const ids = new Set<string>()
    for (const model of stt.STT_MODELS as VoiceModelInfo[]) {
      expect(model.kind).toBe('stt')
      expect(['parakeet', 'whisper']).toContain(model.engine)
      expect(model.bytes).toBeGreaterThan(0)
      expect(model.url.startsWith('https://')).toBe(true)
      expect(model.label.length).toBeGreaterThan(0)
      expect(model.langs).toContain('pt')
      expect(ids.has(model.id)).toBe(false)
      ids.add(model.id)
    }
  })

  it('inclui um modelo de cada motor, e o Parakeet é o pacote', () => {
    const engines = new Set(stt.STT_MODELS.map((m) => m.engine))
    expect(engines).toEqual(new Set(['whisper', 'parakeet']))
    const parakeet = stt.STT_MODELS.find((m) => m.id === 'parakeet-tdt-0.6b-v3')!
    expect(parakeet.engine).toBe('parakeet')
    expect(parakeet.url.endsWith('.tar.bz2')).toBe(true)
  })

  it('os modelos de whisper trazem sha256 (o downloader confere no fim)', () => {
    for (const model of stt.STT_MODELS.filter((m) => m.engine === 'whisper')) {
      expect(model.sha256).toMatch(/^[0-9a-f]{64}$/)
    }
  })
})

describe('sttEngineStatus', () => {
  it('devolve um estado por motor, com motivo quando não dá para rodar', async () => {
    const statuses = await stt.sttEngineStatus()
    expect(statuses).toHaveLength(2)
    expect(statuses.map((s) => s.engine).sort()).toEqual(['parakeet', 'whisper'])
    for (const status of statuses) {
      expect(typeof status.available).toBe('boolean')
      expect(typeof status.installed).toBe('boolean')
      if (!status.available) expect(status.reason?.length).toBeGreaterThan(0)
    }
  })
})

describe('startSttSession', () => {
  const partial = () => {}

  it('recusa um motor desconhecido', async () => {
    await expect(
      stt.startSttSession({ engine: 'apple' as unknown as VoiceEngineId, sampleRate: 16000, live: false }, partial),
    ).rejects.toThrow(/motor de ditado desconhecido/)
  })

  it('recusa o Parakeet quando não há modelo na máquina (com o motivo)', async () => {
    await expect(
      stt.startSttSession({ engine: 'parakeet', sampleRate: 16000, live: true }, partial),
    ).rejects.toThrow()
  })

  it('recusa o whisper sem binário e/ou sem modelo baixado', async () => {
    await expect(
      stt.startSttSession({ engine: 'whisper', modelId: 'whisper-base', sampleRate: 16000, live: true }, partial),
    ).rejects.toThrow(/whisper-server|não está baixado/)
  })

  it('recusa um modelo que não pertence ao motor', async () => {
    await expect(
      stt.startSttSession(
        { engine: 'whisper', modelId: 'parakeet-tdt-0.6b-v3', sampleRate: 16000, live: false },
        partial,
      ),
    ).rejects.toThrow(/não tem o modelo/)
  })
})

describe('sessões inexistentes', () => {
  it('pushSttAudio descarta em silêncio (o caminho do áudio não pode lançar)', () => {
    expect(() => stt.pushSttAudio('nao-existe', Buffer.alloc(3200))).not.toThrow()
  })

  it('stopSttSession de uma sessão que não existe é erro claro', async () => {
    await expect(stt.stopSttSession('nao-existe')).rejects.toThrow(/sessão de ditado inexistente/)
  })

  it('cancelSttSession de uma sessão que não existe não faz nada', async () => {
    await expect(stt.cancelSttSession('nao-existe')).resolves.toBeUndefined()
  })
})
