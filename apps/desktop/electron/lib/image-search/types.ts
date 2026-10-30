import type { MediaCredit } from '@shared/media'

/**
 * Image search in OPEN sources — Wikimedia Commons and Openverse. Neither asks for a
 * key, and both return the license and the author of each image, which is what lets
 * the agent use the image in a piece with the right credit.
 */

export type ImageProvider = 'commons' | 'openverse'

/** What the agent asks about the license: `commercial` is the default (it serves a published video). */
export type LicenseFilter = 'commercial' | 'public-domain' | 'any'

export type Orientation = 'landscape' | 'portrait' | 'square'

export interface ImageResult {
  /** Short id the agent uses to import: `wc:123` (Commons) or `ov:<uuid>` (Openverse). */
  id: string
  provider: ImageProvider
  title: string
  width?: number
  height?: number
  /** Thumbnail for the quick look. */
  thumbUrl: string
  /** File to download (already at a reasonable size for video). */
  downloadUrl: string
  /** Alternative when the main address refuses (hotlink): the copy the provider serves. */
  fallbackUrl?: string
  credit: MediaCredit
  /** Which collection Openverse took it from (flickr, nasa…). */
  origin?: string
}

export interface SearchOptions {
  query: string
  /** How many images to return (1–12). */
  limit: number
  license: LicenseFilter
  providers: ImageProvider[]
  orientation?: Orientation
  /** Minimum width in px (video asks for more than a thumbnail). */
  minWidth: number
}

export interface SearchOutcome {
  results: ImageResult[]
  /** Warnings per provider that failed or was rate-limited — a partial search is still worth it. */
  warnings: string[]
}

/** Who makes the request: the global `fetch`, or a double in the tests. */
export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>
