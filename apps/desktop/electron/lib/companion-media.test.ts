import { describe, expect, it } from 'vitest'

import { rewriteMediaPart, rewriteMediaUrl, rewriteMessage, rewriteMessages } from './companion-media'
import type { ChatMessage, MessagePart } from '@shared/chat'

/**
 * The seam that breaks silently.
 *
 * The phone does not know Electron's schemes (`orbit-media://`,
 * `orbit-audio://`, `orbit-video://`, `orbit-artifact://`). If a part carries
 * one of those addresses and nobody rewrites it, the file simply does not show up in the
 * app — and nothing fails on the desktop, so the bug is only found by someone looking
 * at the phone. These tests exist so that a new part in that situation breaks
 * HERE, and not there.
 */

const BASE = 'http://192.168.0.10:3848'
const token = (scope: string, id: string) => `tok-${scope}-${id}`

function message(parts: MessagePart[]): ChatMessage {
  return { id: 'm1', role: 'assistant', parts, createdAt: 0 } as ChatMessage
}

describe('rewriteMediaUrl', () => {
  it('swaps the scheme for the signed HTTP', () => {
    expect(rewriteMediaUrl('orbit-media://img_abc.png', BASE, token)).toBe(
      `${BASE}/api/media/img_abc.png?t=tok-media-img_abc.png`,
    )
  })

  it('leaves alone what is not a media address', () => {
    // A data URL is already loadable by the app; rewriting it would spoil it.
    expect(rewriteMediaUrl('data:image/png;base64,AAAA', BASE, token)).toBeNull()
    expect(rewriteMediaUrl('https://example.com/a.png', BASE, token)).toBeNull()
    expect(rewriteMediaUrl(undefined, BASE, token)).toBeNull()
  })

  it('refuses an id outside the format we generate', () => {
    // Path traversal or a strange extension do not become a served URL.
    expect(rewriteMediaUrl('orbit-media://../secrets.png', BASE, token)).toBeNull()
    expect(rewriteMediaUrl('orbit-media://x.exe', BASE, token)).toBeNull()
  })
})

describe('rewriteMediaPart — image and attachment', () => {
  it('rewrites the image the assistant put in the answer', () => {
    const part = { id: 'p', type: 'image', src: 'orbit-media://img_a.png' } as MessagePart
    const out = rewriteMediaPart(part, BASE, token) as { src: string }
    expect(out.src).toBe(`${BASE}/api/media/img_a.png?t=tok-media-img_a.png`)
  })

  it('rewrites the mediaUrl of the attachment chip — the original photo', () => {
    // Without this the chip arrives with a raw orbit-media:// and the attachment shows up broken
    // on the phone, which is WORSE than it opening the small version.
    const part = {
      id: 'p',
      type: 'file',
      mime: 'image/png',
      url: 'data:image/webp;base64,THUMB',
      mediaUrl: 'orbit-media://img_b.png',
      chip: true,
    } as MessagePart
    const out = rewriteMediaPart(part, BASE, token) as { url: string; mediaUrl: string }
    expect(out.mediaUrl).toBe(`${BASE}/api/media/img_b.png?t=tok-media-img_b.png`)
    // And the embedded thumbnail stays intact: it is what the list draws.
    expect(out.url).toBe('data:image/webp;base64,THUMB')
  })

  it('a chip without mediaUrl (old attachment) is not touched', () => {
    const part = {
      id: 'p',
      type: 'file',
      mime: 'image/png',
      url: 'data:image/webp;base64,THUMB',
      chip: true,
    } as MessagePart
    expect(rewriteMediaPart(part, BASE, token)).toBeNull()
  })

  it('a part that carries no media goes straight through', () => {
    expect(rewriteMediaPart({ id: 'p', type: 'text', text: 'hi' } as MessagePart, BASE, token)).toBeNull()
  })
})

describe('rewriteMediaPart — audio and video', () => {
  it('rewrites the audio from audio_generate with the token in the path', () => {
    const part = {
      id: 'p',
      type: 'audio',
      src: 'orbit-audio://aud_abc123.wav',
      title: 'narration',
    } as MessagePart
    const out = rewriteMediaPart(part, BASE, token) as { src: string; title: string }
    expect(out.src).toBe(`${BASE}/api/file/audio/aud_abc123.wav/tok-audio-aud_abc123.wav`)
    // The rest of the part survives — the player shows the title.
    expect(out.title).toBe('narration')
  })

  it('rewrites the video from video_render', () => {
    const part = { id: 'p', type: 'video', src: 'orbit-video://vid_abc123' } as MessagePart
    const out = rewriteMediaPart(part, BASE, token) as { src: string }
    expect(out.src).toBe(`${BASE}/api/file/video/vid_abc123/tok-video-vid_abc123`)
  })

  it('does not invent a URL from an address that is not ours', () => {
    const audio = { id: 'p', type: 'audio', src: 'https://example.com/a.mp3' } as MessagePart
    const video = { id: 'p', type: 'video', src: 'data:video/mp4;base64,AA' } as MessagePart
    expect(rewriteMediaPart(audio, BASE, token)).toBeNull()
    expect(rewriteMediaPart(video, BASE, token)).toBeNull()
  })

  it('refuses an id outside the formats we generate', () => {
    // The prefix matters: the scope trusts it to find the file.
    const wrong = { id: 'p', type: 'audio', src: 'orbit-audio://whatever.wav' } as MessagePart
    const traversal = { id: 'p', type: 'video', src: 'orbit-video://../../etc/passwd' } as MessagePart
    expect(rewriteMediaPart(wrong, BASE, token)).toBeNull()
    expect(rewriteMediaPart(traversal, BASE, token)).toBeNull()
  })
})

