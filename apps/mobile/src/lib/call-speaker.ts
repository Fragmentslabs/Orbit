/**
 * The voice of a call: plays the answer sentence by sentence.
 *
 * The phone synthesizes nothing. Every sentence goes to the desktop (`POST /api/voice/speak`) as
 * soon as it exists, and the WAV that comes back is queued behind the one playing — so while
 * sentence 1 plays, sentence 2 is already being generated and there is no silence between them.
 * Order is kept by the queue, not by whichever request answers first.
 *
 * It owns its own player (a call is one long conversation, not one bubble), and takes the audio
 * focus like every other player of the app, so a call speech and a read-aloud never play together.
 */
import { createAudioPlayer, type AudioPlayer } from 'expo-audio'
import type { HttpResult } from '@orbit/companion-client'
import type { VoiceSpeakResponse } from '@orbit/shared'

import { claimAudioFocus, releaseAudioFocus } from '~/lib/audio-focus'

export interface CallSpeakerHandlers {
  /** Asks the desktop for the WAV of a sentence. */
  speak: (text: string) => Promise<HttpResult<VoiceSpeakResponse>>
  /** A sentence failed to synthesize (the error code of the desktop, or undefined). */
  onError: (code: string | undefined) => void
  /** A sentence started playing: what the caption above the composer reveals. */
  onSentence?: (text: string) => void
  /** The speech was ended (`end()`) and the last sentence finished playing. */
  onDrained: () => void
}

export interface CallSpeaker {
  /** Queues a sentence. */
  say: (text: string) => void
  /** No more sentences are coming: `onDrained` fires once the queue has played out. */
  end: () => void
  /** Drops what is queued, past the sentence playing (the narration that leaves the speech). */
  trim: () => void
  /** Silences it now; nothing queued plays and `onDrained` does not fire. */
  stop: () => void
  /** Frees the player. The speaker is not usable afterwards. */
  release: () => void
}

interface Slot {
  text: string
  url: Promise<string | null>
}

export function createCallSpeaker(handlers: CallSpeakerHandlers): CallSpeaker {
  let player: AudioPlayer | null = null
  let queue: Slot[] = []
  let playing = false
  let ended = false
  // Bumped by stop(): an answer that arrives for an older speech is thrown away.
  let epoch = 0

  const ensurePlayer = (): AudioPlayer => {
    if (player) return player
    const created = createAudioPlayer(null)
    created.addListener('playbackStatusUpdate', (status) => {
      if (!status.didJustFinish) return
      playing = false
      void pump()
    })
    player = created
    return created
  }

  const request = (text: string): Slot => {
    const mine = epoch
    const url = handlers
      .speak(text)
      .then((res) => {
        if (mine !== epoch) return null
        if (!res.ok || !res.data?.url) {
          handlers.onError(res.error)
          return null
        }
        return res.data.url
      })
      .catch(() => {
        if (mine === epoch) handlers.onError(undefined)
        return null
      })
    return { text, url }
  }

  async function pump(): Promise<void> {
    if (playing) return
    const mine = epoch
    const next = queue.shift()
    if (!next) {
      if (ended) {
        ended = false
        handlers.onDrained()
      }
      return
    }
    playing = true
    const url = await next.url
    if (mine !== epoch) return
    if (!url) {
      // A sentence that failed is skipped: the rest of the answer still plays.
      playing = false
      void pump()
      return
    }
    const p = ensurePlayer()
    claimAudioFocus(p, () => {
      // Another audio took over the output: the call speech is over.
      if (mine === epoch) stop()
    })
    p.replace({ uri: url })
    p.play()
    handlers.onSentence?.(next.text)
  }

  function stop(): void {
    epoch++
    queue = []
    playing = false
    ended = false
    if (player) {
      try {
        player.pause()
      } catch {
        // Already released.
      }
      releaseAudioFocus(player)
    }
  }

  return {
    say(text) {
      if (!text.trim()) return
      queue.push(request(text))
      void pump()
    },
    end() {
      ended = true
      void pump()
    },
    trim() {
      // What is playing now stays; the sentences behind it leave.
      queue = []
    },
    stop,
    release() {
      stop()
      if (player) {
        try {
          player.remove()
        } catch {
          // Already released.
        }
        player = null
      }
    },
  }
}
