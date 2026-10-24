import { describe, expect, it } from 'vitest'
import type { MediaProbe } from '../video/ffmpeg'
import {
  audioBitrateForTarget,
  buildPlan,
  defaultContainer,
  nextVideoBitrate,
  qualityToAudioBitrate,
  qualityToCrf,
  resolveCodecs,
  totalBudgetKbps,
  videoBitrateForTarget,
} from './plan'

/** Probe mínimo: o que o plano lê de verdade. */
function probe(over: Partial<MediaProbe> = {}): MediaProbe {
  const base: MediaProbe = {
    file: '/tmp/in.mp4',
    durationMs: 60_000,
    sizeBytes: 40_000_000,
    format: 'mov,mp4,m4a,3gp,3g2,mj2',
    video: [{ index: 0, codec: 'h264', width: 1920, height: 1080, fps: 30, rotation: 0, pixFmt: 'yuv420p' }],
    audio: [{ index: 1, codec: 'aac', sampleRate: 48000, channels: 2 }],
    display: { width: 1920, height: 1080 },
  }
  return { ...base, ...over }
}

describe('qualityToCrf', () => {
  it('vai de quase sem perda a bem comprimido', () => {
    expect(qualityToCrf(100, 'h264')).toBe(18)
    expect(qualityToCrf(75, 'h264')).toBe(25)
    expect(qualityToCrf(50, 'h264')).toBe(32)
  })

  it('nunca sai da faixa do encoder', () => {
    expect(qualityToCrf(0, 'h264')).toBe(46)
    expect(qualityToCrf(200, 'h264')).toBe(18)
    expect(qualityToCrf(1, 'h264')).toBeLessThanOrEqual(51)
  })

  it('compensa a escala de cada codec', () => {
    // Para a MESMA qualidade percebida, x265/vp9/av1 aceitam CRF mais alto.
    expect(qualityToCrf(75, 'hevc')).toBe(qualityToCrf(75, 'h264') + 5)
    expect(qualityToCrf(75, 'vp9')).toBe(qualityToCrf(75, 'h264') + 8)
    expect(qualityToCrf(75, 'av1')).toBe(qualityToCrf(75, 'h264') + 10)
    expect(qualityToCrf(1, 'vp9')).toBeLessThanOrEqual(63)
  })
})

describe('qualityToAudioBitrate', () => {
  it('opus entrega o mesmo com menos bits', () => {
    expect(qualityToAudioBitrate(75, 'aac')).toBe(192)
    expect(qualityToAudioBitrate(75, 'mp3')).toBe(192)
    expect(qualityToAudioBitrate(75, 'opus')).toBe(128)
  })

  it('decresce com a qualidade', () => {
    const values = [100, 80, 60, 40, 20, 5].map((q) => qualityToAudioBitrate(q, 'aac'))
    for (let i = 1; i < values.length; i++) expect(values[i]).toBeLessThanOrEqual(values[i - 1])
  })
})

describe('resolveCodecs', () => {
  it('usa o padrão do contêiner quando não há override', () => {
    expect(resolveCodecs('mp4')).toMatchObject({ kind: 'video', videoCodec: 'h264', audioCodec: 'aac' })
    expect(resolveCodecs('webm')).toMatchObject({ kind: 'video', videoCodec: 'vp9', audioCodec: 'opus' })
    expect(resolveCodecs('m4a')).toMatchObject({ kind: 'audio', videoCodec: null, audioCodec: 'aac' })
  })

  it('aceita o codec válido para o contêiner', () => {
    expect(resolveCodecs('mp4', 'hevc').videoCodec).toBe('hevc')
    expect(resolveCodecs('mkv', 'vp9').videoCodec).toBe('vp9')
  })

  it('recusa combinação impossível dizendo o caminho certo', () => {
    expect(() => resolveCodecs('mp4', 'vp9')).toThrow(/use webm/)
    expect(() => resolveCodecs('m4a', 'mp3')).toThrow(/use mp3/)
    expect(() => resolveCodecs('webm', 'h264')).toThrow(/webm carries video/)
  })
})

describe('defaultContainer', () => {
  it('mantém a família de origem quando ela já é comprimida', () => {
    expect(defaultContainer(probe({ video: [], display: undefined, audio: [{ index: 0, codec: 'mp3', sampleRate: 44100, channels: 2 }] }), 'audio')).toBe('mp3')
    expect(defaultContainer(probe({ video: [], display: undefined, audio: [{ index: 0, codec: 'opus', sampleRate: 48000, channels: 2 }] }), 'audio')).toBe('opus')
  })

  it('manda WAV/FLAC para m4a e WebM para WebM', () => {
    expect(defaultContainer(probe({ video: [], display: undefined, audio: [{ index: 0, codec: 'pcm_s16le', sampleRate: 44100, channels: 2 }] }), 'audio')).toBe('m4a')
    expect(defaultContainer(probe({ format: 'matroska,webm' }), 'video')).toBe('webm')
    expect(defaultContainer(probe(), 'video')).toBe('mp4')
  })
})

