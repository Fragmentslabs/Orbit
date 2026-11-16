import { describe, expect, it } from 'vitest'
import type { MediaEntry } from '@orbit/shared'

import { isGone, isMissingPiece, parseVideoPrep, videoStateUrl } from './media-availability'

const entry = (over: Partial<MediaEntry>) => ({ id: 'x', kind: 'motion', ...over }) as MediaEntry

describe('media availability', () => {
  it('treats 404 and 410 as a piece that is gone', () => {
    expect(isGone(404)).toBe(true)
    expect(isGone(410)).toBe(true)
    expect(isGone(200)).toBe(false)
    expect(isGone(500)).toBe(false)
  })
  it('a piece without a URL is missing; a plain file without one is not a piece', () => {
    expect(isMissingPiece(entry({ url: undefined }))).toBe(true)
    expect(isMissingPiece(entry({ url: 'http://h/api/file/motion/m/t' }))).toBe(false)
    expect(isMissingPiece(entry({ kind: 'video', url: undefined }))).toBe(false)
  })
  it('derives the video state address only for the desktop videos', () => {
    expect(videoStateUrl('http://h:1/api/file/video/vid_1/tok')).toBe('http://h:1/api/file/video/vid_1/tok/__orbit-video.json')
    expect(videoStateUrl('http://h:1/api/file/video/vid_1/tok/')).toBe('http://h:1/api/file/video/vid_1/tok/__orbit-video.json')
    expect(videoStateUrl('https://cdn.example.com/a.mp4')).toBeNull()
  })
  it('parses the desktop answer, defaulting to ready', () => {
    expect(parseVideoPrep({ state: 'preparing', progress: 0.4 })).toEqual({ state: 'preparing', progress: 0.4 })
    expect(parseVideoPrep({ state: 'preparing', progress: 7 })).toEqual({ state: 'preparing', progress: 1 })
    expect(parseVideoPrep({ state: 'failed', message: 'boom' })).toEqual({ state: 'failed', message: 'boom' })
    expect(parseVideoPrep({ state: 'ready' })).toEqual({ state: 'ready' })
    expect(parseVideoPrep(null)).toEqual({ state: 'ready' })
  })
})
