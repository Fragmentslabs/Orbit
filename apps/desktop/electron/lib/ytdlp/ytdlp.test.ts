import { describe, expect, it, vi } from 'vitest'

/**
 * What can be proven without network and without the binary: the choice of the
 * official file per platform, the arguments the tool builds, the reading of the
 * yt-dlp JSON and the subtitle parser (including the scrolling window of the
 * automatic ones, which is where the text would come out stuttering).
 */

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/orbit-ytdlp-test', getAppPath: () => '/tmp', isPackaged: false },
}))

const { assetName, describeBinary, versionAgeDays } = await import('./binary')
const { buildDownloadArgs, infoArgs, looksStale, nameTemplate, searchArgs, searchQueryFromUrl, subtitleArgs, subtitleLangPattern, ytdlpError } = await import('./run')
const { describeInfo, describeSearch, durationText, parseInfo, videoHeights } = await import('./info')
const { cleanCueLine, cueText, matchLanguage, parseSubtitleFile, parseTimestamp, timestampedCues } = await import('./subtitles')

describe('assetName', () => {
  it('chooses the official release file per platform', () => {
    expect(assetName('darwin', 'arm64')).toBe('yt-dlp_macos')
    expect(assetName('darwin', 'x64')).toBe('yt-dlp_macos')
    expect(assetName('linux', 'x64')).toBe('yt-dlp_linux')
    expect(assetName('linux', 'arm64')).toBe('yt-dlp_linux_aarch64')
    expect(assetName('win32', 'x64')).toBe('yt-dlp.exe')
    expect(assetName('win32', 'arm64')).toBe('yt-dlp_arm64.exe')
    expect(assetName('freebsd', 'x64')).toBeNull()
  })
})

describe('argumentos do download', () => {
  const base = { url: 'https://example.com/v', output: '/tmp/x/%(title)s.%(ext)s' } as const

  it('limits the resolution with -f (the -S alone does not limit) and prefers mp4+m4a', () => {
    const args = buildDownloadArgs({ ...base, kind: 'video' })
    const filter = args[args.indexOf('-f') + 1]
    expect(filter).toContain('bv*[ext=mp4][height<=1080]+ba[ext=m4a]')
    expect(filter.endsWith('/b')).toBe(true)
    expect(args).toContain('res:1080,vcodec:h264')
    expect(args).toContain('--merge-output-format')
    expect(args).toContain('--no-playlist')
  })

  it('best imposes no ceiling and prefers h264 only as a tie-breaker', () => {
    const args = buildDownloadArgs({ ...base, kind: 'video', quality: 'best' })
    expect(args[args.indexOf('-f') + 1]).toBe('bv*[ext=mp4]+ba[ext=m4a]/bv*+ba/b')
    expect(args).toContain('res,vcodec:h264')
  })

  it('audio extracts the track and only re-encodes when a format was requested', () => {
    const best = buildDownloadArgs({ ...base, kind: 'audio', audioFormat: 'best' })
    expect(best).toContain('--audio-format')
    expect(best).toContain('best')
    expect(best).not.toContain('--audio-quality')

    const mp3 = buildDownloadArgs({ ...base, kind: 'audio', audioFormat: 'mp3' })
    expect(mp3[mp3.indexOf('--audio-format') + 1]).toBe('mp3')
    expect(mp3[mp3.indexOf('--audio-quality') + 1]).toBe('0')
    expect(mp3).toContain('--embed-metadata')
  })

  it('playlist, itens, teto de bytes e cookies viram argumentos', () => {
    const args = buildDownloadArgs({
      ...base,
      kind: 'video',
      playlist: true,
      playlistItems: '1-3',
      maxBytes: 25_000_000,
      cookiesFromBrowser: 'chrome',
    })
    expect(args).toContain('--yes-playlist')
    expect(args[args.indexOf('-I') + 1]).toBe('1-3')
    expect(args[args.indexOf('--max-filesize') + 1]).toBe('25000000')
    expect(args[args.indexOf('--cookies-from-browser') + 1]).toBe('chrome')
  })

  it('the playlist template numbers the entries', () => {
    expect(nameTemplate(false)).toBe('%(title).120B [%(id)s].%(ext)s')
    expect(nameTemplate(true)).toContain('%(playlist_index)03d')
  })

  it('playlist info lists without opening each item', () => {
    const args = infoArgs({ url: 'https://example.com/p', playlist: true })
    expect(args).toContain('-J')
    expect(args).toContain('--flat-playlist')
    expect(args).toContain('--playlist-end')
  })

  it('the subtitle pattern keeps the case and does not open a wildcard (avoids downloading 40 translations)', () => {
    expect(subtitleLangPattern(['pt-BR'])).toBe('pt-BR')
    expect(subtitleLangPattern(['pt', 'pt'])).toBe('pt')
    const args = subtitleArgs({ url: 'https://example.com/v', languages: ['pt-BR'], output: '/tmp/x/%(id)s.%(ext)s' })
    expect(args[args.indexOf('--sub-langs') + 1]).toBe('pt-BR')
    expect(args).toContain('--skip-download')
    expect(args).toContain('--write-auto-subs')
  })
})

