/**
 * O TRATAMENTO do áudio de uma peça de motion: o que se faz com uma faixa além
 * de posicioná-la e ajustar o nível — tirar a região que briga com a voz, segurar
 * a dinâmica, desenhar uma curva de volume ao longo da peça, e travar o resultado
 * final num teto e num volume de entrega.
 *
 * Mora aparte do motion-audio.ts (que resolve ARQUIVOS e instantes) e do
 * motion-render-args.ts (que monta o ffmpeg): aqui está só o vocabulário do
 * manifest — o que `audio.json` aceita, validado, com os números dentro de
 * limites sãos — e a tradução dele em filtros. Tudo puro, testável sem ffmpeg.
 *
 * Duas decisões de produto:
 *
 *  - uma entrada inválida é ERRO com o motivo, não um filtro ignorado. Uma
 *    faixa que o autor tratou e que sai crua, em silêncio, é pior que um render
 *    que diz "eq banda 2: gain 40 está fora de −24…24";
 *  - os PRESETS (voice, bed, phone) são só atalhos para campos que o manifest já
 *    tem. O que a faixa declara por conta própria vence o preset, campo a campo.
 *
 * O tratamento só existe no RENDER. A aba toca a faixa crua, como já faz com o
 * nível e as rampas; o agente é avisado disso nas notas do guia.
 */

export interface EqBand {
  /** Frequência central, Hz. */
  freq: number
  /** Ganho em dB (negativo corta). */
  gain: number
  /** Largura da banda: menor = mais larga. */
  q: number
}

export interface Compressor {
  /** Nível acima do qual a compressão age, dB. */
  threshold: number
  ratio: number
  /** ms. */
  attack: number
  /** ms. */
  release: number
  /** Ganho de compensação depois de comprimir, dB. */
  makeup: number
}

/** Um ponto da curva de volume: o nível em dB naquele segundo DA PEÇA. */
export interface AutomationPoint {
  at: number
  db: number
}

/** O tratamento de UMA faixa. Vazio é o caso normal. */
export interface TrackFx {
  highpass?: number
  lowpass?: number
  eq: EqBand[]
  compress?: Compressor
  automation: AutomationPoint[]
}

/** Como a cama (`duck`) abaixa sob as faixas de frente. */
export interface DuckSettings {
  /** Nível LINEAR acima do qual a frente aciona a cama (0.02 ≈ −34 dB). */
  threshold: number
  ratio: number
  /** ms. */
  attack: number
  /** ms. */
  release: number
}

/** O acabamento da mixagem inteira. */
export interface MasterFx {
  /** Teto de pico, dBFS: nada passa daqui. */
  limit?: number
  /** Volume de entrega, LUFS (−16 é o de voz em plataformas, −14 o de música). */
  loudness?: number
}

export const NO_FX: TrackFx = { eq: [], automation: [] }

/** O duck de sempre — os números que o render de EDL já usa. */
export const DEFAULT_DUCK: DuckSettings = { threshold: 0.02, ratio: 10, attack: 15, release: 350 }

const DEFAULT_COMPRESSOR: Compressor = { threshold: -18, ratio: 3, attack: 10, release: 250, makeup: 0 }

/** Atalhos: só preenchem o que a faixa não declarou. */
const PRESETS: Record<string, Partial<Omit<TrackFx, 'automation'>>> = {
  // Voz: tira o rumor grave, abre um pouco de presença e segura os picos.
  voice: {
    highpass: 80,
    eq: [
      { freq: 250, gain: -2, q: 1 },
      { freq: 3500, gain: 2.5, q: 1 },
    ],
    compress: { threshold: -20, ratio: 3, attack: 8, release: 200, makeup: 3 },
  },
  // Cama: abre espaço na faixa onde a voz vive, para a música ficar ATRÁS dela
  // sem precisar ficar baixa demais.
  bed: {
    lowpass: 14000,
    eq: [
      { freq: 300, gain: -3, q: 0.8 },
      { freq: 2500, gain: -4, q: 0.8 },
    ],
  },
  // Telefone: a banda estreita de uma ligação.
  phone: {
    highpass: 400,
    lowpass: 3400,
    compress: { threshold: -22, ratio: 4, attack: 5, release: 150, makeup: 4 },
  },
}

