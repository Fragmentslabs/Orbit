import { sound } from "./ipc"

/**
 * Persona entrance sound, played in the renderer with WebAudio.
 *
 * Before, the audio was fired by the main process on did-finish-load, while the
 * persona woke up on a 650ms timer after the React mount. The distance
 * between the two anchors was the renderer loading time — negligible
 * in production (single bundle), but from hundreds of ms to seconds in dev (Vite
 * transforms modules on demand). In practice the sound started visibly before
 * the persona woke up, especially running in dev.
 *
 * Here the WAV bytes come from main over IPC (a single read, with no timing) and the
 * audio is decoded during loading — the window is born hidden, so
 * there is nothing to play yet. At the instant of the wake-up the playback is scheduled in the
 * same callback that fires the persona transition: audio and persona start
 * together, by construction, in dev and in production. Decoding in the renderer does not
 * depend on an OS player nor on an asset fetch (file:// fetch is blocked
 * in the packaged app, which loads via loadFile).
 */

let audioContext: AudioContext | null = null
let entranceBuffer: AudioBuffer | null = null

/** Creates the context and decodes the WAV. Failures silence the entrance. */
export async function prepareEntranceSound(): Promise<void> {
  try {
    audioContext ??= new AudioContext()
    if (entranceBuffer) return
    const bytes = await sound.entranceData()
    if (!bytes) return
    entranceBuffer = await audioContext.decodeAudioData(bytes.buffer as ArrayBuffer)
  } catch (error) {
    entranceBuffer = null
    console.warn("[sound] failed to prepare the entrance sound", error)
  }
}

/** Plays the entrance sound now, on the AudioContext clock. */
export function playEntranceSound(): void {
  try {
    if (!audioContext || !entranceBuffer) return // no buffer = silent entrance
    void audioContext.resume()
    const source = audioContext.createBufferSource()
    source.buffer = entranceBuffer
    source.connect(audioContext.destination)
    source.start()
  } catch {
    // the sound can never take down the app opening
  }
}