describe('yt-dlp errors', () => {
  it('shows the ERROR lines, not the banner', () => {
    const text = ytdlpError({
      code: 1,
      stdout: '',
      stderr: 'WARNING: something\nERROR: [youtube] abc: Private video. Sign in\nERROR: second line',
    })
    expect(text).toContain('Private video')
    expect(text).toContain('second line')
    expect(text).not.toContain('WARNING')
  })

  it('with no ERROR, it returns the end of stderr', () => {
    expect(ytdlpError({ code: 2, stdout: '', stderr: 'line one\nline two' })).toBe('line one\nline two')
  })
})

describe('reading the JSON', () => {
  const info = {
    _type: 'video',
    extractor_key: 'Youtube',
    title: 'A talk',
    uploader: 'Someone',
    duration: 754,
    upload_date: '20240502',
    view_count: 1_234_567,
    like_count: 4200,
    formats: [
      { vcodec: 'avc1.640028', acodec: 'none', height: 1080, ext: 'mp4' },
      { vcodec: 'vp9', acodec: 'none', height: 2160, ext: 'webm' },
      { vcodec: 'none', acodec: 'mp4a.40.2', abr: 128, ext: 'm4a' },
    ],
    subtitles: { 'pt-BR': [{}], en: [{}] },
    automatic_captions: { en: [{}], es: [{}] },
    chapters: [
      { title: 'Intro', start_time: 0 },
      { title: 'Middle', start_time: 120 },
    ],
    description: 'A'.repeat(500),
    webpage_url: 'https://example.com/watch?v=1',
  }

  it('summarizes a video with what decides quality and transcript', () => {
    const text = describeInfo(parseInfo(JSON.stringify(info)))
    expect(text).toContain('Youtube: "A talk" by Someone')
    expect(text).toContain('Duration 12:34')
    expect(text).toContain('uploaded 2024-05-02')
    expect(text).toContain('1,234,567 views')
    expect(text).toContain('video up to 2160p (available: 1080, 2160)')
    expect(text).toContain('h264 available')
    expect(text).toContain('audio up to 128 kbps')
    expect(text).toContain('Subtitles: pt-BR, en · auto-generated: en, es')
    expect(text).toContain('Chapters (2): 0:00 Intro · 2:00 Middle')
    expect(text).toContain('Description: AAAA')
    expect(text).toContain('URL: https://example.com/watch?v=1')
    expect(text.endsWith('…')).toBe(false)
  })

  it('lists a playlist with index and link', () => {
    const playlist = {
      _type: 'playlist',
      title: 'Series',
      uploader: 'Channel',
      playlist_count: 2,
      entries: [
        { id: 'a', title: 'First', duration: 61, webpage_url: 'https://example.com/a' },
        { id: 'b', title: 'Second', duration: 62, url: 'https://example.com/b' },
      ],
    }
    const text = describeInfo(playlist)
    expect(text).toContain('Playlist: "Series" by Channel — 2 entries')
    expect(text).toContain('01. First (1:01) — https://example.com/a')
    expect(text).toContain('02. Second (1:02) — https://example.com/b')
    expect(text).toContain('playlist: true')
  })

  it('sorts and dedupes the resolutions', () => {
    expect(videoHeights(info.formats)).toEqual([1080, 2160])
    expect(durationText(3725)).toBe('1:02:05')
  })

  it('refuses an empty output instead of returning junk', () => {
    expect(() => parseInfo('   ')).toThrow(/returned nothing/)
  })
})

