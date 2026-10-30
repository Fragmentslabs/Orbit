import { describe, expect, it } from 'vitest'

import {
  fileNameOf,
  getSttModel,
  modelsForEngine,
  PARAKEET_DIR,
  SILERO_VAD_BYTES,
  STT_MODEL_DEFS,
} from './catalog'

/**
 * The catalog is not decoration: the core downloader derives the file NAME
 * from the last segment of the URL and only considers the model installed when the size
 * matches EXACTLY. A repeated id, a URL without an extension or a rounded `bytes`
 * break the download in a silent way (it downloads and never becomes "installed").
 * These tests close those invariants.
 */

describe('STT_MODEL_DEFS', () => {
  it('has the combined models: whisper tiny/base/small/medium/large-v3-turbo + parakeet', () => {
    expect(STT_MODEL_DEFS.map((m) => m.id)).toEqual([
      'whisper-tiny',
      'whisper-base',
      'whisper-small',
      'whisper-medium',
      'whisper-large-v3-turbo',
      'parakeet-tdt-0.6b-v3',
    ])
  })

  it('ids are unique and not empty', () => {
    const ids = STT_MODEL_DEFS.map((m) => m.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(id.length).toBeGreaterThan(0)
  })

  it('the URL ends in a file name with an extension (the downloader uses that name)', () => {
    for (const def of STT_MODEL_DEFS) {
      const name = fileNameOf(def)
      expect(name).toMatch(/\.(bin|tar\.bz2)$/)
      expect(def.url.endsWith(name)).toBe(true)
    }
  })

  it('bytes is a positive number (the exact file size at the origin)', () => {
    for (const def of STT_MODEL_DEFS) {
      expect(Number.isInteger(def.bytes)).toBe(true)
      expect(def.bytes).toBeGreaterThan(0)
    }
  })

  it('every model declares languages, with pt among them', () => {
    for (const def of STT_MODEL_DEFS) {
      expect(def.langs.length).toBeGreaterThan(0)
      expect(def.langs).toContain('pt')
    }
  })

  it('classifies each model into a known engine', () => {
    for (const def of STT_MODEL_DEFS) {
      expect(['whisper', 'parakeet']).toContain(def.engine)
    }
    expect(modelsForEngine('whisper')).toHaveLength(5)
    expect(modelsForEngine('parakeet')).toHaveLength(1)
  })

  it('the Parakeet is the only package (the rest are single whisper.cpp files)', () => {
    const archives = STT_MODEL_DEFS.filter((m) => m.archive)
    expect(archives.map((m) => m.id)).toEqual(['parakeet-tdt-0.6b-v3'])
    expect(archives[0].url).toContain(PARAKEET_DIR)
  })

  it('the whisper models come from ggerganov/whisper.cpp and cite sha256', () => {
    for (const def of modelsForEngine('whisper')) {
      expect(def.url.startsWith('https://huggingface.co/ggerganov/whisper.cpp/resolve/main/')).toBe(true)
      expect(def.sha256).toMatch(/^[0-9a-f]{64}$/)
    }
  })
})

describe('getSttModel', () => {
  it('finds by id and returns null for unknown/empty', () => {
    expect(getSttModel('whisper-base')?.bytes).toBe(147951465)
    expect(getSttModel('nao-existe')).toBeNull()
    expect(getSttModel(null)).toBeNull()
    expect(getSttModel('')).toBeNull()
  })
})

describe('constantes do Parakeet', () => {
  it('the Silero VAD has a declared size (checked on disk)', () => {
    expect(SILERO_VAD_BYTES).toBe(643854)
  })
})