describe('orçamento de bits', () => {
  it('desconta a folga do contêiner e o áudio', () => {
    // 10 MB em 60 s: 1293 kbps no total; menos 128 de áudio e 6 de folga.
    expect(videoBitrateForTarget({ maxBytes: 10_000_000, durationMs: 60_000, audioKbps: 128 })).toBe(1159)
  })

  it('não infla acima do bitrate de origem', () => {
    expect(videoBitrateForTarget({ maxBytes: 100_000_000, durationMs: 60_000, audioKbps: 128, sourceKbps: 900 })).toBe(900)
  })

  it('respeita o piso praticável e avisa no plano', () => {
    const plan = buildPlan({ probe: probe(), target: { maxBytes: 200_000 } })
    expect(plan.bitrate).toBe(60)
    expect(plan.notes.join(' ')).toMatch(/tight/)
  })

  it('recusa duração desconhecida', () => {
    expect(() => totalBudgetKbps(1_000_000, 0)).toThrow(/duration/)
  })

  it('corrige o bitrate na proporção do estouro', () => {
    expect(nextVideoBitrate(1000, 12_000_000, 10_000_000)).toBe(800)
    expect(nextVideoBitrate(80, 4_000_000, 50_000)).toBe(60)
  })

  it('extrai áudio dentro do orçamento', () => {
    // 5 MB em 5 min: 129 kbps.
    expect(audioBitrateForTarget(5_000_000, 300_000, 'aac')).toBe(127)
    expect(audioBitrateForTarget(20_000, 300_000, 'aac')).toBe(64)
    expect(audioBitrateForTarget(50_000_000, 60_000, 'opus')).toBe(256)
  })
})

describe('buildPlan', () => {
  it('alvo em bytes vira bitrate, não CRF', () => {
    const plan = buildPlan({ probe: probe(), target: { maxBytes: 10_000_000 } })
    expect(plan.crf).toBeNull()
    expect(plan.bitrate).toBeGreaterThan(900)
    expect(plan.audioBitrate).toBe(192)
  })

  it('qualidade vira CRF e bitrate fica nulo', () => {
    const plan = buildPlan({ probe: probe(), target: { quality: 60 } })
    expect(plan.crf).toBe(qualityToCrf(60, 'h264'))
    expect(plan.bitrate).toBeNull()
  })

  it('áudio não come o orçamento num alvo apertado', () => {
    const plan = buildPlan({ probe: probe({ durationMs: 30_000 }), target: { maxBytes: 400_000 } })
    // 400 KB em 30 s = 103 kbps no total.
    expect(plan.audioBitrate).toBe(64)
    expect(plan.notes.join(' ')).toMatch(/audio lowered/)
  })

  it('só reduz altura e fps, nunca aumenta', () => {
    const plan = buildPlan({ probe: probe(), target: { quality: 70, height: 720, fps: 24 } })
    expect(plan.height).toBe(720)
    expect(plan.fps).toBe(24)

    const up = buildPlan({ probe: probe(), target: { quality: 70, height: 2160, fps: 60 } })
    expect(up.height).toBeNull()
    expect(up.fps).toBeNull()
    expect(up.notes.join(' ')).toMatch(/ignored/)
  })

  it('arredonda a altura para par (o x264 exige)', () => {
    expect(buildPlan({ probe: probe(), target: { quality: 70, height: 721 } }).height).toBe(720)
  })

  it('10 bits em h264 avisa e cai para 8 bits; em hevc mantém', () => {
    const tenBit = probe({
      video: [{ index: 0, codec: 'hevc', width: 3840, height: 2160, fps: 30, rotation: 0, pixFmt: 'yuv420p10le' }],
      display: { width: 3840, height: 2160 },
    })
    const h264 = buildPlan({ probe: tenBit, target: { quality: 70 }, container: 'mp4' })
    expect(h264.pixFmt).toBe('yuv420p')
    expect(h264.notes.join(' ')).toMatch(/10-bit|8-bit/)

    const hevc = buildPlan({ probe: tenBit, target: { quality: 70 }, container: 'mp4', codec: 'hevc' })
    expect(hevc.pixFmt).toBe('yuv420p10le')
  })

  it('contêiner de áudio sobre um vídeo extrai a faixa', () => {
    const plan = buildPlan({ probe: probe(), target: { quality: 80 }, container: 'mp3' })
    expect(plan.kind).toBe('audio')
    expect(plan.audioBitrate).toBe(192)
    expect(plan.notes.join(' ')).toMatch(/audio only/)
  })

  it('sem áudio na origem, o plano não inventa faixa', () => {
    const plan = buildPlan({ probe: probe({ audio: [] }), target: { quality: 70 } })
    expect(plan.stripAudio).toBe(true)
    expect(plan.audioBitrate).toBe(0)
  })

  it('stripAudio explícito zera a faixa', () => {
    const plan = buildPlan({ probe: probe(), target: { quality: 70 }, stripAudio: true })
    expect(plan.stripAudio).toBe(true)
    expect(plan.audioBitrate).toBe(0)
  })

  it('recusa vídeo sem stream de vídeo e áudio sem stream de áudio', () => {
    expect(() => buildPlan({ probe: probe({ video: [], display: undefined }), target: { quality: 70 }, container: 'mp4' })).toThrow(
      /no video stream/,
    )
    expect(() => buildPlan({ probe: probe({ audio: [] }), target: { quality: 70 }, container: 'mp3' })).toThrow(
      /no audio stream/,
    )
  })

  it('preset pedido chega ao plano', () => {
    expect(buildPlan({ probe: probe(), target: { quality: 70 }, preset: 'fast' }).preset).toBe('fast')
    expect(buildPlan({ probe: probe(), target: { quality: 70 } }).preset).toBe('balanced')
  })
})
