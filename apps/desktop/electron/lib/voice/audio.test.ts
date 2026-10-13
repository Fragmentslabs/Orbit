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
 * As conversões de áudio são o caminho por onde TODO o ditado passa: um erro de
 * escala aqui (int16/32768 vs 32767, ou +1/-1) sai como ruído ou como silêncio,
 * e um resample errado corta ou estica a fala. São funções puras — dá para
 * fechar as bordas sem microfone nem modelo.
 */

describe('pcm16ToFloat32 / float32ToPcm16', () => {
  it('ida e volta preserva a forma de onda', () => {
    const original = Float32Array.from([0, 0.5, -0.5, 1, -1])
    const back = pcm16ToFloat32(float32ToPcm16(original))
    expect(back.length).toBe(original.length)
    for (let i = 0; i < original.length; i++) expect(back[i]).toBeCloseTo(original[i], 3)
  })

  it('lê little-endian e normaliza por 32768', () => {
    const pcm = Buffer.alloc(4)
    pcm.writeInt16LE(16384, 0) // 0.5
    pcm.writeInt16LE(-32768, 2) // -1
    expect(pcm16ToFloat32(pcm)[0]).toBeCloseTo(0.5, 4)
    expect(pcm16ToFloat32(pcm)[1]).toBe(-1)
  })

  it('ignora um byte sobrando (buffer ímpar)', () => {
    expect(pcm16ToFloat32(Buffer.alloc(3)).length).toBe(1)
  })

  it('satura em vez de estourar em vez de virar ruído', () => {
    const pcm = float32ToPcm16(Float32Array.from([2, -2]))
    expect(pcm.readInt16LE(0)).toBe(32767)
    expect(pcm.readInt16LE(2)).toBe(-32767)
  })
})

describe('SampleBuffer', () => {
  it('recorta por índice absoluto atravessando pedaços', () => {
    const buf = new SampleBuffer()
    buf.push(Float32Array.from([0, 1, 2]))
    buf.push(Float32Array.from([3, 4, 5]))
    expect(buf.samples).toBe(6)
    expect(Array.from(buf.slice(1, 5))).toEqual([1, 2, 3, 4])
  })

  it('limita os recortes às bordas (nunca lança)', () => {
    const buf = new SampleBuffer()
    buf.push(Float32Array.from([7, 8]))
    expect(Array.from(buf.slice(-10, 99))).toEqual([7, 8])
    expect(buf.slice(5, 9).length).toBe(0)
  })

  it('pedaço vazio não mexe na contagem', () => {
    const buf = new SampleBuffer()
    buf.push(new Float32Array(0))
    expect(buf.samples).toBe(0)
  })
})

describe('StreamResampler', () => {
  it('mesma taxa passa direto (sem cópia)', () => {
    const r = new StreamResampler(16000, 16000)
    const input = Float32Array.from([1, 2, 3])
    expect(r.push(input)).toBe(input)
    expect(r.flush().length).toBe(0)
  })

  it('48 kHz → 16 kHz cai para um terço das amostras', () => {
    const r = new StreamResampler(48000, 16000)
    const out = r.push(new Float32Array(4800))
    expect(out.length).toBeGreaterThanOrEqual(1599)
    expect(out.length).toBeLessThanOrEqual(1601)
  })

  it('pedaços quebrados dão o mesmo que o sinal inteiro', () => {
    const inteiro = Float32Array.from({ length: 4800 }, (_, i) => Math.sin(i / 20))
    const todo = new StreamResampler(48000, 16000).push(inteiro)

    const r = new StreamResampler(48000, 16000)
    const a = r.push(inteiro.subarray(0, 1234))
    const b = r.push(inteiro.subarray(1234))
    const partes = concatFloat32([a, b])
    expect(partes.length).toBe(todo.length)
    for (let i = 0; i < todo.length; i++) expect(partes[i]).toBeCloseTo(todo[i], 5)
  })

  it('8 kHz → 16 kHz dobra a contagem', () => {
    const r = new StreamResampler(8000, 16000)
    const out = r.push(new Float32Array(800))
    expect(out.length).toBeGreaterThanOrEqual(1598)
    expect(out.length).toBeLessThanOrEqual(1600)
  })
})

describe('encodeWavPcm16', () => {
  it('escreve um cabeçalho WAV válido de 44 bytes', () => {
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
  it('converte pela taxa informada', () => {
    expect(samplesToMs(16000, 16000)).toBe(1000)
    expect(samplesToMs(8000, 16000)).toBe(500)
    expect(samplesToMs(100, 48000)).toBe(2)
  })
})

describe('splitForSynthesis', () => {
  it('texto curto vai inteiro', () => {
    expect(splitForSynthesis('Olá, tudo bem?')).toEqual(['Olá, tudo bem?'])
  })

  it('texto longo corta em fim de frase, sem passar do teto', () => {
    const frase = 'Esta é uma frase de teste com algumas palavras. '
    const parts = splitForSynthesis(frase.repeat(30), 200)
    expect(parts.length).toBeGreaterThan(1)
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(200)
      expect(part.endsWith('.')).toBe(true)
    }
    expect(parts.join(' ')).toBe(frase.repeat(30).trim())
  })
})

describe('splitPcmWindows', () => {
  it('áudio curto é uma janela só', () => {
    expect(splitPcmWindows(new Float32Array(16000 * 10))).toEqual([[0, 160000]])
  })

  it('áudio longo corta no silêncio perto da fronteira e cobre tudo', () => {
    const rate = 1000
    // 25 s de "fala" (1.0) com um silêncio entre 9,5 s e 9,7 s.
    const samples = new Float32Array(25 * rate).fill(1)
    samples.fill(0, 9500, 9700)
    const windows = splitPcmWindows(samples, rate, 10, 1)
    expect(windows[0][0]).toBe(0)
    expect(windows[0][1]).toBeGreaterThanOrEqual(9500)
    expect(windows[0][1]).toBeLessThan(9700)
    // Contíguas e até o fim.
    for (let i = 1; i < windows.length; i++) expect(windows[i][0]).toBe(windows[i - 1][1])
    expect(windows[windows.length - 1][1]).toBe(samples.length)
  })
})

describe('resampleLinear', () => {
  it('muda o número de amostras na proporção das taxas', () => {
    expect(resampleLinear(new Float32Array(48000), 48000, 24000).length).toBe(24000)
    const same = new Float32Array([1, 2, 3])
    expect(resampleLinear(same, 16000, 16000)).toBe(same)
  })
})