export const MOTION_AUDIO_PRESETS = Object.keys(PRESETS)

const MAX_EQ_BANDS = 6
const MAX_AUTOMATION_POINTS = 24

function fail(where: string, message: string): never {
  throw new Error(`${where}: ${message}`)
}

/** Número finito dentro de [min, max], ou erro com o motivo. */
function bounded(value: unknown, where: string, label: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(where, `${label} must be a number`)
  if (value < min || value > max) fail(where, `${label} ${value} is outside ${min}…${max}`)
  return value
}

function optional(value: unknown, where: string, label: string, min: number, max: number, fallback: number): number {
  return value === undefined ? fallback : bounded(value, where, label, min, max)
}

function parseEq(value: unknown, where: string): EqBand[] {
  if (!Array.isArray(value)) fail(where, '"eq" must be a list of bands like { "freq": 3000, "gain": 2, "q": 1 }')
  if (value.length > MAX_EQ_BANDS) fail(where, `"eq" takes at most ${MAX_EQ_BANDS} bands`)
  return value.map((entry, index) => {
    const label = `eq band ${index + 1}`
    const band = (entry ?? {}) as Record<string, unknown>
    if (band.freq === undefined) fail(where, `${label} needs "freq"`)
    return {
      freq: bounded(band.freq, where, `${label} freq`, 20, 20000),
      gain: optional(band.gain, where, `${label} gain`, -24, 24, 0),
      q: optional(band.q, where, `${label} q`, 0.1, 10, 1),
    }
  })
}

function parseCompress(value: unknown, where: string): Compressor | undefined {
  if (value === false || value === null) return undefined
  if (value === true) return { ...DEFAULT_COMPRESSOR }
  if (typeof value !== 'object') fail(where, '"compress" must be true, false or an object')
  const c = value as Record<string, unknown>
  return {
    threshold: optional(c.threshold, where, 'compress threshold', -60, 0, DEFAULT_COMPRESSOR.threshold),
    ratio: optional(c.ratio, where, 'compress ratio', 1, 20, DEFAULT_COMPRESSOR.ratio),
    attack: optional(c.attack, where, 'compress attack', 0.01, 2000, DEFAULT_COMPRESSOR.attack),
    release: optional(c.release, where, 'compress release', 0.01, 9000, DEFAULT_COMPRESSOR.release),
    makeup: optional(c.makeup, where, 'compress makeup', 0, 24, DEFAULT_COMPRESSOR.makeup),
  }
}

/** Aceita `{ at, db }` e a forma curta `[at, db]`. Devolve em ordem de tempo. */
function parseAutomation(value: unknown, where: string): AutomationPoint[] {
  if (!Array.isArray(value)) fail(where, '"automation" must be a list of { "at": seconds, "db": level }')
  if (value.length > MAX_AUTOMATION_POINTS) fail(where, `"automation" takes at most ${MAX_AUTOMATION_POINTS} points`)
  const points = value.map((entry, index) => {
    const label = `automation point ${index + 1}`
    const pair = Array.isArray(entry) ? { at: entry[0], db: entry[1] } : ((entry ?? {}) as Record<string, unknown>)
    return {
      at: bounded(pair.at, where, `${label} at`, 0, 36000),
      db: bounded(pair.db, where, `${label} db`, -60, 12),
    }
  })
  points.sort((a, b) => a.at - b.at)
  for (let i = 1; i < points.length; i++) {
    if (points[i].at === points[i - 1].at) fail(where, `automation has two points at ${points[i].at}s`)
  }
  return points
}

/**
 * O tratamento de uma faixa a partir do que o manifest declarou. `where` é o
 * prefixo das mensagens ("audio.json: track 2"), para o erro dizer ONDE.
 */