describe('rewriteMediaPart — artifact and document', () => {
  it('rewrites the artifact page and the thumbnail', () => {
    const part = {
      id: 'p',
      type: 'artifact',
      src: 'orbit-artifact://art_abc.html',
      artifactId: 'art_abc.html',
      title: 'Dashboard',
      thumb: 'orbit-artifact://art_abc.png',
      revision: 2,
    } as MessagePart
    const out = rewriteMediaPart(part, BASE, token) as { src: string; thumb: string; title: string }
    expect(out.src).toBe(`${BASE}/api/file/artifact/art_abc.html/tok-artifact-art_abc.html`)
    expect(out.thumb).toBe(`${BASE}/api/file/artifact/art_abc.png/tok-artifact-art_abc.png`)
    expect(out.title).toBe('Dashboard')
  })

  it('an artifact without a thumbnail does not get an invented thumb', () => {
    const part = {
      id: 'p',
      type: 'artifact',
      src: 'orbit-artifact://art_xyz.html',
      artifactId: 'art_xyz.html',
      title: 'Sem thumb',
    } as MessagePart
    const out = rewriteMediaPart(part, BASE, token) as { thumb?: string }
    expect(out.thumb).toBeUndefined()
  })

  it('the document points at the HTML preview, not the Markdown', () => {
    const part = {
      id: 'p',
      type: 'document',
      documentId: 'doc_abc.md',
      title: 'Report',
      previewSrc: 'orbit-artifact://doc_abc.html',
      formats: [],
      thumb: 'orbit-artifact://doc_abc.png',
    } as MessagePart
    const out = rewriteMediaPart(part, BASE, token) as { previewSrc: string; thumb: string }
    expect(out.previewSrc).toBe(`${BASE}/api/file/artifact/doc_abc.html/tok-artifact-doc_abc.html`)
    expect(out.thumb).toBe(`${BASE}/api/file/artifact/doc_abc.png/tok-artifact-doc_abc.png`)
  })
})

describe('rewriteMessage / rewriteMessages', () => {
  it('returns null when nothing changed — the caller reuses the original', () => {
    const msg = message([{ id: 'p', type: 'text', text: 'hi' } as MessagePart])
    expect(rewriteMessage(msg, BASE, token)).toBeNull()
    expect(rewriteMessages([msg], BASE, token)).toBeNull()
  })

  it('rewrites all the parts with a file in the same message and preserves the rest', () => {
    const msg = message([
      { id: 'p1', type: 'text', text: 'here is the photo' } as MessagePart,
      { id: 'p2', type: 'image', src: 'orbit-media://img_a.png' } as MessagePart,
      {
        id: 'p3',
        type: 'file',
        mime: 'image/png',
        url: 'data:image/webp;base64,T',
        mediaUrl: 'orbit-media://img_b.png',
        chip: true,
      } as MessagePart,
      { id: 'p4', type: 'audio', src: 'orbit-audio://aud_z9.wav' } as MessagePart,
    ])
    const out = rewriteMessage(msg, BASE, token)!
    expect(out.parts[0]).toEqual(msg.parts[0])
    expect((out.parts[1] as { src: string }).src).toContain('/api/media/img_a.png')
    expect((out.parts[2] as { mediaUrl: string }).mediaUrl).toContain('/api/media/img_b.png')
    expect((out.parts[3] as { src: string }).src).toContain('/api/file/audio/aud_z9.wav/')
    // It does not mutate the original message: it stays the desktop's.
    expect((msg.parts[1] as { src: string }).src).toBe('orbit-media://img_a.png')
  })

  it('in a list, only the messages with a file are swapped', () => {
    const withoutMedia = message([{ id: 'a', type: 'text', text: 'hi' } as MessagePart])
    const withMedia = message([{ id: 'b', type: 'image', src: 'orbit-media://img_c.png' } as MessagePart])
    const withVideo = message([{ id: 'c', type: 'video', src: 'orbit-video://vid_q1' } as MessagePart])
    const out = rewriteMessages([withoutMedia, withMedia, withVideo], BASE, token)!
    expect(out[0]).toBe(withoutMedia)
    expect(out[1]).not.toBe(withMedia)
    expect(out[2]).not.toBe(withVideo)
  })
})