describe('legendas', () => {
  it('reads VTT, strips tags and entities', () => {
    const vtt = [
      'WEBVTT',
      '',
      '00:00:00.000 --> 00:00:02.000',
      '<v Roger>Tom &amp; Jerry</v>',
    ].join('\n')
    const cues = parseSubtitleFile(vtt, 'x.en.vtt')
    expect(cues).toHaveLength(1)
    expect(cues[0].text).toBe('Tom & Jerry')
    expect(cues[0].startMs).toBe(0)
    expect(cues[0].endMs).toBe(2000)
  })

  it('undoes the rolling window of the auto-generated subtitles', () => {
    const vtt = [
      'WEBVTT',
      '',
      '00:00:01.000 --> 00:00:03.000',
      'hello world',
      '',
      '00:00:03.000 --> 00:00:05.000',
      'hello world',
      'this is a test',
      '',
      '00:00:05.000 --> 00:00:07.000',
      'this is a test',
      'and more',
    ].join('\n')
    expect(cueText(parseSubtitleFile(vtt, 'x.en.vtt'))).toBe('hello world this is a test and more')
  })

  it('breaks the paragraph when the speech rests', () => {
    const vtt = [
      'WEBVTT',
      '',
      '00:00:01.000 --> 00:00:02.000',
      'first part',
      '',
      '00:00:06.000 --> 00:00:07.000',
      'second part',
    ].join('\n')
    expect(cueText(parseSubtitleFile(vtt, 'x.pt.vtt'))).toBe('first part\n\nsecond part')
  })

  it('reads SRT with a decimal comma and block index', () => {
    const srt = ['1', '00:00:01,000 --> 00:00:02,500', 'Hello, world.', '', '2', '00:00:03,000 --> 00:00:04,000', 'Second line.'].join('\n')
    const cues = parseSubtitleFile(srt, 'x.pt-BR.srt')
    expect(cues.map((cue) => cue.text)).toEqual(['Hello, world.', 'Second line.'])
    expect(timestampedCues(cues)).toBe('[0:01] Hello, world.\n[0:03] Second line.')
  })

  it('reads json3 (word by word) and ignores the line-break event', () => {
    const json3 = JSON.stringify({
      events: [
        { tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'hello' }] },
        { tStartMs: 600, dDurationMs: 1000, segs: [{ utf8: ' world' }] },
        { tStartMs: 1200, dDurationMs: 800, segs: [{ utf8: '\n' }] },
        { tStartMs: 2000, dDurationMs: 1000, segs: [{ utf8: 'bye' }] },
      ],
    })
    const cues = parseSubtitleFile(json3, 'x.en.json3')
    expect(cues).toHaveLength(3)
    expect(cueText(cues)).toBe('hello world bye')
    expect(timestampedCues(cues).split('\n')).toHaveLength(3)
  })

  it('returns empty for a format it cannot read (ass) instead of inventing', () => {
    expect(parseSubtitleFile('[Script Info]\nDialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,oi', 'x.pt.ass')).toEqual([])
  })

  it('cleans markup and entities on one line', () => {
    expect(cleanCueLine('<c.colorE5E5E5>Tom &amp; Jerry</c>')).toBe('Tom & Jerry')
    expect(cleanCueLine('{\\an8}linha')).toBe('linha')
  })

  it('matches the requested language with the family and falls back to the first available', () => {
    expect(matchLanguage(['pt-BR', 'en'], ['pt'])).toBe('pt-BR')
    expect(matchLanguage(['en', 'es'], ['pt'])).toBe('en')
    expect(matchLanguage(['pt-BR'], ['pt-br'])).toBe('pt-BR')
    expect(matchLanguage([], ['pt'])).toBeNull()
  })

  it('reads the times in the formats the sites use', () => {
    expect(parseTimestamp('00:01:02.345')).toBe(62_345)
    expect(parseTimestamp('01:02,345')).toBe(62_345)
    expect(parseTimestamp('00:00:02.000 align:start position:0%')).toBe(2000)
    expect(parseTimestamp('nada')).toBeNull()
  })
})

