import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { motionAudioPlan, motionAudioTracks } from './motion-audio'

/**
 * A escolha do áudio da peça: o que o render mistura, o que a aba toca e o que o
 * agente lê no motion_preview saem TODOS daqui — uma divergência nesta função é um
 * vídeo com som diferente do que o usuário aprovou no preview.
 */

const root = path.join(os.tmpdir(), `orbit-motion-audio-${process.pid}`)
const composition = path.join(root, 'composition')
const outside = path.join(root, 'renders')

async function touch(file: string): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true })
  await fsp.writeFile(file, 'x')
}

async function writeManifest(value: unknown): Promise<void> {
  await fsp.writeFile(path.join(composition, 'audio.json'), JSON.stringify(value))
}

beforeAll(async () => {
  await fsp.mkdir(outside, { recursive: true })
})

afterAll(async () => {
  await fsp.rm(root, { recursive: true, force: true })
})

beforeEach(async () => {
  // Cada caso começa com a pasta limpa: o manifest de um não pode responder pelo
  // outro, e o arquivo solto de um não pode aparecer no seguinte.
  await fsp.rm(composition, { recursive: true, force: true })
  await fsp.mkdir(composition, { recursive: true })
})

describe('motionAudioTracks', () => {
  it('peça sem áudio nenhum é muda', async () => {
    expect(await motionAudioTracks(composition)).toEqual([])
  })

  it('o arquivo solto na pasta vale como uma faixa, a peça inteira', async () => {
    await touch(path.join(composition, 'audio.wav'))
    const tracks = await motionAudioTracks(composition)
    expect(tracks).toHaveLength(1)
    expect(tracks[0]).toMatchObject({ name: 'audio.wav', path: 'audio.wav', start: 0, gainDb: 0, duck: false })
    expect(tracks[0]).not.toHaveProperty('end')
  })

  it('o caminho explícito manda sobre a pasta', async () => {
    await touch(path.join(composition, 'audio.wav'))
    const file = path.join(outside, 'narracao.m4a')
    await touch(file)
    const tracks = await motionAudioTracks(composition, file)
    expect(tracks).toHaveLength(1)
    expect(tracks[0]).toMatchObject({ name: 'narracao.m4a', file })
    // Fora da pasta não há URL no scheme: o render leva, o preview não alcança.
    expect(tracks[0]).toMatchObject({ path: null })
  })

  it('o manifest declara quantas faixas quiser, cada uma no seu instante', async () => {
    await touch(path.join(composition, 'voz.mp3'))
    await touch(path.join(composition, 'cama.mp3'))
    await touch(path.join(composition, 'whoosh.wav'))
    await writeManifest({
      tracks: [
        { file: 'voz.mp3', name: 'Narração' },
        { file: 'cama.mp3', gain: -18, fadeOut: 1.5, duck: true },
        { file: 'whoosh.wav', start: 4.2, gain: -6, fadeIn: 0.2 },
      ],
    })
    const tracks = await motionAudioTracks(composition)
    expect(tracks.map((track) => track.name)).toEqual(['Narração', 'cama.mp3', 'whoosh.wav'])
    expect(tracks[0]).toMatchObject({ start: 0, gainDb: 0, fadeIn: 0, fadeOut: 0, duck: false, path: 'voz.mp3' })
    expect(tracks[1]).toMatchObject({ start: 0, gainDb: -18, fadeOut: 1.5, duck: true, path: 'cama.mp3' })
    expect(tracks[2]).toMatchObject({ start: 4.2, gainDb: -6, fadeIn: 0.2, duck: false })
    expect(tracks[2]).not.toHaveProperty('end')
  })

  it('com manifest, o arquivo solto fica de fora', async () => {
    await touch(path.join(composition, 'audio.wav'))
    await touch(path.join(composition, 'voz.mp3'))
    await writeManifest({ tracks: [{ file: 'voz.mp3' }] })
    const tracks = await motionAudioTracks(composition)
    expect(tracks.map((track) => track.name)).toEqual(['voz.mp3'])
  })

  it('a lista solta também vale, e `end` recorta a faixa', async () => {
    await touch(path.join(composition, 'efeito.wav'))
    await writeManifest([{ file: 'efeito.wav', start: 2, end: 3.5 }])
    const tracks = await motionAudioTracks(composition)
    expect(tracks).toHaveLength(1)
    expect(tracks[0]).toMatchObject({ start: 2, end: 3.5 })
  })

  it('faixa declarada que não existe é erro com o caminho, não silêncio', async () => {
    await writeManifest({ tracks: [{ file: 'nao-existe.mp3' }] })
    await expect(motionAudioTracks(composition)).rejects.toThrow(/audio file not found/)
  })

  it('manifest quebrado diz o que houve', async () => {
    await fsp.writeFile(path.join(composition, 'audio.json'), '{ tracks: ')
    await expect(motionAudioTracks(composition)).rejects.toThrow(/not valid JSON/)

    await writeManifest({ tracks: [{ name: 'sem arquivo' }] })
    await expect(motionAudioTracks(composition)).rejects.toThrow(/has no "file"/)

    await writeManifest({ faixas: [] })
    await expect(motionAudioTracks(composition)).rejects.toThrow(/list of tracks/)
  })

  it('fim antes do começo não cria faixa morta: toca o arquivo a partir do start', async () => {
    await touch(path.join(composition, 'efeito.wav'))
    await writeManifest({ tracks: [{ file: 'efeito.wav', start: 2, end: 1 }] })
    const tracks = await motionAudioTracks(composition)
    expect(tracks[0]).toMatchObject({ start: 2 })
    expect(tracks[0]).not.toHaveProperty('end')
  })

  it('o arquivo solto é escolhido em ordem estável quando há mais de um', async () => {
    await touch(path.join(composition, 'trilha.mp3'))
    await touch(path.join(composition, 'audio.wav'))
    const tracks = await motionAudioTracks(composition)
    expect(tracks.map((track) => track.name)).toEqual(['audio.wav'])
  })
})

