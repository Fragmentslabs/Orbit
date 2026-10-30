import { describe, expect, it } from 'vitest'
import {
  DEFAULT_DUCK,
  MOTION_AUDIO_PRESETS,
  NO_FX,
  automationFilter,
  duckFilter,
  hasMasterFx,
  hasTrackFx,
  masterFilters,
  parseDuck,
  parseMasterFx,
  parseTrackFx,
  toneFilters,
} from './motion-audio-fx'

const W = 'audio.json: track 1'

describe('parseTrackFx', () => {
  it('a track with no treatment has no treatment', () => {
    const fx = parseTrackFx({}, W)
    expect(fx).toEqual({ highpass: undefined, lowpass: undefined, eq: [], compress: undefined, automation: [] })
    expect(hasTrackFx(fx)).toBe(false)
    expect(hasTrackFx(NO_FX)).toBe(false)
  })

  it('reads filters, eq bands and compressor, with defaults on omitted fields', () => {
    const fx = parseTrackFx(
      { highpass: 90, lowpass: 12000, eq: [{ freq: 3000, gain: 2 }, { freq: 200, gain: -3, q: 2 }], compress: true },
      W,
    )
    expect(fx.highpass).toBe(90)
    expect(fx.lowpass).toBe(12000)
    expect(fx.eq).toEqual([
      { freq: 3000, gain: 2, q: 1 },
      { freq: 200, gain: -3, q: 2 },
    ])
    expect(fx.compress).toEqual({ threshold: -18, ratio: 3, attack: 10, release: 250, makeup: 0 })
    expect(hasTrackFx(fx)).toBe(true)
  })

  it('the preset fills in what the track did not declare, and what it declares wins', () => {
    const voice = parseTrackFx({ preset: 'voice' }, W)
    expect(voice.highpass).toBe(80)
    expect(voice.eq).toHaveLength(2)
    expect(voice.compress).toBeDefined()

    const custom = parseTrackFx({ preset: 'voice', highpass: 120, compress: false, eq: [] }, W)
    expect(custom.highpass).toBe(120)
    expect(custom.compress).toBeUndefined()
    expect(custom.eq).toEqual([])
  })

  it('does not let a preset be changed by whoever used it', () => {
    const first = parseTrackFx({ preset: 'voice' }, W)
    first.eq[0].gain = 99
    expect(parseTrackFx({ preset: 'voice' }, W).eq[0].gain).toBe(-2)
  })

  it('an unknown preset is an error, and the message lists the existing ones', () => {
    expect(() => parseTrackFx({ preset: 'radio' }, W)).toThrow(/unknown preset "radio"/)
    for (const name of MOTION_AUDIO_PRESETS) {
      expect(() => parseTrackFx({ preset: 'radio' }, W)).toThrow(new RegExp(name))
    }
  })

  it('a value out of range is an error with the reason, saying which track', () => {
    expect(() => parseTrackFx({ eq: [{ freq: 1000, gain: 40 }] }, W)).toThrow(/audio\.json: track 1: eq band 1 gain 40 is outside -24…24/)
    expect(() => parseTrackFx({ eq: [{ gain: 1 }] }, W)).toThrow(/eq band 1 needs "freq"/)
    expect(() => parseTrackFx({ eq: 'warm' }, W)).toThrow(/"eq" must be a list/)
    expect(() => parseTrackFx({ highpass: 5 }, W)).toThrow(/highpass 5 is outside/)
    expect(() => parseTrackFx({ compress: { ratio: 99 } }, W)).toThrow(/compress ratio 99/)
    expect(() => parseTrackFx({ eq: Array.from({ length: 7 }, () => ({ freq: 1000 })) }, W)).toThrow(/at most 6 bands/)
  })

  it('refuses a high-pass above the low-pass: nothing would pass', () => {
    expect(() => parseTrackFx({ highpass: 2000, lowpass: 1500 }, W)).toThrow(/nothing would pass/)
  })

  it('the volume curve accepts object and pair, and comes out in time order', () => {
    const fx = parseTrackFx({ automation: [{ at: 4, db: -12 }, [0, -30], { at: 2, db: 0 }] }, W)
    expect(fx.automation).toEqual([
      { at: 0, db: -30 },
      { at: 2, db: 0 },
      { at: 4, db: -12 },
    ])
  })

  it('two points at the same instant are an error (interpolation would divide by zero)', () => {
    expect(() => parseTrackFx({ automation: [[1, 0], [1, -6]] }, W)).toThrow(/two points at 1s/)
  })
})

