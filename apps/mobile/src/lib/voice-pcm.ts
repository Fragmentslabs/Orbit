/**
 * Helpers do ditado (STT) no aparelho.
 *
 * O celular NÃO roda modelo de voz: o expo-audio entrega os buffers de PCM
 * int16 já na taxa pedida (16 kHz, mono) e aqui eles são juntados num único
 * buffer e codificados em base64 para a rota `POST /api/voice/transcribe` do
 * desktop (ver docs/voz.md). Nada de áudio sai para a nuvem.
 *
 * O base64 é feito à mão porque o Hermes não traz `btoa`/`Buffer` e o áudio
 * nunca passa por arquivo — não vale a pena gastar disco só para usar o
 * `expo-file-system` como codificador.
 */

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** Junta os pedaços de PCM recebidos do microfone num único buffer contíguo. */
export function concatPcm(chunks: Uint8Array[]): Uint8Array {
  let total = 0
  for (const chunk of chunks) total += chunk.length
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

/** Codifica bytes em base64 (3 bytes → 4 caracteres, com padding). */
export function bytesToBase64(bytes: Uint8Array): string {
  const len = bytes.length
  const groups: string[] = []
  for (let i = 0; i < len; i += 3) {
    const b0 = bytes[i]
    const hasB1 = i + 1 < len
    const hasB2 = i + 2 < len
    const b1 = hasB1 ? bytes[i + 1] : 0
    const b2 = hasB2 ? bytes[i + 2] : 0
    groups.push(
      BASE64_ALPHABET[b0 >> 2]
        + BASE64_ALPHABET[((b0 & 0x03) << 4) | (b1 >> 4)]
        + (hasB1 ? BASE64_ALPHABET[((b1 & 0x0f) << 2) | (b2 >> 6)] : '=')
        + (hasB2 ? BASE64_ALPHABET[b2 & 0x3f] : '='),
    )
  }
  return groups.join('')
}

/** Duração, em milissegundos, de um PCM16 mono na taxa dada. */
export function pcmDurationMs(byteLength: number, sampleRate: number): number {
  if (sampleRate <= 0) return 0
  const samples = byteLength / 2
  return Math.round((samples / sampleRate) * 1000)
}
