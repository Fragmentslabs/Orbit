/**
 * One player at a time in the app.
 *
 * Three things compete for the same audio output: the player of an agent audio
 * (`AudioPartView`), the one of the gallery and the read-aloud of an answer. Without
 * an owner, two play together and the person does not know which one to pause — each player
 * only knows about itself.
 *
 * Whoever takes the focus pauses the previous one and is NOTIFIED when it loses the focus
 * (`onPreempted`), because whoever drives the player does not always derive its state:
 * the audio bubble reads `status.playing` and corrects itself, but the speak
 * button keeps its own state and would stay on "stop" while speaking nothing.
 */
import type { AudioPlayer } from 'expo-audio'

let active: AudioPlayer | null = null
/** What to do when THIS owner loses the focus (the next one takes over). */
let preempted: (() => void) | null = null

/** Takes the audio: pauses whoever was playing and becomes the owner. */
export function claimAudioFocus(player: AudioPlayer, onPreempted?: () => void): void {
  if (active && active !== player) {
    try {
      active.pause()
    } catch {
      // Player already released (screen unmounted in the middle) — nothing to pause.
    }
    const previous = preempted
    preempted = null
    previous?.()
  }
  active = player
  preempted = onPreempted ?? null
}

/** Gives the focus back, if it is still the owner (stopping a player that already lost the focus
 *  cannot drop the focus of whoever is playing now). */
export function releaseAudioFocus(player: AudioPlayer): void {
  if (active !== player) return
  active = null
  preempted = null
}
