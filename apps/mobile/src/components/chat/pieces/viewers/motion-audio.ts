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
  /** A bed that goes down by itself while the other (front) tracks play. */
  duck: boolean
  duckSettings: DuckSettings | null
  /** The author's volume curve: dB at each second OF THE PIECE. */
  automation: AutomationPoint[]
}

export interface DuckSettings {
  /** ms */
  attack: number
  /** ms */
  release: number
  ratio: number
}

export interface AutomationPoint {
  at: number
  db: number
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
      duck: track.duck === true,
      duckSettings: parseDuckSettings(track.duckSettings),
      automation: parseAutomation(track.automation),
    })
  }
  return tracks
}

function parseDuckSettings(value: unknown): DuckSettings | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  return { attack: Math.max(0, num(v.attack, 15)), release: Math.max(0, num(v.release, 350)), ratio: Math.max(1, num(v.ratio, 10)) }
}

function parseAutomation(value: unknown): AutomationPoint[] {
  if (!Array.isArray(value)) return []
  const points: AutomationPoint[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const p = item as Record<string, unknown>
    if (typeof p.at === 'number' && Number.isFinite(p.at) && typeof p.db === 'number' && Number.isFinite(p.db)) {
      points.push({ at: p.at, db: p.db })
    }
  }
  return points.sort((a, b) => a.at - b.at)
}

/**
 * What the page's `<video>` facts (`__orbitMotionSpec().videos`) become: the runtime mutes the
 * videos, so the phone plays their sound as tracks of its own. A video the author muted is skipped;
 * a source that is not an absolute http(s) URL cannot be played by the native player.
 */
export interface VideoFact {
  src?: unknown
  muted?: unknown
  loop?: unknown
  gain?: unknown
  start?: unknown
  in?: unknown
  end?: unknown
}

export function tracksFromVideoFacts(facts: unknown): AudioTrack[] {
  if (!Array.isArray(facts)) return []
  const seen = new Set<string>()
  const tracks: AudioTrack[] = []
  for (const raw of facts) {
    if (!raw || typeof raw !== 'object') continue
    const fact = raw as VideoFact
    if (fact.muted === true || typeof fact.src !== 'string' || !/^https?:\/\//i.test(fact.src)) continue
    const start = Math.max(0, num(fact.start, 0))
    const offset = Math.max(0, num(fact.in, 0))
    const end = typeof fact.end === 'number' && Number.isFinite(fact.end) && fact.end > start ? fact.end : null
    const key = [fact.src, start, offset, end, fact.loop === true].join('|')
    if (seen.has(key)) continue
    seen.add(key)
    tracks.push({
      name: fact.src.split('/').pop() ?? 'video',
      url: fact.src,
      start,
      end,
      offset,
      gainDb: num(fact.gain, 0),
      fadeIn: 0,
      fadeOut: 0,
      loop: fact.loop === true,
      duck: false,
      duckSettings: null,
      automation: [],
    })
  }
  return tracks
}

/** Gain (linear) of the author's volume curve at `time`: linear in dB between points, held outside them. */
export function automationGain(points: AutomationPoint[], time: number): number {
  if (!points.length) return 1
  if (time <= points[0].at) return Math.pow(10, points[0].db / 20)
  const last = points[points.length - 1]
  if (time >= last.at) return Math.pow(10, last.db / 20)
  for (let i = 1; i < points.length; i++) {
    const b = points[i]
    if (time <= b.at) {
      const a = points[i - 1]
      const span = b.at - a.at
      const db = span > 0 ? a.db + ((b.db - a.db) * (time - a.at)) / span : b.db
      return Math.pow(10, db / 20)
    }
  }
  return 1
}

/** How far a ducked bed goes down for a given ratio: ratio 10 (the default) is −14 dB. */
export function duckFloor(ratio: number): number {
  return Math.min(0.7, Math.max(0.1, 2 / Math.max(1, ratio)))
}

/**
 * Multiplier (0..1) of a ducking bed at `time`. The desktop compresses the bed by sidechain; the
 * phone has no compressor, so it approximates with an envelope: down to `duckFloor` over the
 * attack once a front track starts, back up over the release once the last one stops.
 * `fronts` are the [start, end] seconds of the non-duck tracks (end = Infinity when unknown).
 */
export function duckGain(settings: DuckSettings | null, fronts: [number, number][], time: number): number {
  const { attack, release, ratio } = settings ?? { attack: 15, release: 350, ratio: 10 }
  const floor = duckFloor(ratio)
  const atk = Math.max(0.001, attack / 1000)
  const rel = Math.max(0.001, release / 1000)
  let gain = 1
  for (const [s, e] of fronts) {
    let g = 1
    if (time < s) g = 1
    else if (time < s + atk) g = 1 - (1 - floor) * ((time - s) / atk)
    else if (time <= e) g = floor
    else if (time < e + rel) g = floor + (1 - floor) * ((time - e) / rel)
    gain = Math.min(gain, g)
  }
  return gain
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
export function trackVolume(track: AudioTrack, time: number, fileEnd: number | null, fronts: [number, number][] = []): number {
  let level = Math.min(1, Math.pow(10, track.gainDb / 20))
  level *= automationGain(track.automation, time)
  if (track.duck) level *= duckGain(track.duckSettings, fronts, time)
  const local = time - track.start
  if (track.fadeIn > 0 && local < track.fadeIn) level *= Math.max(0, local) / track.fadeIn
  const end = track.end ?? fileEnd
  if (track.fadeOut > 0 && end !== null) {
    const left = end - time
    if (left < track.fadeOut) level *= Math.max(0, left) / track.fadeOut
  }
  return Math.min(1, Math.max(0, level))
}

/** [start, end] of every track that is not a ducking bed — what the beds go down under. */
function frontsOf(tracks: AudioTrack[], players: Map<string, AudioPlayer>): [number, number][] {
  const fronts: [number, number][] = []
  for (const track of tracks) {
    if (track.duck) continue
    let end = track.end
    if (end === null) {
      const duration = players.get(track.url)?.duration
      end = typeof duration === 'number' && Number.isFinite(duration) && duration > 0 ? track.start - track.offset + duration : Infinity
    }
    fronts.push([track.start, end])
  }
  return fronts
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
        player.volume = trackVolume(track, position, duration > 0 ? track.start - track.offset + duration : null, frontsOf(tracks, players.current))
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
