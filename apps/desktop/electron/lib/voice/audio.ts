/**
 * Audio conversions for voice dictation.
 *
 * The capture in the renderer arrives as **16 kHz mono PCM16** (little-endian) and it is
 * the same rate both engines use: whisper.cpp wants 16 kHz WAV and
 * Parakeet works at 16 kHz. That is, on the normal path nothing is resampled —
 * `StreamResampler` exists only so things do not break if the renderer one day sends
 * another rate (the request is "resample if the engine requires another rate").
 */

/** Rate the renderer sends and both engines expect. */
export const STT_SAMPLE_RATE = 16000

/** PCM16LE mono (Buffer) -> Float32 normalised to [-1, 1]. */
export function pcm16ToFloat32(pcm: Buffer): Float32Array {
  const n = Math.floor(pcm.length / 2)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = pcm.readInt16LE(i * 2) / 32768
  return out
}

/** Float32 (-1..1) -> PCM16LE mono (saturates instead of overflowing). */
export function float32ToPcm16(samples: Float32Array): Buffer {
  const out = Buffer.allocUnsafe(samples.length * 2)
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]))
    out.writeInt16LE(Math.round(v * 32767), i * 2)
  }
  return out
}

/** Joins Float32 chunks into a single array. */
export function concatFloat32(chunks: Float32Array[]): Float32Array {
  let total = 0
  for (const c of chunks) total += c.length
  const out = new Float32Array(total)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.length
  }
  return out
}

/** Duration in ms of a number of samples. */
export function samplesToMs(samples: number, sampleRate: number = STT_SAMPLE_RATE): number {
  return Math.round((samples / sampleRate) * 1000)
}

/**
 * Growing sample buffer, with `slice` by absolute index.
 *
 * Both engines need to re-transcribe cuts (`[from, to)`) of the audio already
 * received — Parakeet, the open VAD segment; the whisper preview, everything
 * that was spoken. Keeping the original chunks and copying only on the cut avoids
 * reallocating the whole audio for every block that arrives from the microphone.
 */
export class SampleBuffer {
  private chunks: Float32Array[] = []
  private count = 0

  /** Total samples received so far. */
  get samples(): number {
    return this.count
  }

  push(chunk: Float32Array): void {
    if (!chunk.length) return
    this.chunks.push(chunk)
    this.count += chunk.length
  }

  /** Samples from `from` (inclusive) to `to` (exclusive), in absolute indices. */
  slice(from: number, to: number): Float32Array {
    const start = Math.max(0, from)
    const end = Math.min(this.count, to)
    const out = new Float32Array(Math.max(0, end - start))
    if (!out.length) return out
    let off = 0
    for (const c of this.chunks) {
      const cStart = off
      off += c.length
      if (off <= start || cStart >= end) continue
      const a = Math.max(0, start - cStart)
      const b = Math.min(c.length, end - cStart)
      out.set(c.subarray(a, b), cStart + a - start)
    }
    return out
  }
}

/**
 * Resampling by linear interpolation, with state across chunks.
 *
 * The last unconsumed block is kept (`carry`) and the fractional position
 * is preserved: resampling each block in isolation would produce a step at the
 * seam. It is only used when the input rate differs from 16 kHz.
 */
export class StreamResampler {
  private readonly ratio: number
  private carry: Float32Array = new Float32Array(0)
  private pos = 0

  constructor(
    private readonly fromRate: number,
    private readonly toRate: number,
  ) {
    this.ratio = fromRate / toRate
  }

  push(input: Float32Array): Float32Array {
    if (this.fromRate === this.toRate) return input
    if (!input.length) return new Float32Array(0)
    const buf = new Float32Array(this.carry.length + input.length)
    buf.set(this.carry)
    buf.set(input, this.carry.length)

    const out = new Float32Array(Math.ceil(buf.length / this.ratio) + 1)
    let p = this.pos
    let n = 0
    while (p + 1 < buf.length) {
      const i = Math.floor(p)
      const frac = p - i
      out[n++] = buf[i] * (1 - frac) + buf[i + 1] * frac
      p += this.ratio
    }
    // Keep at least the LAST sample: the boundary interpolation needs
    // it and, without the cut, a small chunk was discarded entirely (the seam
    // did not give the same result as the continuous signal).
    const consumed = Math.min(Math.floor(p), buf.length - 1)
    this.carry = buf.slice(consumed)
    this.pos = p - consumed
    return out.subarray(0, n)
  }

