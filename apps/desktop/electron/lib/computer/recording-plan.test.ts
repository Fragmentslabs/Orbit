import { describe, expect, it } from 'vitest'
import { buildFilter, formatTimeline, planRecording, planSegments, targetBox, toOutputTime, DEFAULT_PLAN } from './recording-plan'

/**
 * A edição da gravação: o vídeo tem a duração das ações, não a da conversa.
 * O agente pensando 20 s entre dois cliques não pode virar 20 s de tela parada.
 */

const opts = { padBefore: 300, padAfter: 900, joinGap: 500 }

describe('planSegments', () => {
  it('corta o ocioso entre ações distantes', () => {
    const segs = planSegments(
      [
        { start: 2_000, end: 2_400, label: 'click' },
        { start: 30_000, end: 30_300, label: 'type' },
      ],
      40_000,
      opts,
    )
    expect(segs).toEqual([
      { from: 1_700, to: 3_300 },
      { from: 29_700, to: 31_200 },
    ])
  })

  it('junta ações próximas num trecho só', () => {
    const segs = planSegments(
      [
        { start: 1_000, end: 1_200, label: 'a' },
        { start: 2_300, end: 2_500, label: 'b' },
      ],
      10_000,
      opts,
    )
    expect(segs).toEqual([{ from: 700, to: 3_400 }])
  })

  it('wait fica inteiro, sem respiro extra; keep_idle mantém tudo', () => {
    expect(planSegments([{ start: 5_000, end: 7_000, label: 'wait', hold: true }], 20_000, opts)).toEqual([{ from: 4_700, to: 7_000 }])
    expect(planSegments([{ start: 5_000, end: 7_000, label: 'x' }], 20_000, { ...opts, keepIdle: true })).toEqual([{ from: 0, to: 20_000 }])
  })

  it('respeita os limites da gravação', () => {
    expect(planSegments([{ start: 100, end: 9_900, label: 'x' }], 10_000, opts)).toEqual([{ from: 0, to: 10_000 }])
  })
})

describe('toOutputTime', () => {
  const segs = [
    { from: 1_000, to: 2_000 },
    { from: 10_000, to: 11_500 },
  ]
  it('mapeia o tempo da gravação para o vídeo final', () => {
    expect(toOutputTime(segs, 1_500)).toBe(500)
    expect(toOutputTime(segs, 10_000)).toBe(1_000)
    expect(toOutputTime(segs, 11_500)).toBe(2_500)
  })
  it('instante cortado não existe no vídeo', () => {
    expect(toOutputTime(segs, 5_000)).toBeNull()
  })
})

describe('targetBox', () => {
  const window: [number, number, number, number] = [100, 50, 600, 400]
  const video = { width: 1200, height: 800 } // Retina 2x

  it('elemento → retângulo no vídeo com margem', () => {
    expect(targetBox({ frame: [200, 100, 80, 20] }, window, video)).toEqual({ x: 190, y: 90, w: 180, h: 60 })
  })
  it('ponto → quadrado em volta', () => {
    expect(targetBox({ point: [400, 250] }, window, video)).toEqual({ x: 582, y: 382, w: 36, h: 36 })
  })
  it('fora da janela → sem pulso', () => {
    expect(targetBox({ point: [5_000, 5_000] }, window, video)).toBeNull()
  })
})

describe('planRecording', () => {
  it('linha do tempo e pulsos no tempo do vídeo final', () => {
    const plan = planRecording(
      [
        { start: 2_000, end: 2_400, label: 'left_click on element 3', target: { point: [400, 250] }, window: [100, 50, 600, 400] },
        { start: 30_000, end: 32_000, label: 'wait 2s', hold: true },
      ],
      [{ at: 31_000, label: 'formulário pronto' }],
      40_000,
      { width: 1200, height: 800 },
      DEFAULT_PLAN,
    )
    expect(plan.segments).toEqual([
      { from: 1_700, to: 3_300 },
      { from: 29_700, to: 32_000 },
    ])
    expect(plan.durationMs).toBe(3_900)
    expect(plan.cutMs).toBe(36_100)
    expect(plan.timeline).toEqual([
      { start: 300, end: 700, label: 'left_click on element 3' },
      { start: 1_900, end: 3_900, label: 'wait 2s' },
    ])
    expect(plan.pulses).toEqual([{ at: 300, box: { x: 582, y: 382, w: 36, h: 36 } }])
    expect(formatTimeline(plan)).toBe('0.3–0.7s  left_click on element 3\n1.9–3.9s  wait 2s\n2.9s  ◆ formulário pronto')
  })
})

describe('buildFilter', () => {
  it('trechos em concat e o pulso por cima', () => {
    const plan = planRecording(
      [{ start: 2_000, end: 2_400, label: 'click', target: { point: [400, 250] }, window: [100, 50, 600, 400] }],
      [],
      10_000,
      { width: 1200, height: 800 },
    )
    const { filter, output } = buildFilter(plan)
    expect(filter).toContain('trim=start=1.700:end=3.300')
    expect(filter).toContain('concat=n=1:v=1:a=0[cut]')
    expect(filter).toContain("drawbox=x=582:y=382:w=36:h=36:color=0xF5C400@0.95:t=6:enable='between(t,0.300,0.950)'")
    expect(output).toBe('p0')
  })
})
