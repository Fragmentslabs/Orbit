import { useEffect, useState } from 'react'
import type { MediaEntry } from '@orbit/shared'

import { kindOf } from '~/lib/media'

/**
 * Two questions the phone asks the desktop before handing a URL to a player:
 *
 *  - does the piece still exist? (an entry can outlive its piece: the folder was deleted, the
 *    registry cleaned — the open then answers 404);
 *  - is the video playable on iOS as it is? (AV1/VP9 downloads are not; the desktop makes an H.264
 *    copy on demand and tells how far it is — see `phone-video.ts` on the desktop.)
 */

export type PieceKind = 'motion' | 'design' | 'slides'

export function isPieceKind(kind: string): kind is PieceKind {
  return kind === 'motion' || kind === 'design' || kind === 'slides'
}

/** A piece the registry does not know any more: no URL at all (the desktop could not build one). */
export function isMissingPiece(entry: MediaEntry): boolean {
  return isPieceKind(kindOf(entry)) && !entry.url
}

/** 404/410 on open: the piece went away between the list and the tap. */
export function isGone(status: number): boolean {
  return status === 404 || status === 410
}

export type Availability = 'checking' | 'ok' | 'gone'

/** HEAD on the piece's address. Any answer but "gone" (including network errors) lets the viewer try. */
export function usePieceAvailability(url: string): Availability {
  const [state, setState] = useState<{ url: string; value: Availability }>({ url, value: 'checking' })
  useEffect(() => {
    let cancelled = false
    fetch(url, { method: 'HEAD' })
      .then((res) => {
        if (!cancelled) setState({ url, value: isGone(res.status) ? 'gone' : 'ok' })
      })
      .catch(() => {
        if (!cancelled) setState({ url, value: 'ok' })
      })
    return () => {
      cancelled = true
    }
  }, [url])
  return state.url === url ? state.value : 'checking'
}

// ---------------------------------------------------------------------------- video

export const VIDEO_STATE_FILE = '__orbit-video.json'

export type VideoPrep =
  | { state: 'checking' }
  | { state: 'ready' }
  | { state: 'preparing'; progress: number }
  | { state: 'failed'; message: string }

/** Address of the desktop's state of this video, or null when the URL is not one of the desktop's videos. */
export function videoStateUrl(url: string): string | null {
  const clean = url.split('?')[0].replace(/\/+$/, '')
  return /\/api\/file\/video\/[^/]+\/[^/]+$/.test(clean) ? `${clean}/${VIDEO_STATE_FILE}` : null
}

export function parseVideoPrep(body: unknown): VideoPrep {
  if (!body || typeof body !== 'object') return { state: 'ready' }
  const b = body as { state?: unknown; progress?: unknown; message?: unknown }
  if (b.state === 'preparing') {
    const progress = typeof b.progress === 'number' && Number.isFinite(b.progress) ? Math.min(1, Math.max(0, b.progress)) : 0
    return { state: 'preparing', progress }
  }
  if (b.state === 'failed') return { state: 'failed', message: typeof b.message === 'string' ? b.message : '' }
  return { state: 'ready' }
}

/**
 * Asks the desktop whether the video can be played now, polling while it is being prepared.
 * Anything that is not a desktop video, or a desktop that does not know the question (older
 * build: 404), counts as ready — the player then loads the URL as before.
 */
export function useVideoPreparation(url: string, pollMs = 1500): VideoPrep {
  const stateUrl = videoStateUrl(url)
  const [prep, setPrep] = useState<VideoPrep>(stateUrl ? { state: 'checking' } : { state: 'ready' })
  useEffect(() => {
    if (!stateUrl) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = async () => {
      let next: VideoPrep = { state: 'ready' }
      try {
        const res = await fetch(stateUrl, { headers: { 'Cache-Control': 'no-store' } })
        if (res.ok) next = parseVideoPrep(await res.json())
      } catch {
        // Cannot ask: let the player try.
      }
      if (cancelled) return
      setPrep(next)
      if (next.state === 'preparing') timer = setTimeout(tick, pollMs)
    }
    void tick()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [stateUrl, pollMs])
  return stateUrl ? prep : { state: 'ready' }
}
