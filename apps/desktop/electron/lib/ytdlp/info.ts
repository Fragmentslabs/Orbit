/**
 * Reading of the yt-dlp JSON (`-J`): what the agent needs to know BEFORE
 * downloading — title, duration, available resolutions, subtitle languages, chapters
 * and playlist size. It is what avoids downloading 4K when 720 will do and what says
 * whether the transcription can come from the subtitles instead of the audio.
 */

export interface YtdlpFormat {
  format_id?: string
  ext?: string
  vcodec?: string
  acodec?: string
  height?: number | null
  fps?: number | null
  abr?: number | null
  tbr?: number | null
  filesize?: number | null
  filesize_approx?: number | null
  format_note?: string
}

export interface YtdlpChapter {
  title?: string
  start_time?: number
  end_time?: number
}

export interface YtdlpEntry {
  id?: string
  title?: string
  duration?: number | null
  webpage_url?: string
  url?: string
  uploader?: string
  channel?: string
  _type?: string
  entries?: YtdlpEntry[]
}

export interface YtdlpInfo {
  _type?: string
  id?: string
  title?: string
  description?: string
  uploader?: string
  channel?: string
  extractor_key?: string
  extractor?: string
  webpage_url?: string
  original_url?: string
  duration?: number | null
  upload_date?: string
  view_count?: number | null
  like_count?: number | null
  comment_count?: number | null
  is_live?: boolean
  live_status?: string | null
  was_live?: boolean
  availability?: string | null
  age_limit?: number | null
  formats?: YtdlpFormat[]
  subtitles?: Record<string, unknown>
  automatic_captions?: Record<string, unknown>
  chapters?: YtdlpChapter[]
  entries?: YtdlpEntry[]
  playlist_count?: number | null
  n_entries?: number | null
}

export function parseInfo(stdout: string): YtdlpInfo {
  const text = stdout.trim()
  if (!text) throw new Error('yt-dlp returned nothing (the URL may not be a media page)')
  try {
    return JSON.parse(text) as YtdlpInfo
  } catch {
    throw new Error(`could not read yt-dlp's answer: ${text.slice(0, 200)}`)
  }
}

