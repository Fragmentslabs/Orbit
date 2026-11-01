import { describe, expect, it } from 'vitest'
import {
  nativeScaleEmulation,
  MAX_MOTION_BANDS,
  assertFrameBytes,
  audioExtractFfmpegArgs,
  bandCount,
  concatFfmpegArgs,
  concatList,
  expectedFrameBytes,
  isMotionAudioFile,
  isPlainAudioEvent,
  isPlainAudioMix,
  motionAudioCodec,
  motionAudioFfmpegArgs,
  motionAudioMixFfmpegArgs,
  motionEncoderArgs,
  motionFfmpegArgs,
  motionFormatExt,
  motionFormatFor,
  normalizeMotionFormat,
  rawVideoFilters,
  splitBands,
  unpremultiplyBgra,
} from './motion-render-args'

/** Arguments of one track with the frame at the capture size (no HiDPI). */
function args(format: Parameters<typeof motionFfmpegArgs>[0]['format'], capture = { width: 1920, height: 1080 }) {
  return motionFfmpegArgs({
    width: 1920,
    height: 1080,
    captureWidth: capture.width,
    captureHeight: capture.height,
    fps: 30,
    format,
    output: 'out.mp4',
  })
}

/** A BGRA buffer from pixels [b, g, r, a]. */
function bgra(pixels: Array<[number, number, number, number]>): Buffer {
  const buffer = Buffer.alloc(pixels.length * 4)
  pixels.forEach(([b, g, r, a], i) => {
    buffer[i * 4] = b
    buffer[i * 4 + 1] = g
    buffer[i * 4 + 2] = r
    buffer[i * 4 + 3] = a
  })
  return buffer
}

const pixel = (buffer: Buffer, i = 0): number[] => [buffer[i * 4], buffer[i * 4 + 1], buffer[i * 4 + 2], buffer[i * 4 + 3]]

describe('output format', () => {
  it('motionFormatFor derives from the file + transparency', () => {
    expect(motionFormatFor('out.mp4', false)).toBe('mp4')
    expect(motionFormatFor('out.webm', false)).toBe('webm')
    // `.mov` without transparency is still H.264, as before.
    expect(motionFormatFor('out.mov', false)).toBe('mp4')
    expect(motionFormatFor('out.mov', true)).toBe('mov-alpha')
    expect(motionFormatFor('out.webm', true)).toBe('webm-alpha')
    expect(() => motionFormatFor('out.mp4', true)).toThrow(/transparent output/)
  })

  it('normalizeMotionFormat accepts the frozen contract and the old names', () => {
    expect(normalizeMotionFormat(undefined)).toBe('mp4')
    expect(normalizeMotionFormat('mp4')).toBe('mp4')
    expect(normalizeMotionFormat('mov-alpha')).toBe('mov-alpha')
    expect(normalizeMotionFormat('webm-alpha')).toBe('webm-alpha')
    // Old IPC names.
    expect(normalizeMotionFormat('mov')).toBe('mov-alpha')
    expect(normalizeMotionFormat('webm')).toBe('webm')
    expect(normalizeMotionFormat('webm', true)).toBe('webm-alpha')
    // The `-alpha` name rules, even without the transparency flag.
    expect(normalizeMotionFormat('webm-alpha', false)).toBe('webm-alpha')
    expect(() => normalizeMotionFormat('gif')).toThrow(/unsupported motion format: gif/)
  })

  it('extension and pixel format of each output', () => {
    expect(motionFormatExt('mp4')).toBe('.mp4')
    expect(motionFormatExt('mov-alpha')).toBe('.mov')
    expect(motionFormatExt('webm')).toBe('.webm')
    expect(motionFormatExt('webm-alpha')).toBe('.webm')
  })
})