describe('tratamento no manifest', () => {
  it('lê preset, eq, compressor, curva e duck personalizado por faixa', async () => {
    await touch(path.join(composition, 'voz.mp3'))
    await touch(path.join(composition, 'cama.mp3'))
    await writeManifest({
      tracks: [
        { file: 'voz.mp3', preset: 'voice', highpass: 100, automation: [[0, -12], [1, 0]] },
        { file: 'cama.mp3', preset: 'bed', duck: { ratio: 6, release: 0.8 } },
      ],
    })
    const tracks = await motionAudioTracks(composition)
    expect(tracks[0].fx.highpass).toBe(100)
    expect(tracks[0].fx.eq).toHaveLength(2)
    expect(tracks[0].fx.automation).toEqual([
      { at: 0, db: -12 },
      { at: 1, db: 0 },
    ])
    expect(tracks[0].duck).toBe(false)
    expect(tracks[0]).not.toHaveProperty('duckSettings')
    expect(tracks[1].fx.lowpass).toBe(14000)
    expect(tracks[1].duck).toBe(true)
    expect(tracks[1].duckSettings).toMatchObject({ ratio: 6, release: 800 })
  })

  it('a faixa sem tratamento continua sem tratamento', async () => {
    await touch(path.join(composition, 'voz.mp3'))
    await writeManifest({ tracks: [{ file: 'voz.mp3' }] })
    const [track] = await motionAudioTracks(composition)
    expect(track.fx).toEqual({ eq: [], automation: [], highpass: undefined, lowpass: undefined, compress: undefined })
  })

  it('o erro de um campo diz qual faixa do manifest', async () => {
    await touch(path.join(composition, 'voz.mp3'))
    await touch(path.join(composition, 'cama.mp3'))
    await writeManifest({ tracks: [{ file: 'voz.mp3' }, { file: 'cama.mp3', eq: [{ freq: 1000, gain: 99 }] }] })
    await expect(motionAudioTracks(composition)).rejects.toThrow(/audio\.json: track 2 \(cama\.mp3\): eq band 1 gain 99/)
  })

  it('o acabamento só existe na forma de objeto', async () => {
    await touch(path.join(composition, 'voz.mp3'))
    await writeManifest({ tracks: [{ file: 'voz.mp3' }], master: { loudness: -16, limit: -1 } })
    expect((await motionAudioPlan(composition)).master).toEqual({ loudness: -16, limit: -1 })

    await writeManifest([{ file: 'voz.mp3' }])
    expect((await motionAudioPlan(composition)).master).toBeNull()

    await writeManifest({ tracks: [{ file: 'voz.mp3' }], master: { loudness: 10 } })
    await expect(motionAudioPlan(composition)).rejects.toThrow(/master: loudness 10/)
  })
})
