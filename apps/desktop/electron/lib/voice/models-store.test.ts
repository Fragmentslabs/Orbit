import fsp from 'node:fs/promises'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * O layout de disco é o contrato entre este motor e o downloader do núcleo.
 * Se um dos dois mudar o caminho ou a regra de "instalado", o modelo baixa e
 * nunca aparece como pronto — ou pior, o motor acha que dá para transcrever com
 * o arquivo pela metade. Estes testes fixam o layout e as duas regras de
 * completude (tamanho exato do arquivo do whisper; pacote extraído + VAD).
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

describe('caminhos', () => {
  it('os modelos ficam em <userData>/voice/models (mesmo caminho do núcleo)', () => {
    expect(store.modelsDir()).toBe(modelsDir)
    expect(store.voiceDir()).toBe(path.join(userData, 'voice'))
  })

  it('a pasta de um modelo é <models>/<id>', () => {
    expect(store.modelDirFor('whisper-base')).toBe(path.join(modelsDir, 'whisper-base'))
  })

  it('o arquivo do whisper tem o nome do último segmento da URL', () => {
    const def = getSttModel('whisper-tiny')!
    expect(store.modelFileFor(def)).toBe(path.join(modelsDir, 'whisper-tiny', 'ggml-tiny.bin'))
  })

  it('o pacote do Parakeet fica na pasta dele com o nome da URL', () => {
    const def = getSttModel('parakeet-tdt-0.6b-v3')!
    expect(store.modelFileFor(def)).toBe(
      path.join(modelsDir, 'parakeet-tdt-0.6b-v3', `${PARAKEET_DIR}.tar.bz2`),
    )
  })

  it('o VAD Silero é compartilhado, fora das pastas de modelo', () => {
    expect(store.sileroVadPath()).toBe(path.join(modelsDir, 'silero_vad.onnx'))
  })

  it('o binário opcional do whisper-server fica em <voice>/whisper/', () => {
    expect(store.localWhisperServerPath()).toBe(
      path.join(userData, 'voice', 'whisper', process.platform === 'win32' ? 'whisper-server.exe' : 'whisper-server'),
    )
  })
})

describe('completude dos arquivos', () => {
  it('modelo ausente não está instalado', () => {
    expect(store.isWhisperModelInstalled('whisper-tiny')).toBe(false)
    expect(store.whisperInstalledIds()).toEqual([])
    expect(store.parakeetArchiveComplete()).toBe(false)
    expect(store.isParakeetReady()).toBe(false)
  })

  it('fileComplete exige o tamanho EXATO (truncado e sobrando não contam)', async () => {
    // Def sintético (bytes pequenos) para não criar um arquivo de 78 MB no /tmp:
    // a regra testada é a mesma que o downloader do núcleo usa.
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

  it('o Parakeet está pronto só com os quatro arquivos e o VAD inteiro', async () => {
    const files = store.parakeetFilesDir()
    await fsp.mkdir(files, { recursive: true })
    for (const name of ['encoder.int8.onnx', 'decoder.int8.onnx', 'joiner.int8.onnx', 'tokens.txt']) {
      await fsp.writeFile(path.join(files, name), Buffer.from('x'))
    }
    // Sem o VAD ainda não dá.
    expect(store.isParakeetReady()).toBe(false)

    await fsp.writeFile(store.sileroVadPath(), Buffer.alloc(643854))
    expect(store.isParakeetReady()).toBe(true)
  })
})

describe('extração do pacote do Parakeet', () => {
  it('sem o pacote baixado, a extração recusa com o motivo (não estoura no tar)', async () => {
    await expect(store.ensureParakeetExtracted()).rejects.toThrow(/ainda não foi baixado/)
  })

  it('quando já está pronto, resolve na hora sem tocar no pacote', async () => {
    const files = store.parakeetFilesDir()
    await fsp.mkdir(files, { recursive: true })
    for (const name of ['encoder.int8.onnx', 'decoder.int8.onnx', 'joiner.int8.onnx', 'tokens.txt']) {
      await fsp.writeFile(path.join(files, name), Buffer.from('x'))
    }
    await fsp.writeFile(store.sileroVadPath(), Buffer.alloc(643854))
    await expect(store.ensureParakeetExtracted()).resolves.toBeUndefined()
    // Não deixou lixo de extração para trás.
    expect(fs.existsSync(path.join(store.modelDirFor('parakeet-tdt-0.6b-v3'), '.extract'))).toBe(false)
  })
})
