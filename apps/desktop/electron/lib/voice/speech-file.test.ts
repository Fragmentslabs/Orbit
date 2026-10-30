import fs from 'node:fs/promises'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * On-demand speech of the companion app: text in, WAV out.
 *
 * What breaks silently here: the ID (it has to fit SAFE_AUDIO_ID, otherwise the
 * file exists and the phone gets a 404), the cache (without it every tap synthesises
 * again — and the voice model takes seconds) and the pruning (without it the audio folder
 * grows forever, because nothing else deletes these files: they are not in the
 * media index).
 */

const USER_DATA = vi.hoisted(() => `/tmp/orbit-speech-${process.pid}`)

vi.mock('electron', () => ({
  app: { getPath: () => USER_DATA, isPackaged: false },
}))

/** The voice engine does not run in a test: synthesis is the boundary that gets replaced. */
const synthesize = vi.hoisted(() => vi.fn())

vi.mock('./index', () => ({ synthesizeToWav: synthesize }))

import { MAX_SPEECH_CACHE_FILES, speakToFile, speechCacheId } from './speech-file'

const AUDIO_DIR = path.join(USER_DATA, 'orbit-data', 'audio')
const MANIFEST = path.join(AUDIO_DIR, 'speech-cache.json')

beforeEach(async () => {
  synthesize.mockReset()
  synthesize.mockResolvedValue({ wav: Buffer.from('RIFF....WAVEfmt '), durationMs: 1234 })
  // Each test starts without a cache: the manifest and the WAVs live in the real folder.
  await fs.rm(AUDIO_DIR, { recursive: true, force: true })
})

describe('id do cache', () => {
  it('is the same for the same text and the same options', () => {
    const a = speechCacheId('bom dia', { voice: 'F1', lang: 'pt', speed: 1 })
    const b = speechCacheId('bom dia', { voice: 'F1', lang: 'pt', speed: 1 })
    expect(a).toBe(b)
  })

  it('changes with voice, language and speed — the audio changes with them', () => {
    const base = speechCacheId('bom dia', { voice: 'F1', lang: 'pt', speed: 1 })
    expect(speechCacheId('bom dia', { voice: 'F2', lang: 'pt', speed: 1 })).not.toBe(base)
    expect(speechCacheId('bom dia', { voice: 'F1', lang: 'en', speed: 1 })).not.toBe(base)
    expect(speechCacheId('bom dia', { voice: 'F1', lang: 'pt', speed: 1.5 })).not.toBe(base)
  })

  it('fits the format the `audio` scope accepts (SAFE_AUDIO_ID)', () => {
    // An id outside this shape is served as a 404: the file exists and the phone
    // cannot open it — a failure that only shows up on the device.
    expect(speechCacheId('qualquer coisa')).toMatch(/^aud_[a-f0-9]{24}\.wav$/)
  })
})

describe('speakToFile', () => {
  it('synthesizes the first time and writes the WAV into the audio folder', async () => {
    const r = await speakToFile('  bom dia  ')

    expect(r.cached).toBe(false)
    expect(r.durationMs).toBe(1234)
    // The surrounding whitespace cannot change the id: only the spoken text matters.
    expect(synthesize).toHaveBeenCalledWith('bom dia', {})

    await expect(fs.readFile(path.join(AUDIO_DIR, r.id))).resolves.toBeTruthy()
    const manifesto = JSON.parse(await fs.readFile(MANIFEST, 'utf8'))
    expect(manifesto[r.id]).toEqual({ durationMs: 1234, usedAt: expect.any(Number) })
  })

  it('the second tap on the same text does not synthesize', async () => {
    const first = await speakToFile('bom dia')
    const segunda = await speakToFile('bom dia')

    expect(segunda).toEqual({ id: first.id, durationMs: 1234, cached: true })
    expect(synthesize).toHaveBeenCalledTimes(1)
  })

  it('a manifest pointing at a vanished file synthesizes again', async () => {
    const { id } = await speakToFile('bom dia')
    await fs.rm(path.join(AUDIO_DIR, id))

    const another = await speakToFile('bom dia')
    expect(another.cached).toBe(false)
    expect(synthesize).toHaveBeenCalledTimes(2)
  })

  it('an unreadable manifest only costs the cache — it does not break speech', async () => {
    await fs.mkdir(AUDIO_DIR, { recursive: true })
    await fs.writeFile(MANIFEST, '{ this is not json')

    const r = await speakToFile('bom dia')
    expect(r.cached).toBe(false)
    expect(synthesize).toHaveBeenCalledTimes(1)
  })

  it('empty text is an error, not a silent file', async () => {
    await expect(speakToFile('   ')).rejects.toThrow(/empty/)
    expect(synthesize).not.toHaveBeenCalled()
  })

  it('over the cap, the oldest go out', async () => {
    await fs.mkdir(AUDIO_DIR, { recursive: true })
    const manifesto: Record<string, { durationMs: number; usedAt: number }> = {}
    const oldest = `aud_${'0'.repeat(24)}.wav`
    for (let i = 0; i < MAX_SPEECH_CACHE_FILES; i++) {
      const id = `aud_${String(i).padStart(24, '0')}.wav`
      await fs.writeFile(path.join(AUDIO_DIR, id), 'x')
      manifesto[id] = { durationMs: 1, usedAt: i }
    }
    await fs.writeFile(MANIFEST, JSON.stringify(manifesto))

    const fresh = await speakToFile('bom dia')
    const manifest = JSON.parse(await fs.readFile(MANIFEST, 'utf8')) as Record<string, unknown>

    expect(Object.keys(manifest)).toHaveLength(MAX_SPEECH_CACHE_FILES)
    expect(manifest[fresh.id]).toBeTruthy()
    // The oldest one is the one that pays the bill.
    expect(manifest[oldest]).toBeUndefined()
    await expect(fs.stat(path.join(AUDIO_DIR, oldest))).rejects.toThrow()
  })
})
