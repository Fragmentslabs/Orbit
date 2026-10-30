/**
 * Dictation (STT) helpers on the device.
 *
 * The phone does NOT run a voice model: expo-audio delivers the PCM
 * int16 buffers already at the requested rate (16 kHz, mono) and here they are joined into a single
 * buffer and encoded in base64 for the `POST /api/voice/transcribe` route of the
 * desktop (see docs/voice.md). No audio leaves for the cloud.
 *
 * The base64 is done by hand because Hermes does not ship `btoa`/`Buffer` and the audio
 * never goes through a file — it is not worth spending disk just to use
 * `expo-file-system` as an encoder.
 */

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** Joins the PCM chunks received from the microphone into a single contiguous buffer. */
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

/** Encodes bytes in base64 (3 bytes → 4 characters, with padding). */
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

/** Duration, in milliseconds, of a mono PCM16 at the given rate. */
export function pcmDurationMs(byteLength: number, sampleRate: number): number {
  if (sampleRate <= 0) return 0
  const samples = byteLength / 2
  return Math.round((samples / sampleRate) * 1000)
}
