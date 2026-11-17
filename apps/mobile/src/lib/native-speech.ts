/**
 * The phone's own speech recognizer (`expo-speech-recognition`), loaded defensively.
 *
 * The package is a native module: a dev client built before it was added does not have it, and
 * importing it there throws while the JS bundle is still loading — taking the whole app down
 * with it. So it is required inside a try/catch, once, and everything that needs it asks
 * `getNativeSpeech()`: `null` means "not in this build", and the dictation quietly uses the
 * desktop instead.
 */
import type { ExpoSpeechRecognitionModule as ModuleType } from 'expo-speech-recognition'

export interface NativeSpeech {
  module: typeof ModuleType
}

let cached: NativeSpeech | null | undefined

export function getNativeSpeech(): NativeSpeech | null {
  if (cached !== undefined) return cached
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const lib = require('expo-speech-recognition') as typeof import('expo-speech-recognition')
    cached = lib.ExpoSpeechRecognitionModule ? { module: lib.ExpoSpeechRecognitionModule } : null
  } catch {
    cached = null
  }
  return cached
}

/** Whether this build can recognize speech on the device. */
export function nativeSpeechAvailable(): boolean {
  return getNativeSpeech() !== null
}
