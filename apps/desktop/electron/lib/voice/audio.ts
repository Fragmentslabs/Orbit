/**
 * Conversões de áudio do ditado por voz.
 *
 * A captura no renderer chega a **16 kHz mono PCM16** (little-endian) e é a
 * mesma taxa que os dois motores usam: o whisper.cpp quer WAV 16 kHz e o
 * Parakeet trabalha a 16 kHz. Ou seja, no caminho normal nada é reamostrado —
 * o `StreamResampler` existe só para não quebrar se um dia o renderer mandar
 * outra taxa (o pedido é "resample se o motor exigir outra taxa").
 */

/** Taxa que o renderer manda e que os dois motores esperam. */
export const STT_SAMPLE_RATE = 16000

/** PCM16LE mono (Buffer) -> Float32 normalizado em [-1, 1]. */
export function pcm16ToFloat32(pcm: Buffer): Float32Array {
  const n = Math.floor(pcm.length / 2)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = pcm.readInt16LE(i * 2) / 32768
  return out
}

/** Float32 (-1..1) -> PCM16LE mono (satura em vez de estourar). */
export function float32ToPcm16(samples: Float32Array): Buffer {
  const out = Buffer.allocUnsafe(samples.length * 2)
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]))
    out.writeInt16LE(Math.round(v * 32767), i * 2)
  }
  return out
}

/** Junta pedaços de Float32 num único vetor. */
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

/** Duração em ms de um número de amostras. */
export function samplesToMs(samples: number, sampleRate: number = STT_SAMPLE_RATE): number {
  return Math.round((samples / sampleRate) * 1000)
}

/**
 * Buffer de amostras crescente, com `slice` por índice absoluto.
 *
 * Os dois motores precisam retranscrever recortes (`[from, to)`) do áudio já
 * recebido — o Parakeet, o trecho aberto do VAD; a prévia do whisper, tudo o
 * que foi falado. Guardar os pedaços originais e só copiar no recorte evita
 * realocar o áudio inteiro a cada bloco que chega do microfone.
 */
export class SampleBuffer {
  private chunks: Float32Array[] = []
  private count = 0

  /** Total de amostras já recebidas. */
  get samples(): number {
    return this.count
  }

  push(chunk: Float32Array): void {
    if (!chunk.length) return
    this.chunks.push(chunk)
    this.count += chunk.length
  }

  /** Amostras de `from` (inclusive) a `to` (exclusivo), em índices absolutos. */
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
 * Reamostragem por interpolação linear, com estado entre pedaços.
 *
 * O último bloco não consumido fica retido (`carry`) e a posição fracionária
 * é preservada: reamostrar cada bloco isoladamente produziria um degrau na
 * emenda. Só é usado quando a taxa de entrada difere de 16 kHz.
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
    // Guarda pelo menos a ÚLTIMA amostra: a interpolação de fronteira precisa
    // dela e, sem o corte, um pedaço pequeno era descartado inteiro (a emenda
    // não dava o mesmo resultado do sinal contínuo).
    const consumed = Math.min(Math.floor(p), buf.length - 1)
    this.carry = buf.slice(consumed)
    this.pos = p - consumed
    return out.subarray(0, n)
  }

  /** Amostras restantes do último bloco (fim do áudio). */
  flush(): Float32Array {
    if (this.fromRate === this.toRate) return new Float32Array(0)
    const rest = this.carry.slice(Math.floor(this.pos))
    this.carry = new Float32Array(0)
    this.pos = 0
    return rest
  }
}

/**
 * WAV PCM16 mono, cabeçalho de 44 bytes.
 *
 * O `whisper-server` só aceita arquivo (multipart) — não há rota para PCM cru.
 * O cabeçalho é escrito à mão para não carregar dependência nenhuma.
 */
export function encodeWavPcm16(samples: Float32Array, sampleRate: number = STT_SAMPLE_RATE): Buffer {
  const pcm = float32ToPcm16(samples)
  const header = Buffer.alloc(44)
  const byteRate = sampleRate * 2
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16) // tamanho do bloco fmt
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(1, 22) // mono
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(byteRate, 28)
  header.writeUInt16LE(2, 32) // block align
  header.writeUInt16LE(16, 34) // bits por amostra
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

/**
 * Teto de caracteres por pedido de síntese: a rota do provedor aceita ~4 mil;
 * a folga cobre a contagem diferente de cada API.
 */
export const SYNTHESIS_MAX_CHARS = 3500

/**
 * Corta um texto longo em partes de até `max` caracteres, preferindo quebra de
 * parágrafo, depois fim de frase, depois espaço — nunca no meio de uma palavra
 * quando há alternativa.
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
 * Janelas [início, fim) para transcrever um áudio longo em partes de cerca de
 * `windowSec`. Cada corte cai no trecho de 100 ms mais quieto a até `searchSec`
 * da fronteira — uma pausa, quase sempre — para não partir uma palavra ao meio.
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

/** Reamostragem linear simples (para emendar pedaços de taxas diferentes). */
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
