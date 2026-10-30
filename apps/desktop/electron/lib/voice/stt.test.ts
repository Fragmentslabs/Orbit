import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { VoiceEngineId, VoiceModelInfo } from '@shared/voice'

/**
 * The facade is what the rest of the main consumes: the catalog that the core
 * manifest publishes, the state of the engines and the session lifecycle. Nothing here
 * touches a real model — what is closed is the CONTRACT (types, clear errors
 * and the "nonexistent session" paths, which the hot audio path uses).
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

  it('includes a model from each engine, and the Parakeet is the package', () => {
    const engines = new Set(stt.STT_MODELS.map((m) => m.engine))
    expect(engines).toEqual(new Set(['whisper', 'parakeet']))
    const parakeet = stt.STT_MODELS.find((m) => m.id === 'parakeet-tdt-0.6b-v3')!
    expect(parakeet.engine).toBe('parakeet')
    expect(parakeet.url.endsWith('.tar.bz2')).toBe(true)
  })

  it('the whisper models carry sha256 (the downloader checks at the end)', () => {
    for (const model of stt.STT_MODELS.filter((m) => m.engine === 'whisper')) {
      expect(model.sha256).toMatch(/^[0-9a-f]{64}$/)
    }
  })
})

describe('sttEngineStatus', () => {
  it('returns one state per engine, with a reason when it cannot run', async () => {
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

  it('refuses the Parakeet when there is no model on the machine (with the reason)', async () => {
    await expect(
      stt.startSttSession({ engine: 'parakeet', sampleRate: 16000, live: true }, partial),
    ).rejects.toThrow()
  })

  it('refuses whisper with no binary and/or no downloaded model', async () => {
    await expect(
      stt.startSttSession({ engine: 'whisper', modelId: 'whisper-base', sampleRate: 16000, live: true }, partial),
    ).rejects.toThrow(/whisper-server|não está baixado/)
  })

  it('refuses a model that does not belong to the engine', async () => {
    await expect(
      stt.startSttSession(
        { engine: 'whisper', modelId: 'parakeet-tdt-0.6b-v3', sampleRate: 16000, live: false },
        partial,
      ),
    ).rejects.toThrow(/does not have the model/)
  })
})

describe('sessions that do not exist', () => {
  it('pushSttAudio drops silently (the audio path must not throw)', () => {
    expect(() => stt.pushSttAudio('nao-existe', Buffer.alloc(3200))).not.toThrow()
  })

  it('stopSttSession on a session that does not exist is a clear error', async () => {
    await expect(stt.stopSttSession('nao-existe')).rejects.toThrow(/dictation session does not exist/)
  })

  it('cancelSttSession on a session that does not exist does nothing', async () => {
    await expect(stt.cancelSttSession('nao-existe')).resolves.toBeUndefined()
  })
})
