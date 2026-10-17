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
  it('a faixa sem tratamento não tem tratamento', () => {
    const fx = parseTrackFx({}, W)
    expect(fx).toEqual({ highpass: undefined, lowpass: undefined, eq: [], compress: undefined, automation: [] })
    expect(hasTrackFx(fx)).toBe(false)
    expect(hasTrackFx(NO_FX)).toBe(false)
  })

  it('lê filtros, bandas de eq e compressor, com padrões nos campos omitidos', () => {
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

  it('o preset preenche o que a faixa não declarou, e o que ela declara vence', () => {
    const voice = parseTrackFx({ preset: 'voice' }, W)
    expect(voice.highpass).toBe(80)
    expect(voice.eq).toHaveLength(2)
    expect(voice.compress).toBeDefined()

    const custom = parseTrackFx({ preset: 'voice', highpass: 120, compress: false, eq: [] }, W)
    expect(custom.highpass).toBe(120)
    expect(custom.compress).toBeUndefined()
    expect(custom.eq).toEqual([])
  })

  it('não deixa um preset ser alterado por quem o usou', () => {
    const first = parseTrackFx({ preset: 'voice' }, W)
    first.eq[0].gain = 99
    expect(parseTrackFx({ preset: 'voice' }, W).eq[0].gain).toBe(-2)
  })

  it('preset desconhecido é erro, e a mensagem lista os que existem', () => {
    expect(() => parseTrackFx({ preset: 'radio' }, W)).toThrow(/unknown preset "radio"/)
    for (const name of MOTION_AUDIO_PRESETS) {
      expect(() => parseTrackFx({ preset: 'radio' }, W)).toThrow(new RegExp(name))
    }
  })

  it('valor fora do limite é erro com o motivo, dizendo qual faixa', () => {
    expect(() => parseTrackFx({ eq: [{ freq: 1000, gain: 40 }] }, W)).toThrow(/audio\.json: track 1: eq band 1 gain 40 is outside -24…24/)
    expect(() => parseTrackFx({ eq: [{ gain: 1 }] }, W)).toThrow(/eq band 1 needs "freq"/)
    expect(() => parseTrackFx({ eq: 'warm' }, W)).toThrow(/"eq" must be a list/)
    expect(() => parseTrackFx({ highpass: 5 }, W)).toThrow(/highpass 5 is outside/)
    expect(() => parseTrackFx({ compress: { ratio: 99 } }, W)).toThrow(/compress ratio 99/)
    expect(() => parseTrackFx({ eq: Array.from({ length: 7 }, () => ({ freq: 1000 })) }, W)).toThrow(/at most 6 bands/)
  })

  it('recusa um filtro passa-alta acima do passa-baixa: nada passaria', () => {
    expect(() => parseTrackFx({ highpass: 2000, lowpass: 1500 }, W)).toThrow(/nothing would pass/)
  })

  it('a curva de volume aceita objeto e par, e sai em ordem de tempo', () => {
    const fx = parseTrackFx({ automation: [{ at: 4, db: -12 }, [0, -30], { at: 2, db: 0 }] }, W)
    expect(fx.automation).toEqual([
      { at: 0, db: -30 },
      { at: 2, db: 0 },
      { at: 4, db: -12 },
    ])
  })

  it('dois pontos no mesmo instante são erro (a interpolação dividiria por zero)', () => {
    expect(() => parseTrackFx({ automation: [[1, 0], [1, -6]] }, W)).toThrow(/two points at 1s/)
  })
})

describe('toneFilters', () => {
  it('vai do que se tira ao que se segura: passa-alta, passa-baixa, eq, compressor', () => {
    const fx = parseTrackFx(
      { highpass: 80, lowpass: 12000, eq: [{ freq: 3500, gain: 2.5, q: 1 }], compress: { threshold: -20, ratio: 4, makeup: 6 } },
      W,
    )
    expect(toneFilters(fx)).toEqual([
      'highpass=f=80',
      'lowpass=f=12000',
      'equalizer=f=3500:t=q:w=1:g=2.5',
      // threshold e makeup entram no filtro em linear, não em dB.
      'acompressor=threshold=0.1:ratio=4:attack=10:release=250:makeup=1.9953',
    ])
  })

  it('faixa sem tratamento não gera filtro', () => {
    expect(toneFilters(NO_FX)).toEqual([])
  })
})

describe('automationFilter', () => {
  it('sem pontos não há filtro; com um só, é um nível fixo', () => {
    expect(automationFilter([])).toBeNull()
    expect(automationFilter([{ at: 3, db: -6 }])).toBe('volume=-6dB')
  })

  it('interpola em linha reta em dB, preso nos extremos, entre aspas por causa das vírgulas', () => {
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
  it('true mantém os números de sempre — o mesmo filtro do render de EDL', () => {
    expect(parseDuck(true, W)).toEqual({ duck: true })
    expect(duckFilter()).toBe('sidechaincompress=threshold=0.02:ratio=10:attack=15:release=350')
    expect(duckFilter(DEFAULT_DUCK)).toBe(duckFilter())
  })

  it('objeto personaliza: limiar em dB, tempos em segundos no manifest', () => {
    const { duck, settings } = parseDuck({ ratio: 6, threshold: -40, attack: 0.05, release: 0.8 }, W)
    expect(duck).toBe(true)
    expect(duckFilter(settings)).toBe('sidechaincompress=threshold=0.01:ratio=6:attack=50:release=800')
  })

  it('ausente, false e null não são cama', () => {
    expect(parseDuck(undefined, W)).toEqual({ duck: false })
    expect(parseDuck(false, W)).toEqual({ duck: false })
    expect(() => parseDuck('yes', W)).toThrow(/"duck" must be/)
    expect(() => parseDuck({ ratio: 50 }, W)).toThrow(/duck ratio 50/)
  })
})

describe('master', () => {
  it('sem acabamento declarado não há acabamento', () => {
    expect(parseMasterFx(undefined)).toBeNull()
    expect(parseMasterFx({})).toBeNull()
    expect(hasMasterFx(null)).toBe(false)
  })

  it('o volume de entrega vem antes do teto, e o loudnorm volta a 48 kHz', () => {
    const master = parseMasterFx({ loudness: -16, limit: -1 })
    expect(hasMasterFx(master)).toBe(true)
    expect(masterFilters(master)).toEqual(['loudnorm=I=-16:TP=-1:LRA=11', 'aresample=48000', 'alimiter=limit=0.8913:level=0'])
  })

  it('só o teto é só o limitador; só o volume usa um pico seguro', () => {
    expect(masterFilters({ limit: -3 })).toEqual(['alimiter=limit=0.7079:level=0'])
    expect(masterFilters({ loudness: -14 })).toEqual(['loudnorm=I=-14:TP=-1.5:LRA=11', 'aresample=48000'])
    expect(masterFilters(null)).toEqual([])
  })

  it('valor absurdo é erro', () => {
    expect(() => parseMasterFx({ loudness: 3 })).toThrow(/audio\.json: master: loudness 3/)
    expect(() => parseMasterFx([])).toThrow(/must be an object/)
  })
})
