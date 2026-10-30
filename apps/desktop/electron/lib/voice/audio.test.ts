import { describe, expect, it } from 'vitest'

import {
  concatFloat32,
  encodeWavPcm16,
  float32ToPcm16,
  pcm16ToFloat32,
  resampleLinear,
  SampleBuffer,
  samplesToMs,
  splitForSynthesis,
  splitPcmWindows,
  StreamResampler,
} from './audio'

/**
 * The audio conversions are the path EVERY dictation goes through: a scale
 * error here (int16/32768 vs 32767, or +1/-1) comes out as noise or as silence,
 * and a wrong resample cuts or stretches the speech. They are pure functions — the edges can be
 * closed without a microphone or a model.
 */

describe('pcm16ToFloat32 / float32ToPcm16', () => {
  it('ida e volta preserva a forma de onda', () => {
    const original = Float32Array.from([0, 0.5, -0.5, 1, -1])
    const back = pcm16ToFloat32(float32ToPcm16(original))
    expect(back.length).toBe(original.length)
    for (let i = 0; i < original.length; i++) expect(back[i]).toBeCloseTo(original[i], 3)
  })

  it('reads little-endian and normalizes by 32768', () => {
    const pcm = Buffer.alloc(4)
    pcm.writeInt16LE(16384, 0) // 0.5
    pcm.writeInt16LE(-32768, 2) // -1
    expect(pcm16ToFloat32(pcm)[0]).toBeCloseTo(0.5, 4)
    expect(pcm16ToFloat32(pcm)[1]).toBe(-1)
  })

  it('ignores a leftover byte (odd buffer)', () => {
    expect(pcm16ToFloat32(Buffer.alloc(3)).length).toBe(1)
  })

  it('saturates instead of clipping instead of becoming noise', () => {
    const pcm = float32ToPcm16(Float32Array.from([2, -2]))
    expect(pcm.readInt16LE(0)).toBe(32767)
    expect(pcm.readInt16LE(2)).toBe(-32767)
  })
})

describe('SampleBuffer', () => {
  it('cuts by absolute index across chunks', () => {
    const buf = new SampleBuffer()
    buf.push(Float32Array.from([0, 1, 2]))
    buf.push(Float32Array.from([3, 4, 5]))
    expect(buf.samples).toBe(6)
    expect(Array.from(buf.slice(1, 5))).toEqual([1, 2, 3, 4])
  })

  it('clamps the cuts to the edges (never throws)', () => {
    const buf = new SampleBuffer()
    buf.push(Float32Array.from([7, 8]))
    expect(Array.from(buf.slice(-10, 99))).toEqual([7, 8])
    expect(buf.slice(5, 9).length).toBe(0)
  })

  it('an empty chunk does not change the count', () => {
    const buf = new SampleBuffer()
    buf.push(new Float32Array(0))
    expect(buf.samples).toBe(0)
  })
})

describe('StreamResampler', () => {
  it('the same rate passes straight through (no copy)', () => {
    const r = new StreamResampler(16000, 16000)
    const input = Float32Array.from([1, 2, 3])
    expect(r.push(input)).toBe(input)
    expect(r.flush().length).toBe(0)
  })

  it('48 kHz → 16 kHz drops to a third of the samples', () => {
    const r = new StreamResampler(48000, 16000)
    const out = r.push(new Float32Array(4800))
    expect(out.length).toBeGreaterThanOrEqual(1599)
    expect(out.length).toBeLessThanOrEqual(1601)
  })

  it('broken chunks give the same as the whole signal', () => {
    const whole = Float32Array.from({ length: 4800 }, (_, i) => Math.sin(i / 20))
    const todo = new StreamResampler(48000, 16000).push(whole)

    const r = new StreamResampler(48000, 16000)
    const a = r.push(whole.subarray(0, 1234))
    const b = r.push(whole.subarray(1234))
    const parts = concatFloat32([a, b])
    expect(parts.length).toBe(todo.length)
    for (let i = 0; i < todo.length; i++) expect(parts[i]).toBeCloseTo(todo[i], 5)
  })

  it('8 kHz → 16 kHz dobra a contagem', () => {
    const r = new StreamResampler(8000, 16000)
    const out = r.push(new Float32Array(800))
    expect(out.length).toBeGreaterThanOrEqual(1598)
    expect(out.length).toBeLessThanOrEqual(1600)
  })
})

describe('encodeWavPcm16', () => {
  it('writes a valid 44-byte WAV header', () => {
    const wav = encodeWavPcm16(Float32Array.from([0, 1, -1]), 16000)
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF')
    expect(wav.readUInt32LE(4)).toBe(36 + 6)
    expect(wav.toString('ascii', 8, 12)).toBe('WAVE')
    expect(wav.toString('ascii', 12, 16)).toBe('fmt ')
    expect(wav.readUInt16LE(20)).toBe(1) // PCM
    expect(wav.readUInt16LE(22)).toBe(1) // mono
    expect(wav.readUInt32LE(24)).toBe(16000)
    expect(wav.readUInt16LE(34)).toBe(16) // bits
    expect(wav.toString('ascii', 36, 40)).toBe('data')
    expect(wav.readUInt32LE(40)).toBe(6)
    expect(wav.length).toBe(44 + 6)
  })
})

describe('samplesToMs', () => {
  it('converts by the informed rate', () => {
    expect(samplesToMs(16000, 16000)).toBe(1000)
    expect(samplesToMs(8000, 16000)).toBe(500)
    expect(samplesToMs(100, 48000)).toBe(2)
  })
})

describe('splitForSynthesis', () => {
  it('short text goes whole', () => {
    expect(splitForSynthesis('Olá, tudo bem?')).toEqual(['Olá, tudo bem?'])
  })

  it('long text cuts at a sentence end, without passing the ceiling', () => {
    const sentence = 'Esta é uma frase de teste com algumas palavras. '
    const parts = splitForSynthesis(sentence.repeat(30), 200)
    expect(parts.length).toBeGreaterThan(1)
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(200)
      expect(part.endsWith('.')).toBe(true)
    }
    expect(parts.join(' ')).toBe(sentence.repeat(30).trim())
  })
})

describe('splitPcmWindows', () => {
  it('short audio is a single window', () => {
    expect(splitPcmWindows(new Float32Array(16000 * 10))).toEqual([[0, 160000]])
  })

  it('long audio cuts at the silence near the boundary and covers everything', () => {
    const rate = 1000
    // 25 s of "speech" (1.0) with a silence between 9.5 s and 9.7 s.
    const samples = new Float32Array(25 * rate).fill(1)
    samples.fill(0, 9500, 9700)
    const windows = splitPcmWindows(samples, rate, 10, 1)
    expect(windows[0][0]).toBe(0)
    expect(windows[0][1]).toBeGreaterThanOrEqual(9500)
    expect(windows[0][1]).toBeLessThan(9700)
    // Contiguous and up to the end.
    for (let i = 1; i < windows.length; i++) expect(windows[i][0]).toBe(windows[i - 1][1])
    expect(windows[windows.length - 1][1]).toBe(samples.length)
  })
})

describe('resampleLinear', () => {
  it('changes the number of samples in proportion to the rates', () => {
    expect(resampleLinear(new Float32Array(48000), 48000, 24000).length).toBe(24000)
    const same = new Float32Array([1, 2, 3])
    expect(resampleLinear(same, 16000, 16000)).toBe(same)
  })
})