describe('argumentos do ffmpeg', () => {
  it('raw: stdin is rawvideo BGRA with the capture size, no PNG', () => {
    const line = args('mp4').join(' ')
    expect(line).toContain('-f rawvideo -pix_fmt bgra -s 1920x1080 -framerate 30 -i pipe:0')
    // The old path (PNG per frame) cannot be left anywhere.
    expect(line).not.toContain('png')
    expect(line).not.toContain('image2pipe')
    // Capture already at the final size: no scale.
    expect(args('mp4')).not.toContain('-vf')
    expect(line).toContain('-c:v libx264 -preset medium -crf 18 -pix_fmt yuv420p -movflags +faststart')
    expect(args('mp4').at(-1)).toBe('out.mp4')
  })

  it('HiDPI: scales the larger capture down to the final video size', () => {
    const filters = rawVideoFilters({
      width: 1920,
      height: 1080,
      captureWidth: 3840,
      captureHeight: 2160,
      format: 'mp4',
    })
    expect(filters).toEqual(['scale=1920:1080:flags=lanczos'])
    expect(args('mp4', { width: 3840, height: 2160 }).join(' ')).toContain('-vf scale=1920:1080:flags=lanczos')
  })

  it('alpha: the format with alpha enters the filter and the encoder asks for the alpha plane', () => {
    expect(rawVideoFilters({ width: 100, height: 100, captureWidth: 100, captureHeight: 100, format: 'mov-alpha' })).toEqual([
      'format=yuva444p10le',
    ])
    expect(
      rawVideoFilters({ width: 100, height: 100, captureWidth: 100, captureHeight: 100, format: 'webm-alpha' }),
    ).toEqual(['format=yuva420p'])

    const mov = args('mov-alpha').join(' ')
    expect(mov).toContain('-vf format=yuva444p10le')
    expect(mov).toContain('-c:v prores_ks -profile:v 4444 -pix_fmt yuva444p10le')

    const webm = args('webm-alpha').join(' ')
    expect(webm).toContain('-vf format=yuva420p')
    expect(webm).toContain('-c:v libvpx-vp9 -pix_fmt yuva420p -b:v 0 -crf 28 -row-mt 1')

    // The unpremultiplication is NOT a filter: this ffmpeg's `unpremultiply` has two
    // inputs and refuses the simple graph. It happens in the buffer, before this.
    expect(mov).not.toContain('unpremultiply')
    expect(webm).not.toContain('unpremultiply')
  })

  it('HiDPI in transparent mode: scales before the format conversion', () => {
    expect(
      rawVideoFilters({ width: 100, height: 50, captureWidth: 200, captureHeight: 100, format: 'mov-alpha' }),
    ).toEqual(['scale=100:50:flags=lanczos', 'format=yuva444p10le'])
  })

  it('with no alpha there is no filter at all (not even un-premultiply)', () => {
    expect(rawVideoFilters({ width: 10, height: 10, captureWidth: 10, captureHeight: 10, format: 'mp4' })).toEqual([])
    expect(rawVideoFilters({ width: 10, height: 10, captureWidth: 10, captureHeight: 10, format: 'webm' })).toEqual([])
    expect(motionEncoderArgs('webm').join(' ')).toContain('libvpx-vp9 -pix_fmt yuv420p')
  })

  it('quality changes the CRF and the preset, and the default stays the previous one', () => {
    // `balanced` is the behavior that always existed: whoever chooses nothing
    // sees no difference in the file.
    expect(motionEncoderArgs('mp4').join(' ')).toBe(
      motionEncoderArgs('mp4', 'balanced').join(' '),
    )
    expect(motionEncoderArgs('mp4', 'balanced').join(' ')).toContain('-preset medium -crf 18')
    expect(motionEncoderArgs('mp4', 'high').join(' ')).toContain('-preset slow -crf 16')
    expect(motionEncoderArgs('mp4', 'small').join(' ')).toContain('-preset fast -crf 26')
    // VP9: only the CRF changes (the preset is the same path).
    expect(motionEncoderArgs('webm', 'high').join(' ')).toContain('-crf 24')
    expect(motionEncoderArgs('webm', 'small').join(' ')).toContain('-crf 36')
    // ProRes 4444 has no CRF: the choice cannot invent an invalid argument.
    expect(motionEncoderArgs('mov-alpha', 'small').join(' ')).toBe(motionEncoderArgs('mov-alpha').join(' '))
  })

  it('the separate audio extracts from the FINAL FILE (without touching the image)', () => {
    expect(audioExtractFfmpegArgs({ video: '/tmp/a.mp4', output: '/tmp/a.wav' }).join(' ')).toBe(
      '-v error -i /tmp/a.mp4 -vn -c:a pcm_s16le -ar 48000 /tmp/a.wav',
    )
  })
})