/** 7:05 / 1:02:09 — the way the user reads a duration (0 s is "0:00", not "?"). */
export function durationText(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(Number(seconds))) return '?'
  const total = Math.max(0, Math.round(Number(seconds)))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = String(total % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`
}

export function bytesText(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '?'
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function count(value: number | null | undefined): string {
  if (value === null || value === undefined) return '?'
  return new Intl.NumberFormat('en-US').format(value)
}

function dateText(uploadDate: string | undefined): string | null {
  if (!uploadDate || !/^\d{8}$/.test(uploadDate)) return null
  return `${uploadDate.slice(0, 4)}-${uploadDate.slice(4, 6)}-${uploadDate.slice(6, 8)}`
}

/** Available video resolutions, from the smallest to the largest (without repeating). */
export function videoHeights(formats: YtdlpFormat[] | undefined): number[] {
  const heights = (formats ?? [])
    .filter((f) => f.vcodec && f.vcodec !== 'none' && typeof f.height === 'number' && f.height > 0)
    .map((f) => f.height as number)
  return [...new Set(heights)].sort((a, b) => a - b)
}

/** The highest available audio bitrate (kbps) — the ceiling the file will have. */
export function bestAudioKbps(formats: YtdlpFormat[] | undefined): number | null {
  const rates = (formats ?? [])
    .filter((f) => f.acodec && f.acodec !== 'none' && typeof f.abr === 'number' && f.abr > 0)
    .map((f) => Math.round(f.abr as number))
  return rates.length ? Math.max(...rates) : null
}

export function hasH264(formats: YtdlpFormat[] | undefined): boolean {
  return (formats ?? []).some((f) => /^(avc|h264)/i.test(f.vcodec ?? ''))
}

function languageList(value: Record<string, unknown> | undefined, max = 12): string {
  const keys = Object.keys(value ?? {})
  if (!keys.length) return 'none'
  const shown = keys.slice(0, max).join(', ')
  return keys.length > max ? `${shown} (+${keys.length - max} more)` : shown
}

function chapterList(chapters: YtdlpChapter[] | undefined, max = 15): string {
  const items = (chapters ?? []).filter((c) => c.title)
  if (!items.length) return ''
  const shown = items.slice(0, max).map((c) => `${durationText(c.start_time)} ${c.title}`)
  const more = items.length > max ? ` (+${items.length - max} more)` : ''
  return `Chapters (${items.length}): ${shown.join(' · ')}${more}`
}

function describePlaylist(info: YtdlpInfo, maxEntries: number): string {
  const entries = info.entries ?? []
  const total = info.playlist_count ?? info.n_entries ?? entries.length
  const lines = [
    `Playlist: "${info.title ?? '(untitled)'}"${info.uploader ? ` by ${info.uploader}` : ''} — ${count(total)} entries` +
      (entries.length ? `, first ${Math.min(entries.length, maxEntries)} below` : ''),
  ]
  for (const [i, entry] of entries.slice(0, maxEntries).entries()) {
    const url = entry.webpage_url ?? entry.url ?? ''
    lines.push(`${String(i + 1).padStart(2, '0')}. ${entry.title ?? '(untitled)'} (${durationText(entry.duration)})${url ? ` — ${url}` : ''}`)
  }
  lines.push('Call ytdlp_download with playlist: true (and playlistItems, e.g. "1-10") to fetch them.')
  return lines.join('\n')
}

export function describeInfo(info: YtdlpInfo, opts: { maxEntries?: number } = {}): string {
  const maxEntries = opts.maxEntries ?? 25
  if (info._type === 'playlist' || (info.entries && info.entries.length && !info.formats?.length)) {
    return describePlaylist(info, maxEntries)
  }

  const site = info.extractor_key ?? info.extractor ?? 'site'
  const lines: string[] = [`${site}: "${info.title ?? '(untitled)'}"${info.uploader ? ` by ${info.uploader}` : ''}`]

  const facts: string[] = [`Duration ${durationText(info.duration)}`]
  const uploaded = dateText(info.upload_date)
  if (uploaded) facts.push(`uploaded ${uploaded}`)
  if (info.view_count !== null && info.view_count !== undefined) facts.push(`${count(info.view_count)} views`)
  if (info.like_count !== null && info.like_count !== undefined) facts.push(`${count(info.like_count)} likes`)
  lines.push(facts.join(' · '))

  const heights = videoHeights(info.formats)
  const video: string[] = []
  if (heights.length) video.push(`video up to ${heights[heights.length - 1]}p (available: ${heights.join(', ')})`)
  else if (info.formats?.length) video.push('no video stream (audio only)')
  if (heights.length) video.push(hasH264(info.formats) ? 'h264 available' : 'no h264 (av1/vp9 only — plays in the app, not in QuickTime)')
  const kbps = bestAudioKbps(info.formats)
  if (kbps) video.push(`audio up to ${kbps} kbps`)
  if (video.length) lines.push(video.join(' · '))

  if (info.is_live || info.live_status === 'is_live') lines.push('LIVE right now — a download records what has aired so far')
  else if (info.live_status === 'is_upcoming') lines.push('UPCOMING live event — nothing to download yet')
  if (info.availability && info.availability !== 'public') lines.push(`Availability: ${info.availability}`)
  if ((info.age_limit ?? 0) >= 18) lines.push('Age-restricted (18+) — may need cookiesFromBrowser')

  lines.push(`Subtitles: ${languageList(info.subtitles)} · auto-generated: ${languageList(info.automatic_captions)}`)
  const chapters = chapterList(info.chapters)
  if (chapters) lines.push(chapters)

  const description = (info.description ?? '').replace(/\s+/g, ' ').trim()
  if (description) lines.push(`Description: ${description.slice(0, 400)}${description.length > 400 ? '…' : ''}`)
  if (info.webpage_url) lines.push(`URL: ${info.webpage_url}`)

  return lines.join('\n')
}

/** Search results: one line per hit, with the link the next call must use. */
export function describeSearch(query: string, info: YtdlpInfo): string {
  const entries = (info.entries ?? []).filter((entry) => entry.webpage_url || entry.url || entry.id)
  if (!entries.length) return `No results for "${query}". Try other words (artist + title, without extra terms).`
  const lines = [`Search results for "${query}" (${entries.length}):`]
  for (const [i, entry] of entries.entries()) {
    const url = entry.webpage_url ?? entry.url ?? `https://www.youtube.com/watch?v=${entry.id}`
    const author = entry.uploader ?? entry.channel
    const by = author ? ` — ${author}` : ''
    lines.push(`${i + 1}. ${entry.title ?? '(untitled)'}${by} (${durationText(entry.duration)}) — ${url}`)
  }
  lines.push(
    'Pick the result that matches what the user asked for (official upload, right duration) and pass its URL to ytdlp_download / ytdlp_transcript. Say which one you picked.',
  )
  return lines.join('\n')
}
