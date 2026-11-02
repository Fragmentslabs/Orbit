import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { motionAudioPlan, motionAudioTracks } from './motion-audio'

/**
 * The choice of the piece's audio: what the render mixes, what the tab plays and what the
 * agent reads in motion_preview ALL come from here — a divergence in this function is a
 * video with a sound different from the one the user approved in the preview.
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
  // Each case starts with a clean folder: one's manifest cannot answer for the
  // other, and one's loose file cannot show up in the next.
  await fsp.rm(composition, { recursive: true, force: true })
  await fsp.mkdir(composition, { recursive: true })
})

describe('motionAudioTracks', () => {
  it('offset starts the file midway, loop repeats it, volume is linear', async () => {
    await touch(path.join(composition, 'song.mp3'))
    await writeManifest([
      { file: 'song.mp3', start: 2, offset: 63.5, volume: 0.1, loop: true },
      { file: 'song.mp3', start: 0, end: 2, volume: 0 },
    ])
    const [chorus, silent] = await motionAudioTracks(composition)
    expect(chorus).toMatchObject({ start: 2, offset: 63.5, loop: true, gainDb: -20 })
    expect(silent.gainDb).toBe(-120)
    expect(silent).not.toHaveProperty('offset')
  })

  it('gain and volume together is a contradiction, not a guess', async () => {
    await touch(path.join(composition, 'song.mp3'))
    await writeManifest([{ file: 'song.mp3', gain: -6, volume: 0.5 }])
    await expect(motionAudioTracks(composition)).rejects.toThrow(/not both/)
  })

  it('a piece with no audio at all is silent', async () => {
    expect(await motionAudioTracks(composition)).toEqual([])
  })

  it('a single file loose in the folder counts as one track, the whole piece', async () => {
    await touch(path.join(composition, 'audio.wav'))
    const tracks = await motionAudioTracks(composition)
    expect(tracks).toHaveLength(1)
    expect(tracks[0]).toMatchObject({ name: 'audio.wav', path: 'audio.wav', start: 0, gainDb: 0, duck: false })
    expect(tracks[0]).not.toHaveProperty('end')
  })

  it('the explicit path wins over the folder', async () => {
    await touch(path.join(composition, 'audio.wav'))
    const file = path.join(outside, 'narracao.m4a')
    await touch(file)
    const tracks = await motionAudioTracks(composition, file)
    expect(tracks).toHaveLength(1)
    expect(tracks[0]).toMatchObject({ name: 'narracao.m4a', file })
    // Outside the folder there is no URL in the scheme: the render takes it, the preview cannot reach it.
    expect(tracks[0]).toMatchObject({ path: null })
  })

  it('the manifest declares as many tracks as it wants, each at its own instant', async () => {
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

  it('with a manifest, the loose file stays out', async () => {
    await touch(path.join(composition, 'audio.wav'))
    await touch(path.join(composition, 'voz.mp3'))
    await writeManifest({ tracks: [{ file: 'voz.mp3' }] })
    const tracks = await motionAudioTracks(composition)
    expect(tracks.map((track) => track.name)).toEqual(['voz.mp3'])
  })

  it('the loose list also counts, and `end` trims the track', async () => {
    await touch(path.join(composition, 'efeito.wav'))
    await writeManifest([{ file: 'efeito.wav', start: 2, end: 3.5 }])
    const tracks = await motionAudioTracks(composition)
    expect(tracks).toHaveLength(1)
    expect(tracks[0]).toMatchObject({ start: 2, end: 3.5 })
  })

  it('a declared track that does not exist is an error with the path, not silence', async () => {
    await writeManifest({ tracks: [{ file: 'nao-existe.mp3' }] })
    await expect(motionAudioTracks(composition)).rejects.toThrow(/audio file not found/)
  })

  it('a broken manifest says what happened', async () => {
    await fsp.writeFile(path.join(composition, 'audio.json'), '{ tracks: ')
    await expect(motionAudioTracks(composition)).rejects.toThrow(/not valid JSON/)

    await writeManifest({ tracks: [{ name: 'no file' }] })
    await expect(motionAudioTracks(composition)).rejects.toThrow(/has no "file"/)

    await writeManifest({ faixas: [] })
    await expect(motionAudioTracks(composition)).rejects.toThrow(/list of tracks/)
  })

  it('end before the start does not create a dead track: it plays the file from start', async () => {
    await touch(path.join(composition, 'efeito.wav'))
    await writeManifest({ tracks: [{ file: 'efeito.wav', start: 2, end: 1 }] })
    const tracks = await motionAudioTracks(composition)
    expect(tracks[0]).toMatchObject({ start: 2 })
    expect(tracks[0]).not.toHaveProperty('end')
  })

  it('the loose file is chosen in a stable order when there is more than one', async () => {
    await touch(path.join(composition, 'trilha.mp3'))
    await touch(path.join(composition, 'audio.wav'))
    const tracks = await motionAudioTracks(composition)
    expect(tracks.map((track) => track.name)).toEqual(['audio.wav'])
  })
})

describe('tratamento no manifest', () => {
  it('reads preset, eq, compressor, curve and custom duck per track', async () => {
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

  it('the track with no treatment stays with no treatment', async () => {
    await touch(path.join(composition, 'voz.mp3'))
    await writeManifest({ tracks: [{ file: 'voz.mp3' }] })
    const [track] = await motionAudioTracks(composition)
    expect(track.fx).toEqual({ eq: [], automation: [], highpass: undefined, lowpass: undefined, compress: undefined })
  })

  it('the error of a field says which manifest track', async () => {
    await touch(path.join(composition, 'voz.mp3'))
    await touch(path.join(composition, 'cama.mp3'))
    await writeManifest({ tracks: [{ file: 'voz.mp3' }, { file: 'cama.mp3', eq: [{ freq: 1000, gain: 99 }] }] })
    await expect(motionAudioTracks(composition)).rejects.toThrow(/audio\.json: track 2 \(cama\.mp3\): eq band 1 gain 99/)
  })

  it('the finish only exists in object form', async () => {
    await touch(path.join(composition, 'voz.mp3'))
    await writeManifest({ tracks: [{ file: 'voz.mp3' }], master: { loudness: -16, limit: -1 } })
    expect((await motionAudioPlan(composition)).master).toEqual({ loudness: -16, limit: -1 })

    await writeManifest([{ file: 'voz.mp3' }])
    expect((await motionAudioPlan(composition)).master).toBeNull()

    await writeManifest({ tracks: [{ file: 'voz.mp3' }], master: { loudness: 10 } })
    await expect(motionAudioPlan(composition)).rejects.toThrow(/master: loudness 10/)
  })
})