describe('quadro cru', () => {
  it('a BGRA frame has width × height × 4 bytes', () => {
    expect(expectedFrameBytes(1920, 1080)).toBe(8_294_400)
    expect(expectedFrameBytes(3840, 2160)).toBe(33_177_600)
  })

  it('assertFrameBytes accepts the exact size and fails loudly on any other', () => {
    expect(() => assertFrameBytes(8_294_400, 1920, 1080, 0)).not.toThrow()
    // One frame more or less would misalign the whole stdin, silently.
    expect(() => assertFrameBytes(8_294_404, 1920, 1080, 3)).toThrow(/frame 3 came with 8294404 bytes, expected 1920x1080x4 = 8294400/)
    expect(() => assertFrameBytes(8_294_399, 1920, 1080, 7)).toThrow(/frame 7/)
  })
})

describe('alpha un-premultiply', () => {
  it('becomes straight color: (200,100,50) at 50% arrives premultiplied and leaves straight', () => {
    // Chromium delivers it like this: straight color (200,100,50) with alpha 128 => (100,50,25,128).
    const buffer = bgra([[25, 50, 100, 128]])
    unpremultiplyBgra(buffer)
    expect(pixel(buffer)).toEqual([50, 100, 199, 128])
  })

  it('does not touch an opaque pixel nor an empty one', () => {
    const buffer = bgra([
      [10, 20, 30, 255],
      [0, 0, 0, 0],
      [200, 100, 50, 255],
    ])
    const before = Buffer.from(buffer)
    unpremultiplyBgra(buffer)
    expect(buffer.equals(before)).toBe(true)
  })

  it('un-premultiplies pixel by pixel, without contaminating the neighbors', () => {
    const buffer = bgra([
      [25, 50, 100, 128],
      [200, 100, 50, 255],
      [0, 25, 50, 64],
    ])
    unpremultiplyBgra(buffer)
    expect(pixel(buffer, 0)).toEqual([50, 100, 199, 128])
    expect(pixel(buffer, 1)).toEqual([200, 100, 50, 255])
    // alpha 64 => factor 1020: 0, 25 and 50 become 0, 100 and 199.
    expect(pixel(buffer, 2)).toEqual([0, 100, 199, 64])
  })

  it('clamps at 255 instead of overflowing the byte (color larger than alpha)', () => {
    // Truly premultiplied data never has color > alpha, but crooked data cannot
    // become a wrapped byte (255 would give 65025, which in a Uint8Array would become 0).
    const buffer = bgra([[255, 255, 255, 1]])
    unpremultiplyBgra(buffer)
    expect(pixel(buffer)).toEqual([255, 255, 255, 1])
  })

  it('does not read past the buffer when the frame has an odd pixel count', () => {
    const buffer = bgra([[25, 50, 100, 128], [25, 50, 100, 128]])
    expect(() => unpremultiplyBgra(buffer)).not.toThrow()
    expect(buffer.length).toBe(8)
  })
})