  /** Remaining samples of the last block (end of the audio). */
  flush(): Float32Array {
    if (this.fromRate === this.toRate) return new Float32Array(0)
    const rest = this.carry.slice(Math.floor(this.pos))
    this.carry = new Float32Array(0)
    this.pos = 0
    return rest
  }
}

/**
 * WAV PCM16 mono, 44-byte header.
 *
 * `whisper-server` only accepts a file (multipart) — there is no route for raw PCM.
 * The header is written by hand so no dependency has to be loaded.
 */
export function encodeWavPcm16(samples: Float32Array, sampleRate: number = STT_SAMPLE_RATE): Buffer {
  const pcm = float32ToPcm16(samples)
  const header = Buffer.alloc(44)
  const byteRate = sampleRate * 2
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16) // fmt chunk size
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(1, 22) // mono
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(byteRate, 28)
  header.writeUInt16LE(2, 32) // block align
  header.writeUInt16LE(16, 34) // bits per sample
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

/**
 * Character ceiling per synthesis request: the provider route accepts ~4 thousand;
 * the slack covers each API's different counting.
 */
export const SYNTHESIS_MAX_CHARS = 3500

/**
 * Cuts a long text into parts of up to `max` characters, preferring a paragraph
 * break, then a sentence end, then a space — never in the middle of a word
 * when there is an alternative.
 */
export function splitForSynthesis(text: string, max = SYNTHESIS_MAX_CHARS): string[] {
  const parts: string[] = []
  let rest = text.trim()
  while (rest.length > max) {
    const window = rest.slice(0, max)
    const cut =
      [window.lastIndexOf('\n\n'), Math.max(window.lastIndexOf('. '), window.lastIndexOf('! '), window.lastIndexOf('? ')) + 1, window.lastIndexOf(' ')]
        .find((at) => at > max * 0.5) ?? max
    parts.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut).trim()
  }
  if (rest) parts.push(rest)
  return parts
}

/**
 * Windows [start, end) to transcribe a long audio in parts of about
 * `windowSec`. Each cut falls on the quietest 100 ms stretch within `searchSec`
 * of the boundary — a pause, almost always — so as not to split a word in half.
 */
export function splitPcmWindows(
  samples: Float32Array,
  rate: number = STT_SAMPLE_RATE,
  windowSec = 240,
  searchSec = 3,
): [number, number][] {
  const windows: [number, number][] = []
  const frame = Math.round(rate * 0.1)
  let start = 0
  while (samples.length - start > (windowSec + searchSec) * rate) {
    const target = start + windowSec * rate
    let best = target
    let bestEnergy = Infinity
    for (let at = target - searchSec * rate; at + frame <= target + searchSec * rate; at += frame) {
      let energy = 0
      for (let i = at; i < at + frame; i++) energy += samples[i] * samples[i]
      if (energy < bestEnergy) {
        bestEnergy = energy
        best = at + Math.floor(frame / 2)
      }
    }
    windows.push([start, best])
    start = best
  }
  windows.push([start, samples.length])
  return windows
}

/** Simple linear resampling (to splice chunks of different rates). */
export function resampleLinear(samples: Float32Array, from: number, to: number): Float32Array {
  if (from === to || samples.length === 0) return samples
  const out = new Float32Array(Math.max(1, Math.round((samples.length * to) / from)))
  const ratio = from / to
  for (let i = 0; i < out.length; i++) {
    const pos = i * ratio
    const base = Math.floor(pos)
    const next = Math.min(base + 1, samples.length - 1)
    const frac = pos - base
    out[i] = samples[base] * (1 - frac) + samples[next] * frac
  }
  return out
}