describe('toneFilters', () => {
  it('goes from what is cut to what is kept: high-pass, low-pass, eq, compressor', () => {
    const fx = parseTrackFx(
      { highpass: 80, lowpass: 12000, eq: [{ freq: 3500, gain: 2.5, q: 1 }], compress: { threshold: -20, ratio: 4, makeup: 6 } },
      W,
    )
    expect(toneFilters(fx)).toEqual([
      'highpass=f=80',
      'lowpass=f=12000',
      'equalizer=f=3500:t=q:w=1:g=2.5',
      // threshold and makeup enter the filter in linear, not in dB.
      'acompressor=threshold=0.1:ratio=4:attack=10:release=250:makeup=1.9953',
    ])
  })

  it('a track with no treatment generates no filter', () => {
    expect(toneFilters(NO_FX)).toEqual([])
  })
})

describe('automationFilter', () => {
  it('with no points there is no filter; with a single one, it is a fixed level', () => {
    expect(automationFilter([])).toBeNull()
    expect(automationFilter([{ at: 3, db: -6 }])).toBe('volume=-6dB')
  })

  it('interpolates in a straight line in dB, clamped at the ends, quoted because of the commas', () => {
    const filter = automationFilter([
      { at: 0, db: -30 },
      { at: 2, db: 0 },
      { at: 6, db: -12 },
    ])
    expect(filter).toBe(
      "volume='pow(10,(if(lt(t,0),-30,if(lt(t,2),-30+15*(t-0),if(lt(t,6),0+-3*(t-2),-12))))/20)':eval=frame",
    )
  })
})

describe('duck', () => {
  it('true keeps the usual numbers — the same filter as the EDL render', () => {
    expect(parseDuck(true, W)).toEqual({ duck: true })
    expect(duckFilter()).toBe('sidechaincompress=threshold=0.02:ratio=10:attack=15:release=350')
    expect(duckFilter(DEFAULT_DUCK)).toBe(duckFilter())
  })

  it('an object customizes: threshold in dB, times in seconds in the manifest', () => {
    const { duck, settings } = parseDuck({ ratio: 6, threshold: -40, attack: 0.05, release: 0.8 }, W)
    expect(duck).toBe(true)
    expect(duckFilter(settings)).toBe('sidechaincompress=threshold=0.01:ratio=6:attack=50:release=800')
  })

  it('absent, false and null are not a bed', () => {
    expect(parseDuck(undefined, W)).toEqual({ duck: false })
    expect(parseDuck(false, W)).toEqual({ duck: false })
    expect(() => parseDuck('yes', W)).toThrow(/"duck" must be/)
    expect(() => parseDuck({ ratio: 50 }, W)).toThrow(/duck ratio 50/)
  })
})

describe('master', () => {
  it('with no declared finish there is no finish', () => {
    expect(parseMasterFx(undefined)).toBeNull()
    expect(parseMasterFx({})).toBeNull()
    expect(hasMasterFx(null)).toBe(false)
  })

  it('the delivery volume comes before the ceiling, and loudnorm returns to 48 kHz', () => {
    const master = parseMasterFx({ loudness: -16, limit: -1 })
    expect(hasMasterFx(master)).toBe(true)
    expect(masterFilters(master)).toEqual(['loudnorm=I=-16:TP=-1:LRA=11', 'aresample=48000', 'alimiter=limit=0.8913:level=0'])
  })

  it('ceiling only is only the limiter; volume only uses a safe peak', () => {
    expect(masterFilters({ limit: -3 })).toEqual(['alimiter=limit=0.7079:level=0'])
    expect(masterFilters({ loudness: -14 })).toEqual(['loudnorm=I=-14:TP=-1.5:LRA=11', 'aresample=48000'])
    expect(masterFilters(null)).toEqual([])
  })

  it('an absurd value is an error', () => {
    expect(() => parseMasterFx({ loudness: 3 })).toThrow(/audio\.json: master: loudness 3/)
    expect(() => parseMasterFx([])).toThrow(/must be an object/)
  })
})