describe('old binary (retry with update)', () => {
  it('recognizes the errors a new release fixes', () => {
    expect(looksStale({ stdout: '', stderr: 'ERROR: [youtube] abc: Unable to extract player response' })).toBe(true)
    expect(looksStale({ stdout: '', stderr: 'ERROR: nsig extraction failed' })).toBe(true)
    expect(looksStale({ stdout: '', stderr: "ERROR: [youtube] x: Sign in to confirm you're not a bot" })).toBe(true)
    expect(looksStale({ stdout: '', stderr: 'ERROR: unable to download video data: HTTP Error 403: Forbidden' })).toBe(true)
    expect(looksStale({ stdout: '', stderr: 'ERROR: No video formats found!' })).toBe(true)
  })

  it('does not blame the binary for an error no update solves', () => {
    expect(looksStale({ stdout: '', stderr: 'ERROR: [youtube] abc: Private video. Sign in if you have access' })).toBe(false)
    expect(looksStale({ stdout: '', stderr: 'ERROR: Video unavailable' })).toBe(false)
    expect(looksStale({ stdout: '', stderr: 'ERROR: HTTP Error 429: Too Many Requests' })).toBe(false)
    expect(looksStale({ stdout: '', stderr: 'ERROR: Requested format is not available' })).toBe(false)
    expect(looksStale({ stdout: '', stderr: '' })).toBe(false)
  })

  it('tells in the error message what the update did', () => {
    const base = { code: 1, stdout: '', stderr: 'ERROR: Unable to extract player response\n' }

    const updated = ytdlpError({ ...base, refresh: { updated: true, from: '2025.01.01', to: '2026.10.24' } })
    expect(updated).toContain('Unable to extract player response')
    expect(updated).toContain('2025.01.01 → 2026.10.24')
    expect(updated).toContain('not a stale binary')

    const refused = ytdlpError({
      ...base,
      refresh: { updated: false, from: '2025.01.01', to: '2025.01.01', reason: 'managed by brew' },
    })
    expect(refused).toContain('not updated: managed by brew')
    expect(ytdlpError(base)).not.toContain('was not updated')
  })

  it('measures the age by the date yt-dlp uses as version', () => {
    const age = versionAgeDays('2026.10.24')
    expect(age).not.toBeNull()
    expect(age!).toBeGreaterThanOrEqual(0)
    expect(versionAgeDays('nightly')).toBeNull()
    expect(versionAgeDays(null)).toBeNull()
  })

  it('describes the origin and the age of the binary', () => {
    const managed = describeBinary({ bin: '/x/yt-dlp', source: 'managed' }, '2026.10.24')
    expect(managed).toContain('yt-dlp 2026.10.24')
    expect(managed).toContain('managed copy')
    expect(managed).toMatch(/days old/)
    expect(describeBinary({ bin: '/x/yt-dlp', source: 'path' }, null)).toContain('unknown version')
  })
})

describe('search', () => {
  it('searches through the ytsearch prefix, flat, without opening each video', () => {
    expect(searchArgs('  Kendrick   PRIDE ', 5)).toEqual(['ytsearch5:Kendrick PRIDE', '-J', '--flat-playlist'])
  })

  it('recognizes a YouTube results page as a search, not a video', () => {
    expect(searchQueryFromUrl('https://www.youtube.com/results?search_query=Kendrick+Lamar+PRIDE')).toBe('Kendrick Lamar PRIDE')
    expect(searchQueryFromUrl('https://www.youtube.com/watch?v=abc')).toBeNull()
    expect(searchQueryFromUrl('not a url')).toBeNull()
  })

  it('a single download never takes more than one item (a list read anyway cannot run on)', () => {
    const single = buildDownloadArgs({ url: 'https://example.com/v', output: '/tmp/x', kind: 'audio' })
    expect(single[single.indexOf('-I') + 1]).toBe('1')
    const list = buildDownloadArgs({ url: 'https://example.com/p', output: '/tmp/x', kind: 'audio', playlist: true })
    expect(list).not.toContain('-I')
  })

  it('lists each result with the URL to use next', () => {
    const text = describeSearch('pride', {
      entries: [{ id: 'abc', title: 'PRIDE.', channel: 'Kendrick Lamar', duration: 275, url: 'https://www.youtube.com/watch?v=abc' }],
    })
    expect(text).toContain('1. PRIDE. — Kendrick Lamar (4:35) — https://www.youtube.com/watch?v=abc')
    expect(describeSearch('nada', { entries: [] })).toMatch(/No results/)
  })
})
