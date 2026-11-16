/**
 * The sound of a motion piece on the phone.
 *
 * The desktop resolves the tracks (manifest, loose file, gain, fades, offset) in one place and
 * the phone only plays what it receives: `GET <piece>/__orbit-audio.json` returns the list
 * already normalized. Everything below the hook is pure on purpose — which track sounds at a
 * given second, from which point of its file, at which level — so it is tested without a player.
 *
 * The piece has no clock of its own: the viewer's frame is the clock (the same one that
 * drives the page's `seek`), and the tracks follow it.
 */
import { createAudioPlayer, setAudioModeAsync, type AudioPlayer } from 'expo-audio'
import { useEffect, useRef } from 'react'

export interface AudioTrack {
  name: string
  /** Absolute URL, signed — the same token as the piece. */
  url: string
  /** Second of the piece where the track comes in / goes out (null = to the end of the file). */
  start: number
  end: number | null
  /** Second OF THE FILE where the sound begins. */
  offset: number
  gainDb: number
  fadeIn: number
  fadeOut: number
  loop: boolean
}

/** Marker the desktop reserves for the plan; the phone appends it to the piece's URL. */
export const AUDIO_PLAN_FILE = '__orbit-audio.json'

export function audioPlanUrl(pieceUrl: string): string {
  return `${pieceUrl.replace(/\/+$/, '')}/${AUDIO_PLAN_FILE}`
}

const num = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback

/** The plan as the desktop sent it, turned into tracks with a URL. Anything malformed is dropped. */
export function parseAudioPlan(body: unknown, pieceUrl: string): AudioTrack[] {
  if (!body || typeof body !== 'object') return []
  const raw = (body as { tracks?: unknown }).tracks
  if (!Array.isArray(raw)) return []
  const base = pieceUrl.replace(/\/+$/, '')
  const tracks: AudioTrack[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const track = entry as Record<string, unknown>
    if (typeof track.path !== 'string' || !track.path) continue
    tracks.push({
      name: typeof track.name === 'string' ? track.name : track.path,
      url: `${base}/${track.path}`,
      start: Math.max(0, num(track.start, 0)),
      end: typeof track.end === 'number' && Number.isFinite(track.end) ? track.end : null,
      offset: Math.max(0, num(track.offset, 0)),
      gainDb: num(track.gainDb, 0),
      fadeIn: Math.max(0, num(track.fadeIn, 0)),
      fadeOut: Math.max(0, num(track.fadeOut, 0)),
      loop: track.loop === true,
    })
  }
  return tracks
}

/**
 * Where in its FILE the track should be at `time` seconds of the piece; null when it is
 * silent then (before it comes in, or after it goes out). `fileDuration` only matters for a
 * looped track, which wraps around it.
 */
export function trackPosition(track: AudioTrack, time: number, fileDuration = 0): number | null {
  if (time < track.start) return null
  if (track.end !== null && time >= track.end) return null
  const into = time - track.start + track.offset
  if (track.loop && fileDuration > 0 && fileDuration > track.offset) {
    return track.offset + ((into - track.offset) % (fileDuration - track.offset))
  }
  // Past the end of the file there is nothing left to hear.
  if (fileDuration > 0 && into >= fileDuration) return null
  return into
}

/**
 * Level 0..1 at `time`. The desktop applies the gain in dB and the in/out ramps; the player's
 * volume cannot go above 1, so a boost is clipped to unity (a track at +6 dB plays as it is).
 * `fileEnd` closes the fade-out of a track that declares no end.
 */
export function trackVolume(track: AudioTrack, time: number, fileEnd: number | null): number {
  let level = Math.min(1, Math.pow(10, track.gainDb / 20))
  const local = time - track.start
  if (track.fadeIn > 0 && local < track.fadeIn) level *= Math.max(0, local) / track.fadeIn
  const end = track.end ?? fileEnd
  if (track.fadeOut > 0 && end !== null) {
    const left = end - time
    if (left < track.fadeOut) level *= Math.max(0, left) / track.fadeOut
  }
  return Math.min(1, Math.max(0, level))
}

/** How far the player may drift from where it should be before it is moved (seconds). */
export const DRIFT = 0.3

/**
 * Plays the tracks following the viewer's clock.
 *
 * `position` is the piece's time in seconds, `playing` whether the clock is running. A jump
 * larger than the drift (the person dragged the ruler, the loop wrapped around) moves the
 * players; otherwise they are left to run — nudging every frame would stutter.
 */
export function useMotionAudio(tracks: AudioTrack[], playing: boolean, position: number) {
  const players = useRef(new Map<string, AudioPlayer>())
  const last = useRef({ position, playing })
  // When each player was last moved: until the seek lands, `currentTime` is stale and would read as drift.
  const moved = useRef(new Map<string, number>())

  // One native player per track, created when the plan arrives and released with the viewer.
  useEffect(() => {
    if (!tracks.length) return
    void setAudioModeAsync({ playsInSilentMode: true }).catch(() => {})
    const mine = players.current
    for (const track of tracks) {
      const player = createAudioPlayer({ uri: track.url })
      player.volume = 0
      mine.set(track.url, player)
    }
    return () => {
      for (const player of mine.values()) {
        try {
          player.pause()
          player.remove()
        } catch {
          // Already released by the native side.
        }
      }
      mine.clear()
    }
  }, [tracks])

  useEffect(() => {
    const jumped = Math.abs(position - last.current.position) > DRIFT
    const toggled = playing !== last.current.playing
    last.current = { position, playing }

    for (const track of tracks) {
      const player = players.current.get(track.url)
      if (!player) continue
      try {
        const duration = Number.isFinite(player.duration) ? player.duration : 0
        const where = trackPosition(track, position, duration)
        if (!playing || where === null) {
          if (player.playing) player.pause()
          // Scrubbing while paused still lands the player on the right spot for the next play.
          if (where !== null && (jumped || toggled)) void player.seekTo(where)
          continue
        }
        player.volume = trackVolume(track, position, duration > 0 ? track.start - track.offset + duration : null)
        const settling = Date.now() - (moved.current.get(track.url) ?? 0) < 600
        const drift = settling ? 0 : Math.abs(player.currentTime - where)
        if (jumped || toggled || drift > DRIFT) {
          moved.current.set(track.url, Date.now())
          void player.seekTo(where)
        }
        if (!player.playing) player.play()
      } catch {
        // A player that failed to load stays silent; the picture keeps going.
      }
    }
  }, [tracks, playing, position])
}