describe('faixas', () => {
  it('bandCount: cores/2 when automatic, a ceiling of 4, and the explicit escape wins', () => {
    expect(bandCount(undefined, 2)).toBe(1)
    expect(bandCount(undefined, 8)).toBe(4)
    expect(bandCount(undefined, 32)).toBe(MAX_MOTION_BANDS)
    // A single core (or an odd `cores`) never zeroes the render.
    expect(bandCount(undefined, 1)).toBe(1)
    expect(bandCount(undefined, 0)).toBe(1)
    // Escape hatch: 1 is the sequential path; above the ceiling it is clamped to the ceiling.
    expect(bandCount(1, 8)).toBe(1)
    expect(bandCount(2, 8)).toBe(2)
    expect(bandCount(9, 8)).toBe(MAX_MOTION_BANDS)
    expect(bandCount(0, 8)).toBe(1)
  })

  it('splitBands covers [0, total) with no hole and no overlap', () => {
    expect(splitBands(10, 3)).toEqual([
      { start: 0, end: 4 },
      { start: 4, end: 7 },
      { start: 7, end: 10 },
    ])
    expect(splitBands(5, 4)).toEqual([
      { start: 0, end: 2 },
      { start: 2, end: 3 },
      { start: 3, end: 4 },
      { start: 4, end: 5 },
    ])
    // Fewer frames than tracks: never creates an empty track.
    expect(splitBands(3, 4)).toEqual([
      { start: 0, end: 1 },
      { start: 1, end: 2 },
      { start: 2, end: 3 },
    ])
    // `bands: 1` is the sequential path: one track with the whole video.
    expect(splitBands(300, 1)).toEqual([{ start: 0, end: 300 }])
    expect(splitBands(1, 4)).toEqual([{ start: 0, end: 1 }])
  })

  it('the bands add up exactly to the total, in any combination', () => {
    for (let total = 1; total <= 40; total++) {
      for (let bands = 1; bands <= 6; bands++) {
        const ranges = splitBands(total, bands)
        expect(ranges[0].start).toBe(0)
        expect(ranges.at(-1)?.end).toBe(total)
        let expected = 0
        for (const [i, band] of ranges.entries()) {
          expect(band.start).toBe(expected)
          expect(band.end).toBeGreaterThan(band.start)
          expected = band.end
          if (i) expect(band.end - band.start).toBeLessThanOrEqual(ranges[0].end - ranges[0].start)
        }
      }
    }
  })
})

describe('concatenation of the bands', () => {
  it('concatList writes one `file` per segment, in order', () => {
    expect(concatList(['band_000.mp4', 'band_001.mp4'])).toBe("file 'band_000.mp4'\nfile 'band_001.mp4'")
  })

  it('concatFfmpegArgs copies the segments and gives faststart back to the mp4', () => {
    const mp4 = concatFfmpegArgs({ listFile: 'list.txt', output: 'out.mp4', format: 'mp4' }).join(' ')
    expect(mp4).toContain('-f concat -safe 0 -i list.txt')
    expect(mp4).toContain('-c copy')
    expect(mp4).toContain('-movflags +faststart')
    expect(mp4.endsWith('out.mp4')).toBe(true)

    // No second loss in any format: the segment already came out of the final encoder.
    const webm = concatFfmpegArgs({ listFile: 'list.txt', output: 'out.webm', format: 'webm-alpha' }).join(' ')
    expect(webm).toContain('-c copy')
    expect(webm).not.toContain('-c:v')
    expect(webm).not.toContain('movflags')
  })
})

