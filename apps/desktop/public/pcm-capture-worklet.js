/**
 * Dictation capture: delivers the microphone audio as PCM 16-bit, 16 kHz,
 * mono, to the main thread — in blocks of 1024 frames (~64 ms).
 *
 * The worklet only converts and forwards; the one that groups the blocks into ~128 ms
 * pieces and talks to the engine is the `use-dictation` hook, which is the one that knows when the speech
 * started and ended. On releasing the button the hook asks for a `flush` through the port so the
 * rest of the block goes out right away (without that the last syllable could stay in the buffer).
 *
 * It runs in the AudioWorklet, not in the DOM: `AudioWorkletProcessor` and
 * `registerProcessor` are globals from there; `sampleRate` (from the worklet scope)
 * is not in the ESLint list and is declared below.
 */
/* global sampleRate */

const BLOCK_FRAMES = 1024

class OrbitPcmCapture extends AudioWorkletProcessor {
  constructor() {
    super()
    this.buffer = new Float32Array(BLOCK_FRAMES)
    this.filled = 0
    this.port.onmessage = (event) => {
      if (event.data === "flush") this.flush()
    }
  }

  process(inputs) {
    const channel = inputs[0]?.[0]
    // No track connected yet: it stays alive until the audio arrives.
    if (!channel) return true
    for (let i = 0; i < channel.length; i++) {
      this.buffer[this.filled++] = channel[i]
      if (this.filled === BLOCK_FRAMES) this.flush()
    }
    // true = keeps processing: the capture only ends when the track is released and
    // the AudioContext closes — the hook always does both.
    return true
  }

  flush() {
    if (this.filled === 0) return
    const frames = this.filled
    const pcm = new Int16Array(frames)
    for (let i = 0; i < frames; i++) {
      const sample = Math.max(-1, Math.min(1, this.buffer[i]))
      // -32768..32767: the positive side saturates at 0x7fff, the negative takes the
      // extra value of the two's complement (the same mapping as WAV PCM16).
      pcm[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff
    }
    this.filled = 0
    // The buffer goes transferred: no copy per block, no accumulating garbage.
    this.port.postMessage({ pcm, sampleRate }, [pcm.buffer])
  }
}

registerProcessor("orbit-pcm-capture", OrbitPcmCapture)
