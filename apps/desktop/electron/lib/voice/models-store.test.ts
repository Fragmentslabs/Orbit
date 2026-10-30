import fsp from 'node:fs/promises'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The disk layout is the contract between this engine and the core downloader.
 * If either of them changes the path or the "installed" rule, the model downloads and
 * never shows up as ready — or worse, the engine thinks it can transcribe with
 * a half-written file. These tests pin the layout and the two completeness
 * rules (exact size of the whisper file; package extracted + VAD).
 */

const userData = path.join(os.tmpdir(), `orbit-voice-store-${process.pid}`)

vi.mock('electron', () => ({
  app: { getPath: (name: string) => (name === 'userData' ? userData : userData) },
}))

const store = await import('./models-store')
const { getSttModel, PARAKEET_DIR } = await import('./catalog')

const modelsDir = path.join(userData, 'voice', 'models')

beforeEach(async () => {
  await fsp.rm(userData, { recursive: true, force: true })
})

afterAll(async () => {
  await fsp.rm(userData, { recursive: true, force: true })
})

describe('paths', () => {
  it('the models live in <userData>/voice/models (same path as the core)', () => {
    expect(store.modelsDir()).toBe(modelsDir)
    expect(store.voiceDir()).toBe(path.join(userData, 'voice'))
  })

  it('the folder of a model is <models>/<id>', () => {
    expect(store.modelDirFor('whisper-base')).toBe(path.join(modelsDir, 'whisper-base'))
  })

  it('the whisper file takes the name of the last URL segment', () => {
    const def = getSttModel('whisper-tiny')!
    expect(store.modelFileFor(def)).toBe(path.join(modelsDir, 'whisper-tiny', 'ggml-tiny.bin'))
  })

  it('the Parakeet package lands in its own folder with the URL name', () => {
    const def = getSttModel('parakeet-tdt-0.6b-v3')!
    expect(store.modelFileFor(def)).toBe(
      path.join(modelsDir, 'parakeet-tdt-0.6b-v3', `${PARAKEET_DIR}.tar.bz2`),
    )
  })

  it('the Silero VAD is shared, outside the model folders', () => {
    expect(store.sileroVadPath()).toBe(path.join(modelsDir, 'silero_vad.onnx'))
  })

  it('the optional whisper-server binary lives in <voice>/whisper/', () => {
    expect(store.localWhisperServerPath()).toBe(
      path.join(userData, 'voice', 'whisper', process.platform === 'win32' ? 'whisper-server.exe' : 'whisper-server'),
    )
  })
})

describe('file completeness', () => {
  it('a missing model is not installed', () => {
    expect(store.isWhisperModelInstalled('whisper-tiny')).toBe(false)
    expect(store.whisperInstalledIds()).toEqual([])
    expect(store.parakeetArchiveComplete()).toBe(false)
    expect(store.isParakeetReady()).toBe(false)
  })

  it('fileComplete requires the EXACT size (truncated and oversized do not count)', async () => {
    // Synthetic def (small bytes) so as not to create a 78 MB file in /tmp:
    // the rule under test is the same one the core downloader uses.
    const def = { ...getSttModel('whisper-tiny')!, bytes: 10 }
    const file = store.modelFileFor(def)
    await fsp.mkdir(path.dirname(file), { recursive: true })

    await fsp.writeFile(file, Buffer.alloc(9))
    expect(store.fileComplete(def)).toBe(false)

    await fsp.writeFile(file, Buffer.alloc(10))
    expect(store.fileComplete(def)).toBe(true)

    await fsp.writeFile(file, Buffer.alloc(11))
    expect(store.fileComplete(def)).toBe(false)
  })

  it('the Parakeet is ready only with the four files and the whole VAD', async () => {
    const files = store.parakeetFilesDir()
    await fsp.mkdir(files, { recursive: true })
    for (const name of ['encoder.int8.onnx', 'decoder.int8.onnx', 'joiner.int8.onnx', 'tokens.txt']) {
      await fsp.writeFile(path.join(files, name), Buffer.from('x'))
    }
    // Without the VAD it is not possible yet.
    expect(store.isParakeetReady()).toBe(false)

    await fsp.writeFile(store.sileroVadPath(), Buffer.alloc(643854))
    expect(store.isParakeetReady()).toBe(true)
  })
})

describe('Parakeet package extraction', () => {
  it('with no downloaded package, extraction refuses with the reason (no tar blow-up)', async () => {
    await expect(store.ensureParakeetExtracted()).rejects.toThrow(/has not been downloaded/)
  })

  it('when it is already ready, it resolves at once without touching the package', async () => {
    const files = store.parakeetFilesDir()
    await fsp.mkdir(files, { recursive: true })
    for (const name of ['encoder.int8.onnx', 'decoder.int8.onnx', 'joiner.int8.onnx', 'tokens.txt']) {
      await fsp.writeFile(path.join(files, name), Buffer.from('x'))
    }
    await fsp.writeFile(store.sileroVadPath(), Buffer.alloc(643854))
    await expect(store.ensureParakeetExtracted()).resolves.toBeUndefined()
    // It left no extraction garbage behind.
    expect(fs.existsSync(path.join(store.modelDirFor('parakeet-tdt-0.6b-v3'), '.extract'))).toBe(false)
  })
})
