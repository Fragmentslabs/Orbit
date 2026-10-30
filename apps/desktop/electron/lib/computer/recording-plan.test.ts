import { describe, expect, it } from 'vitest'
import { buildFilter, cursorExpression, formatTimeline, planRecording, planSegments, targetBox, toOutputTime, DEFAULT_PLAN } from './recording-plan'

/**
 * The editing of the recording: the video has the duration of the actions, not of the
 * conversation. The agent thinking 20 s between two clicks cannot become 20 s of still
 * screen.
 */

const opts = { padBefore: 300, padAfter: 900, joinGap: 500 }

describe('planSegments', () => {
  it('cuts the idle between distant actions', () => {
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

  it('joins nearby actions into a single segment', () => {
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

  it('wait stays whole, with no extra breathing; keep_idle keeps everything', () => {
    expect(planSegments([{ start: 5_000, end: 7_000, label: 'wait', hold: true }], 20_000, opts)).toEqual([{ from: 4_700, to: 7_000 }])
    expect(planSegments([{ start: 5_000, end: 7_000, label: 'x' }], 20_000, { ...opts, keepIdle: true })).toEqual([{ from: 0, to: 20_000 }])
  })

  it('respects the recording limits', () => {
    expect(planSegments([{ start: 100, end: 9_900, label: 'x' }], 10_000, opts)).toEqual([{ from: 0, to: 10_000 }])
  })
})

describe('toOutputTime', () => {
  const segs = [
    { from: 1_000, to: 2_000 },
    { from: 10_000, to: 11_500 },
  ]
  it('maps the recording time to the final video', () => {
    expect(toOutputTime(segs, 1_500)).toBe(500)
    expect(toOutputTime(segs, 10_000)).toBe(1_000)
    expect(toOutputTime(segs, 11_500)).toBe(2_500)
  })
  it('a cut instant does not exist in the video', () => {
    expect(toOutputTime(segs, 5_000)).toBeNull()
  })
})

describe('targetBox', () => {
  const window: [number, number, number, number] = [100, 50, 600, 400]
  const video = { width: 1200, height: 800 } // Retina 2x

  it('element → rectangle in the video with margin', () => {
    expect(targetBox({ frame: [200, 100, 80, 20] }, window, video)).toEqual({ x: 190, y: 90, w: 180, h: 60 })
  })
  it('ponto → quadrado em volta', () => {
    expect(targetBox({ point: [400, 250] }, window, video)).toEqual({ x: 582, y: 382, w: 36, h: 36 })
  })
  it('outside the window → no pulse', () => {
    expect(targetBox({ point: [5_000, 5_000] }, window, video)).toBeNull()
  })
})

describe('planRecording', () => {
  it('timeline and pulses in the final video time', () => {
    const plan = planRecording(
      [
        { start: 2_000, end: 2_400, label: 'left_click on element 3', target: { point: [400, 250] }, window: [100, 50, 600, 400], pulse: true },
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
    expect(plan.cursor).toEqual([{ at: 300, x: 600, y: 400 }])
    expect(formatTimeline(plan)).toBe('0.3–0.7s  left_click on element 3\n1.9–3.9s  wait 2s\n2.9s  ◆ formulário pronto')
  })
})

describe('buildFilter', () => {
  it('segments in concat and the pulse on top', () => {
    const plan = planRecording(
      [{ start: 2_000, end: 2_400, label: 'click', target: { point: [400, 250] }, window: [100, 50, 600, 400], pulse: true }],
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

describe('pulso e cursor desenhado', () => {
  const window: [number, number, number, number] = [100, 50, 600, 400]
  const video = { width: 1200, height: 800 }

  it('scrolling takes the cursor to the target, but with no pulse (only clicks pulse)', () => {
    const plan = planRecording(
      [
        { start: 1_000, end: 1_200, label: 'scroll down', target: { point: [400, 250] }, window },
        { start: 1_600, end: 1_800, label: 'left_click', target: { frame: [200, 100, 80, 20] }, window, pulse: true },
      ],
      [],
      5_000,
      video,
    )
    expect(plan.pulses).toHaveLength(1)
    expect(plan.cursor.map((c) => [c.x, c.y])).toEqual([
      [600, 400],
      [280, 120],
    ])
  })

  it('the cursor stays still on the 1st target, slides to the next and arrives at the instant of the action', () => {
    const expr = cursorExpression(
      [
        { at: 1_000, x: 100, y: 0 },
        { at: 2_000, x: 300, y: 0 },
      ],
      'x',
    )
    // Before 2s: interpolates from 100 to 300 between 1.55s and 2s; after that, 300.
    expect(expr).toBe('if(lt(t,2.000),100+(200)*(3*pow(clip((t-1.550)/0.450,0,1),2)-2*pow(clip((t-1.550)/0.450,0,1),3)),300)')
    expect(cursorExpression([], 'x')).toBe('0')
  })

  it('with the cursor inset, the filter overlays the arrow on the path', () => {
    const plan = planRecording([{ start: 2_000, end: 2_400, label: 'click', target: { point: [400, 250] }, window, pulse: true }], [], 10_000, video)
    const { filter, output } = buildFilter(plan, 30, { cursorInput: 1 })
    expect(filter).toContain("[p0][1:v]overlay=x='598':y='398':format=auto[cur]")
    expect(output).toBe('cur')
  })
})
