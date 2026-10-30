/**
 * Reading an answer out loud: asks the desktop for the WAV and plays it.
 *
 * WHY A STORE, and not a hook per message: the phone synthesizes nothing —
 * the speech travels as a FILE (`POST /api/voice/speak` → WAV with the token in the
 * path) and is played by `expo-audio`. One player per bubble would mean a native
 * player per message of the conversation; here it is ONE, created on the first touch and
 * reused with `replace`. The state also lives in a single place, so "only one
 * speech at a time" comes for free.
 *
 * The text is not assembled here: it arrives ready from `speakableText` (@orbit/shared),
 * the same rule the desktop uses — otherwise the same turn would come out different on the
 * computer and on the phone.
 */
import { create } from 'zustand'
import { createAudioPlayer, type AudioPlayer } from 'expo-audio'
import type { ChatMessage } from '@orbit/shared'
import { speakableText } from '@orbit/shared'
import { claimAudioFocus, releaseAudioFocus } from '~/lib/audio-focus'
import { errorCodeFromHttpError } from '~/lib/http-error'
import i18n from '~/i18n'
import { useConnectionStore } from './connection-store'

/** How long the error stays on screen before vanishing by itself (the same as the desktop). */
const ERROR_VISIBLE_MS = 6000

export type SpeakState = 'idle' | 'generating' | 'playing'

interface SpeakStore {
  state: SpeakState
  /** Message whose speech is being generated or played. */
  messageId: string | null
  /** Reason for the last failure (engine without a model, offline), already readable. */
  error: string | null
  /** Message whose speech failed — the notice only shows up in that actions bar. */
  errorMessageId: string | null
  /** Speaks the answer; a second tap on the same message interrupts it. */
  toggle: (message: ChatMessage) => void
  /** Silences it now and invalidates the request in flight. */
  stop: () => void
  dismissError: () => void
}

let player: AudioPlayer | null = null
/**
 * Number of the last request. An HTTP response that arrives after a new tap
 * (or a stop) cannot steal the speech — it compares and gives up.
 */
let requestSeq = 0
let errorTimer: ReturnType<typeof setTimeout> | null = null

function clearErrorTimer(): void {
  if (errorTimer) clearTimeout(errorTimer)
  errorTimer = null
}

/** Single player of the app, created on the first touch. */
function ensurePlayer(): AudioPlayer {
  if (player) return player
  const created = createAudioPlayer(null)
  // End of the audio → back to rest. Without this the button would stay on "stop"
  // after the speech finished.
  created.addListener('playbackStatusUpdate', (status) => {
    if (!status.didJustFinish) return
    if (useSpeakStore.getState().state !== 'playing') return
    useSpeakStore.setState({ state: 'idle', messageId: null })
  })
  player = created
  return created
}

export const useSpeakStore = create<SpeakStore>((set, get) => ({
  state: 'idle',
  messageId: null,
  error: null,
  errorMessageId: null,

  toggle: (message) => {
    const text = speakableText(message)
    if (!text) return
    const current = get()
    // Same button again: stop. Any other message takes over the speech.
    if (current.messageId === message.id && current.state !== 'idle') {
      get().stop()
      return
    }
    void run(message.id, text)
  },

  stop: () => {
    // Invalidates the request in flight: if the synthesis is still running, the response
    // that arrives later does not play.
    requestSeq++
    if (player) {
      try {
        player.pause()
      } catch {
        // Already released — nothing to pause.
      }
      releaseAudioFocus(player)
    }
    set({ state: 'idle', messageId: null })
  },

  dismissError: () => {
    clearErrorTimer()
    set({ error: null, errorMessageId: null })
  },
}))

/**
 * Code from the desktop → i18n key.
 *
 * The desktop sends a code, not a sentence (`VoiceSpeakErrorCode` in @orbit/shared):
 * the sentence is written here, where it is known in which language the person is reading. A
 * code outside this map — a 400 from validation, which only happens if the app assembles
 * the body wrongly — falls back to the generic notice, because there is nothing the person can do.
 */
const SPEAK_ERROR_KEY: Record<string, string> = {
  tts_disabled: 'voice.tts.errorDisabled',
  voice_unavailable: 'voice.tts.errorUnavailable',
}

function speakErrorText(error?: string): string {
  const code = errorCodeFromHttpError(error)
  const key = code ? SPEAK_ERROR_KEY[code] : undefined
  return key ? i18n.t(key) : i18n.t('voice.tts.failed')
}

/** Failure: stores the reason, ties it to the message that failed and schedules the exit. */
function fail(messageId: string, reason: string): void {
  useSpeakStore.setState({ state: 'idle', messageId: null, error: reason, errorMessageId: messageId })
  clearErrorTimer()
  errorTimer = setTimeout(() => {
    errorTimer = null
    useSpeakStore.setState({ error: null, errorMessageId: null })
  }, ERROR_VISIBLE_MS)
}

async function run(messageId: string, text: string): Promise<void> {
  const mine = ++requestSeq
  clearErrorTimer()
  useSpeakStore.setState({ state: 'generating', messageId, error: null, errorMessageId: null })

  const http = useConnectionStore.getState().http
  if (!http) {
    fail(messageId, i18n.t('voice.tts.offline'))
    return
  }

  const res = await http.speak(text)
  // New tap or stop along the way: this request died.
  if (mine !== requestSeq) return

  if (!res.ok || !res.data?.url) {
    fail(messageId, speakErrorText(res.error))
    return
  }

  const p = ensurePlayer()
  claimAudioFocus(p, () => {
    // Another audio took over the output: this speech is over, and the button needs to know.
    if (useSpeakStore.getState().messageId === messageId) {
      useSpeakStore.setState({ state: 'idle', messageId: null })
    }
  })
  p.replace({ uri: res.data.url })
  p.play()
  useSpeakStore.setState({ state: 'playing', messageId })
}