describe('piece audio', () => {
  it('recognizes audio by the extension', () => {
    expect(isMotionAudioFile('audio.mp3')).toBe(true)
    expect(isMotionAudioFile('VOZ.WAV')).toBe(true)
    expect(isMotionAudioFile('trilha.m4a')).toBe(true)
    expect(isMotionAudioFile('trilha.flac')).toBe(true)
    expect(isMotionAudioFile('index.html')).toBe(false)
    expect(isMotionAudioFile('clipe.mp4')).toBe(false)
    expect(isMotionAudioFile('audio')).toBe(false)
  })

  it('the codec follows the container, not taste', () => {
    expect(motionAudioCodec('mp4')).toEqual(['-c:a', 'aac', '-b:a', '192k'])
    expect(motionAudioCodec('mov-alpha')).toEqual(['-c:a', 'aac', '-b:a', '192k'])
    expect(motionAudioCodec('webm')).toEqual(['-c:a', 'libopus', '-b:a', '128k'])
    expect(motionAudioCodec('webm-alpha')).toEqual(['-c:a', 'libopus', '-b:a', '128k'])
  })

  it('the mux copies the video, encodes only the sound and pins the length to the piece', () => {
    const args = motionAudioFfmpegArgs({
      video: 'video.mp4',
      audio: 'voz.wav',
      output: 'out.mp4',
      duration: 5.5,
      format: 'mp4',
    }).join(' ')
    expect(args).toContain('-i video.mp4 -i voz.wav')
    expect(args).toContain('-map 0:v:0 -map 1:a:0')
    expect(args).toContain('-c:v copy')
    expect(args).toContain('-c:a aac')
    expect(args).toContain('-t 5.500')
    expect(args).toContain('-movflags +faststart')
    expect(args.endsWith('out.mp4')).toBe(true)
  })

  it('never uses -shortest: short audio must not shorten the video', () => {
    const webm = motionAudioFfmpegArgs({
      video: 'video.webm',
      audio: 'voz.mp3',
      output: 'out.webm',
      duration: 3,
      format: 'webm-alpha',
    }).join(' ')
    expect(webm).not.toContain('-shortest')
    expect(webm).toContain('-c:a libopus')
    expect(webm).not.toContain('movflags')
  })

  /** The filter graph of the arguments (the string right after -filter_complex). */
  type MixEvents = Parameters<typeof motionAudioMixFfmpegArgs>[0]['events']
  const graphOf = (events: MixEvents, duration = 8): string => {
    const args = motionAudioMixFfmpegArgs({ video: 'video.mp4', output: 'out.mp4', duration, format: 'mp4', events })
    return args[args.indexOf('-filter_complex') + 1] ?? ''
  }

  it('the simple case does not pay for the filter graph', () => {
    expect(isPlainAudioEvent({ file: 'a.wav', start: 0, gainDb: 0, fadeIn: 0, fadeOut: 0, duck: false })).toBe(true)
    expect(isPlainAudioEvent({ file: 'a.wav', start: 2, gainDb: 0, fadeIn: 0, fadeOut: 0, duck: false })).toBe(false)
    expect(isPlainAudioEvent({ file: 'a.wav', start: 0, gainDb: -6, fadeIn: 0, fadeOut: 0, duck: false })).toBe(false)
    expect(isPlainAudioEvent({ file: 'a.wav', start: 0, gainDb: 0, fadeIn: 0, fadeOut: 0, duck: true })).toBe(false)
  })

  it('each track enters at its own instant, with level and ramps', () => {
    const graph = graphOf([
      { file: 'voz.wav', start: 0, gainDb: 0, fadeIn: 0, fadeOut: 0, duck: false },
      { file: 'cama.wav', start: 1.5, gainDb: -18, fadeIn: 0.5, fadeOut: 1, duck: true },
    ])
    // `all=1` covers mono and stereo: without it a mono file would come out mute.
    expect(graph).toContain('adelay=1500:all=1')
    expect(graph).toContain('volume=-18.00dB')
    expect(graph).toContain('afade=in:st=0:d=0.500')
    // The out ramp starts at the end of the PIECE (8s), not at the end of the file: the
    // length is the composition's.
    expect(graph).toContain('afade=out:st=5.500:d=1.000')
    expect(graph).toContain('[1:a]')
  })

  it('amix NEVER normalizes: the narration must not drop because there is music', () => {
    const graph = graphOf([
      { file: 'a.wav', start: 0, gainDb: 0, fadeIn: 0, fadeOut: 0, duck: false },
      { file: 'b.wav', start: 0, gainDb: 0, fadeIn: 0, fadeOut: 0, duck: false },
    ])
    expect(graph).toContain('amix=inputs=2:normalize=0')
    // The `duration=first` of the EDL render would cut the mix at the FIRST track: here
    // it may be a half-second effect, and it cannot rule over the rest.
    expect(graph).not.toContain('duration=first')
  })

  it('the bed lowers under the sum of the front tracks (the same duck as the EDL)', () => {
    const graph = graphOf([
      { file: 'voz.wav', start: 0, gainDb: 0, fadeIn: 0, fadeOut: 0, duck: false },
      { file: 'efeito.wav', start: 3, gainDb: -6, fadeIn: 0, fadeOut: 0, duck: false },
      { file: 'cama.wav', start: 0, gainDb: -18, fadeIn: 0, fadeOut: 0, duck: true },
    ])
    // The front is summed and SPLIT: one copy goes to the mix, another triggers the duck.
    expect(graph).toContain('[t0][t1]amix=inputs=2:normalize=0:dropout_transition=0[front]')
    expect(graph).toContain('[front]asplit=2[frontmix][frontsc]')
    expect(graph).toContain('sidechaincompress=threshold=0.02:ratio=10:attack=15:release=350')
    expect(graph).toContain('[bedducked][frontmix]amix=inputs=2:normalize=0:dropout_transition=0[mix]')
  })

  it('with no bed there is no duck, and a single track goes through no amix at all', () => {
    const sum = graphOf([
      { file: 'a.wav', start: 0, gainDb: 0, fadeIn: 0, fadeOut: 0, duck: false },
      { file: 'b.wav', start: 2, gainDb: 0, fadeIn: 0, fadeOut: 0, duck: false },
    ])
    expect(sum).toContain('amix=inputs=2')
    expect(sum).not.toContain('sidechaincompress')

    const single = motionAudioMixFfmpegArgs({
      video: 'v.mp4',
      output: 'o.mp4',
      duration: 5,
      format: 'mp4',
      events: [{ file: 'voz.wav', start: 1, gainDb: -3, fadeIn: 0, fadeOut: 0, duck: false }],
    }).join(' ')
    expect(single).toContain('-map [t0]')
    expect(single).not.toContain('amix')
  })

  it('the track treatment enters before the level, and the volume curve after the delay', () => {
    const graph = graphOf([
      {
        file: 'voz.wav',
        start: 2,
        gainDb: -3,
        fadeIn: 0,
        fadeOut: 0,
        duck: false,
        fx: {
          highpass: 80,
          eq: [{ freq: 3500, gain: 2, q: 1 }],
          compress: { threshold: -20, ratio: 3, attack: 8, release: 200, makeup: 0 },
          automation: [
            { at: 0, db: -20 },
            { at: 4, db: 0 },
          ],
        },
      },
    ])
    const chain = graph.split(';')[0]
    const order = ['highpass=f=80', 'equalizer=', 'acompressor=', 'volume=-3.00dB', 'adelay=2000:all=1', "volume='pow(10"]
    const at = order.map((piece) => chain.indexOf(piece))
    expect(at.every((i) => i >= 0)).toBe(true)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
  })

  it('a track with treatment is no longer the simple case', () => {
    const plain = { file: 'a.wav', start: 0, gainDb: 0, fadeIn: 0, fadeOut: 0, duck: false }
    expect(isPlainAudioEvent({ ...plain, fx: { eq: [], automation: [] } })).toBe(true)
    expect(isPlainAudioEvent({ ...plain, fx: { highpass: 80, eq: [], automation: [] } })).toBe(false)
  })

  it('the finish turns even a single track into a mix, and its output is the graph one', () => {
    const plain = { file: 'a.wav', start: 0, gainDb: 0, fadeIn: 0, fadeOut: 0, duck: false }
    expect(isPlainAudioMix([plain])).toBe(true)
    expect(isPlainAudioMix([plain], { limit: -1 })).toBe(false)
    expect(isPlainAudioMix([plain, plain])).toBe(false)

    const args = motionAudioMixFfmpegArgs({
      video: 'v.mp4',
      output: 'o.mp4',
      duration: 5,
      format: 'mp4',
      events: [plain],
      master: { loudness: -16, limit: -1 },
    })
    const graph = args[args.indexOf('-filter_complex') + 1]
    expect(graph).toContain('[t0]loudnorm=I=-16:TP=-1:LRA=11,aresample=48000,alimiter=limit=0.8913:level=0[master]')
    expect(args.join(' ')).toContain('-map [master]')
  })

  it('the initial cut (offset) trims the FILE before the delay', () => {
    const graph = graphOf([{ file: 'clip.mp4', start: 2, gainDb: 0, fadeIn: 0, fadeOut: 0, duck: false, offset: 5 }], 10)
    const chain = graph.split(';')[0]
    // With no declared end, only the start is cut; the track's clock goes back to zero.
    expect(chain).toContain('atrim=start=5.000,asetpts=PTS-STARTPTS')
    expect(chain.indexOf('atrim=start=5')).toBeLessThan(chain.indexOf('adelay=2000'))
    // The delay after an initial cut needs the timestamp-based resample (see the
    // note in render-args): without it the mp4/aac loses the delay's silence.
    expect(chain).toContain('adelay=2000:all=1,aresample=async=1:first_pts=0')
    // With an end, the file window is offset … offset+length (here 5 + (8-2)).
    const bounded = graphOf([{ file: 'clip.mp4', start: 2, end: 8, gainDb: 0, fadeIn: 0, fadeOut: 0, duck: false, offset: 5 }], 10)
    expect(bounded).toContain('atrim=start=5.000:end=11.000')
    // Without a delay (start 0) the resample is not needed.
    const noDelay = graphOf([{ file: 'clip.mp4', start: 0, gainDb: 0, fadeIn: 0, fadeOut: 0, duck: false, offset: 5 }], 10)
    expect(noDelay).not.toContain('aresample')
  })

  it('loop repeats the file and the trim ensures the track ends', () => {
    const graph = graphOf([{ file: 'clip.mp4', start: 0, gainDb: 0, fadeIn: 0, fadeOut: 0, duck: false, loop: true }], 6)
    const chain = graph.split(';')[0]
    expect(chain).toContain('aloop=loop=-1:size=2147483647,atrim=end=6.000')
  })

  it('offset and loop also take the track out of the simple case', () => {
    const plain = { file: 'a.wav', start: 0, gainDb: 0, fadeIn: 0, fadeOut: 0, duck: false }
    expect(isPlainAudioEvent({ ...plain, offset: 3 })).toBe(false)
    expect(isPlainAudioEvent({ ...plain, loop: true })).toBe(false)
  })

  it('the custom duck comes from the first bed that declared it', () => {
    const graph = graphOf([
      { file: 'voz.wav', start: 0, gainDb: 0, fadeIn: 0, fadeOut: 0, duck: false },
      {
        file: 'cama.wav',
        start: 0,
        gainDb: -18,
        fadeIn: 0,
        fadeOut: 0,
        duck: true,
        duckSettings: { threshold: 0.01, ratio: 6, attack: 50, release: 800 },
      },
    ])
    expect(graph).toContain('sidechaincompress=threshold=0.01:ratio=6:attack=50:release=800')
    expect(graph).not.toContain('attack=15')
  })
})

describe('nativeScaleEmulation', () => {
  it('pins the device scale to 1 at the declared size', () => {
    const e = nativeScaleEmulation(1080, 1920)
    expect(e.deviceScaleFactor).toBe(1)
    expect(e.viewSize).toEqual({ width: 1080, height: 1920 })
    expect(e.screenSize).toEqual({ width: 1080, height: 1920 })
  })
  it('rounds fractional sizes and never goes below 1', () => {
    expect(nativeScaleEmulation(1602.6, 0).viewSize).toEqual({ width: 1603, height: 1 })
  })
})
