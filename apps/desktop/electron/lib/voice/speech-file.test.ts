import fs from 'node:fs/promises'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * A fala sob demanda do app companion: texto entra, WAV sai.
 *
 * O que quebra calado aqui: o ID (precisa caber em SAFE_AUDIO_ID, senão o
 * arquivo existe e o celular toma 404), o cache (sem ele cada toque sintetiza
 * de novo — e o modelo de voz leva segundos) e a poda (sem ela a pasta de áudio
 * cresce para sempre, porque nada mais apaga estes arquivos: eles não estão no
 * índice de mídia).
 */

const USER_DATA = vi.hoisted(() => `/tmp/orbit-speech-${process.pid}`)

vi.mock('electron', () => ({
  app: { getPath: () => USER_DATA, isPackaged: false },
}))

/** O motor de voz não roda em teste: a síntese é a fronteira que se substitui. */
const synthesize = vi.hoisted(() => vi.fn())

vi.mock('./index', () => ({ synthesizeToWav: synthesize }))

import { MAX_SPEECH_CACHE_FILES, speakToFile, speechCacheId } from './speech-file'

const AUDIO_DIR = path.join(USER_DATA, 'orbit-data', 'audio')
const MANIFEST = path.join(AUDIO_DIR, 'speech-cache.json')

beforeEach(async () => {
  synthesize.mockReset()
  synthesize.mockResolvedValue({ wav: Buffer.from('RIFF....WAVEfmt '), durationMs: 1234 })
  // Cada teste começa sem cache: o manifesto e os WAVs vivem na pasta real.
  await fs.rm(AUDIO_DIR, { recursive: true, force: true })
})

describe('id do cache', () => {
  it('é o mesmo para o mesmo texto e as mesmas opções', () => {
    const a = speechCacheId('bom dia', { voice: 'F1', lang: 'pt', speed: 1 })
    const b = speechCacheId('bom dia', { voice: 'F1', lang: 'pt', speed: 1 })
    expect(a).toBe(b)
  })

  it('muda com voz, idioma e velocidade — o áudio muda com eles', () => {
    const base = speechCacheId('bom dia', { voice: 'F1', lang: 'pt', speed: 1 })
    expect(speechCacheId('bom dia', { voice: 'F2', lang: 'pt', speed: 1 })).not.toBe(base)
    expect(speechCacheId('bom dia', { voice: 'F1', lang: 'en', speed: 1 })).not.toBe(base)
    expect(speechCacheId('bom dia', { voice: 'F1', lang: 'pt', speed: 1.5 })).not.toBe(base)
  })

  it('cabe no formato que o escopo `audio` aceita (SAFE_AUDIO_ID)', () => {
    // Id fora deste formato é servido como 404: o arquivo existe e o celular
    // não consegue abrir — falha que só aparece no aparelho.
    expect(speechCacheId('qualquer coisa')).toMatch(/^aud_[a-f0-9]{24}\.wav$/)
  })
})

describe('speakToFile', () => {
  it('sintetiza na primeira vez e grava o WAV na pasta de áudio', async () => {
    const r = await speakToFile('  bom dia  ')

    expect(r.cached).toBe(false)
    expect(r.durationMs).toBe(1234)
    // O espaço em volta não pode mudar o id: só o texto falado importa.
    expect(synthesize).toHaveBeenCalledWith('bom dia', {})

    await expect(fs.readFile(path.join(AUDIO_DIR, r.id))).resolves.toBeTruthy()
    const manifesto = JSON.parse(await fs.readFile(MANIFEST, 'utf8'))
    expect(manifesto[r.id]).toEqual({ durationMs: 1234, usedAt: expect.any(Number) })
  })

  it('o segundo toque no mesmo texto não sintetiza', async () => {
    const primeira = await speakToFile('bom dia')
    const segunda = await speakToFile('bom dia')

    expect(segunda).toEqual({ id: primeira.id, durationMs: 1234, cached: true })
    expect(synthesize).toHaveBeenCalledTimes(1)
  })

  it('manifesto que aponta para arquivo sumido sintetiza de novo', async () => {
    const { id } = await speakToFile('bom dia')
    await fs.rm(path.join(AUDIO_DIR, id))

    const outra = await speakToFile('bom dia')
    expect(outra.cached).toBe(false)
    expect(synthesize).toHaveBeenCalledTimes(2)
  })

  it('manifesto ilegível só custa o cache — não derruba a fala', async () => {
    await fs.mkdir(AUDIO_DIR, { recursive: true })
    await fs.writeFile(MANIFEST, '{ isto não é json')

    const r = await speakToFile('bom dia')
    expect(r.cached).toBe(false)
    expect(synthesize).toHaveBeenCalledTimes(1)
  })

  it('texto vazio é erro, não um arquivo mudo', async () => {
    await expect(speakToFile('   ')).rejects.toThrow(/vazio/)
    expect(synthesize).not.toHaveBeenCalled()
  })

  it('passando do teto, os mais antigos saem', async () => {
    await fs.mkdir(AUDIO_DIR, { recursive: true })
    const manifesto: Record<string, { durationMs: number; usedAt: number }> = {}
    const maisAntigo = `aud_${'0'.repeat(24)}.wav`
    for (let i = 0; i < MAX_SPEECH_CACHE_FILES; i++) {
      const id = `aud_${String(i).padStart(24, '0')}.wav`
      await fs.writeFile(path.join(AUDIO_DIR, id), 'x')
      manifesto[id] = { durationMs: 1, usedAt: i }
    }
    await fs.writeFile(MANIFEST, JSON.stringify(manifesto))

    const novo = await speakToFile('bom dia')
    const depois = JSON.parse(await fs.readFile(MANIFEST, 'utf8')) as Record<string, unknown>

    expect(Object.keys(depois)).toHaveLength(MAX_SPEECH_CACHE_FILES)
    expect(depois[novo.id]).toBeTruthy()
    // O mais antigo é o que paga a conta.
    expect(depois[maisAntigo]).toBeUndefined()
    await expect(fs.stat(path.join(AUDIO_DIR, maisAntigo))).rejects.toThrow()
  })
})