export function parseTrackFx(spec: Record<string, unknown>, where: string): TrackFx {
  let base: Partial<Omit<TrackFx, 'automation'>> = {}
  if (spec.preset !== undefined) {
    const preset = typeof spec.preset === 'string' ? PRESETS[spec.preset] : undefined
    if (!preset) fail(where, `unknown preset ${JSON.stringify(spec.preset)} (use ${MOTION_AUDIO_PRESETS.join(', ')})`)
    base = preset
  }
  const fx: TrackFx = {
    highpass: base.highpass,
    lowpass: base.lowpass,
    eq: base.eq ? base.eq.map((band) => ({ ...band })) : [],
    compress: base.compress ? { ...base.compress } : undefined,
    automation: [],
  }
  if (spec.highpass !== undefined) fx.highpass = bounded(spec.highpass, where, 'highpass', 20, 2000)
  if (spec.lowpass !== undefined) fx.lowpass = bounded(spec.lowpass, where, 'lowpass', 500, 20000)
  if (spec.eq !== undefined) fx.eq = parseEq(spec.eq, where)
  if (spec.compress !== undefined) fx.compress = parseCompress(spec.compress, where)
  if (spec.automation !== undefined) fx.automation = parseAutomation(spec.automation, where)
  if (fx.highpass !== undefined && fx.lowpass !== undefined && fx.highpass >= fx.lowpass) {
    fail(where, `highpass ${fx.highpass} Hz is not below lowpass ${fx.lowpass} Hz — nothing would pass`)
  }
  return fx
}

/** `duck: true` (os números de sempre) ou um objeto com o que mudar. */
export function parseDuck(value: unknown, where: string): { duck: boolean; settings?: DuckSettings } {
  if (value === undefined || value === false || value === null) return { duck: false }
  if (value === true) return { duck: true }
  if (typeof value !== 'object') fail(where, '"duck" must be true, false or an object')
  const d = value as Record<string, unknown>
  const thresholdDb = optional(d.threshold, where, 'duck threshold', -60, 0, -34)
  return {
    duck: true,
    settings: {
      threshold: Math.pow(10, thresholdDb / 20),
      ratio: optional(d.ratio, where, 'duck ratio', 1, 20, DEFAULT_DUCK.ratio),
      // Segundos no manifest (como o resto dos tempos dele), ms no filtro.
      attack: optional(d.attack, where, 'duck attack', 0.001, 2, DEFAULT_DUCK.attack / 1000) * 1000,
      release: optional(d.release, where, 'duck release', 0.01, 9, DEFAULT_DUCK.release / 1000) * 1000,
    },
  }
}

export function parseMasterFx(value: unknown): MasterFx | null {
  if (value === undefined || value === null) return null
  const where = 'audio.json: master'
  if (typeof value !== 'object' || Array.isArray(value)) fail(where, 'must be an object like { "limit": -1, "loudness": -16 }')
  const m = value as Record<string, unknown>
  const master: MasterFx = {}
  if (m.limit !== undefined) master.limit = bounded(m.limit, where, 'limit', -24, 0)
  if (m.loudness !== undefined) master.loudness = bounded(m.loudness, where, 'loudness', -40, -5)
  return master.limit === undefined && master.loudness === undefined ? null : master
}

// ------------------------------------------------------------------ filtros

/** Número curto e estável para o grafo: sem zeros sobrando, sem notação científica. */
function num(value: number): string {
  return String(Number(value.toFixed(4)))
}

const linear = (db: number): number => Math.pow(10, db / 20)

export function hasTrackFx(fx: TrackFx | undefined): boolean {
  return !!fx && (fx.highpass !== undefined || fx.lowpass !== undefined || fx.eq.length > 0 || !!fx.compress || fx.automation.length > 0)
}

export function hasMasterFx(master: MasterFx | null | undefined): boolean {
  return !!master && (master.limit !== undefined || master.loudness !== undefined)
}

/**
 * O que vem ANTES do nível e das rampas: tirar o que não serve, dar forma ao
 * timbre e segurar a dinâmica — nesta ordem, para o compressor não reagir a uma
 * região que o filtro ia cortar de qualquer jeito.
 */
