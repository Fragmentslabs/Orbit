import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { copyWordsSidecar, describeSpokenDiff, readWordsSidecar, spokenDiff, writeWordsSidecar } from './motion-words'

const word = (text: string, startMs = 0, endMs = 100) => ({ text, startMs, endMs })

describe('words sidecar', () => {
  it('is written next to the audio, read back and copied with it', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'orbit-words-'))
    try {
      const a = path.join(dir, 'nar.wav')
      const b = path.join(dir, 'copy.wav')
      expect(await readWordsSidecar(a)).toBeNull()
      await writeWordsSidecar(a, [word(' Oi ', 10.4, 500.6)])
      expect(await readWordsSidecar(a)).toEqual([{ text: 'Oi', startMs: 10, endMs: 501 }])
      expect(await copyWordsSidecar(a, b)).toBe(true)
      expect(await readWordsSidecar(b)).toEqual([{ text: 'Oi', startMs: 10, endMs: 501 }])
      expect(await copyWordsSidecar(path.join(dir, 'none.wav'), b)).toBe(false)
    } finally {
      await fsp.rm(dir, { recursive: true, force: true })
    }
  })

  it('treats a broken file as no words', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'orbit-words-'))
    try {
      const a = path.join(dir, 'x.wav')
      await fsp.writeFile(`${a}.words.json`, '{nope')
      expect(await readWordsSidecar(a)).toBeNull()
    } finally {
      await fsp.rm(dir, { recursive: true, force: true })
    }
  })
})

describe('spokenDiff', () => {
  it('is empty when the voice said what was written, ignoring case, accents and punctuation', () => {
    const diff = spokenDiff('Existe diferença, humilde!', [word('existe'), word('Diferenca'), word('humilde.')])
    expect(diff).toEqual({ missing: [], extra: [] })
    expect(describeSpokenDiff(diff)).toBe('')
  })

  it('reports what was written but not heard, and what was heard but not written', () => {
    const diff = spokenDiff('o PRIDE importa', [word('o'), word('Preda'), word('importa')])
    expect(diff.missing).toEqual(['pride'])
    expect(diff.extra).toEqual(['preda'])
    expect(describeSpokenDiff(diff)).toMatch(/written but not heard: "pride".*heard but not written: "preda"/)
  })

  it('counts a repeated word each time', () => {
    expect(spokenDiff('sim sim sim', [word('sim'), word('sim')]).missing).toEqual(['sim'])
  })
})