export function toneFilters(fx: TrackFx): string[] {
  const out: string[] = []
  if (fx.highpass !== undefined) out.push(`highpass=f=${num(fx.highpass)}`)
  if (fx.lowpass !== undefined) out.push(`lowpass=f=${num(fx.lowpass)}`)
  for (const band of fx.eq) out.push(`equalizer=f=${num(band.freq)}:t=q:w=${num(band.q)}:g=${num(band.gain)}`)
  if (fx.compress) {
    const c = fx.compress
    out.push(
      `acompressor=threshold=${num(linear(c.threshold))}:ratio=${num(c.ratio)}:attack=${num(c.attack)}:release=${num(c.release)}:makeup=${num(linear(c.makeup))}`,
    )
  }
  return out
}

/**
 * A curva de volume, em dB, interpolada em linha reta entre os pontos e presa nos
 * extremos. Vai DEPOIS do atraso da faixa: ali o `t` do filtro já é o tempo da
 * PEÇA, que é a régua em que o manifest escreve os pontos.
 *
 * A expressão fica entre aspas simples — as vírgulas dos `if(…)` não podem ser
 * lidas como separador de filtros. Devolve null sem pontos.
 */
export function automationFilter(points: AutomationPoint[]): string | null {
  if (points.length === 0) return null
  if (points.length === 1) return `volume=${num(points[0].db)}dB`
  const last = points[points.length - 1]
  let expr = num(last.db)
  for (let i = points.length - 2; i >= 0; i--) {
    const a = points[i]
    const b = points[i + 1]
    const slope = (b.db - a.db) / (b.at - a.at)
    expr = `if(lt(t,${num(b.at)}),${num(a.db)}+${num(slope)}*(t-${num(a.at)}),${expr})`
  }
  expr = `if(lt(t,${num(points[0].at)}),${num(points[0].db)},${expr})`
  return `volume='pow(10,(${expr})/20)':eval=frame`
}

/** O `sidechaincompress` da cama. Os padrões produzem exatamente o filtro de antes. */
export function duckFilter(settings: DuckSettings = DEFAULT_DUCK): string {
  return `sidechaincompress=threshold=${num(settings.threshold)}:ratio=${num(settings.ratio)}:attack=${num(settings.attack)}:release=${num(settings.release)}`
}

/**
 * O acabamento da mixagem inteira. O volume de entrega vem primeiro e o limitador
 * depois: normalizar pode empurrar um pico acima do teto, e o limitador existe
 * para pegá-lo. O `loudnorm` devolve o áudio em 192 kHz, então volta a 48 kHz.
 */
export function masterFilters(master: MasterFx | null | undefined): string[] {
  if (!master) return []
  const out: string[] = []
  if (master.loudness !== undefined) {
    const peak = master.limit ?? -1.5
    out.push(`loudnorm=I=${num(master.loudness)}:TP=${num(peak)}:LRA=11`, 'aresample=48000')
  }
  if (master.limit !== undefined) out.push(`alimiter=limit=${num(linear(master.limit))}:level=0`)
  return out
}

/** O tratamento em poucas palavras, para o relatório (vazio quando não há). */
export function describeTrackFx(fx: TrackFx | undefined): string {
  if (!hasTrackFx(fx) || !fx) return ''
  const parts: string[] = []
  if (fx.highpass !== undefined) parts.push(`highpass ${fx.highpass}Hz`)
  if (fx.lowpass !== undefined) parts.push(`lowpass ${fx.lowpass}Hz`)
  if (fx.eq.length) parts.push(`eq×${fx.eq.length}`)
  if (fx.compress) parts.push('compressor')
  if (fx.automation.length) parts.push(`volume curve×${fx.automation.length}`)
  return parts.join(', ')
}

export function describeMasterFx(master: MasterFx | null | undefined): string {
  if (!hasMasterFx(master) || !master) return ''
  const parts: string[] = []
  if (master.loudness !== undefined) parts.push(`${master.loudness} LUFS`)
  if (master.limit !== undefined) parts.push(`peak limit ${master.limit} dB`)
  return parts.join(', ')
}
