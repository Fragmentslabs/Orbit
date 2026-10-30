import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ BrowserWindow: class {} }))

const { describeLayers, mergeSpans, pickLayers } = await import('./motion-layers')
type RawLayer = import('./motion-layers').RawLayer

const raw = (
  name: string,
  parent: number,
  spans: [number, number][],
  named = false,
  extra: Partial<RawLayer> = {},
): RawLayer => ({
  name,
  named,
  parent,
  spans,
  ...extra,
})

describe('mergeSpans', () => {
  it('joins spans separated by a measuring blink and keeps real gaps', () => {
    expect(mergeSpans([[10, 20], [0, 5], [22, 30], [50, 60]])).toEqual([
      [0, 5],
      [10, 30],
      [50, 60],
    ])
  })
})

describe('pickLayers', () => {
  // A 300-frame composition: a named background and stage, always on screen, two
  // unnamed sentences inside the stage (with words inside), and an anonymous container
  // that never leaves.
  const layers = [
    raw('bg', -1, [[0, 299]], true), // 0
    raw('stage', -1, [[0, 299]], true), // 1
    raw('YOU DO NOT NEED', 1, [[30, 89]]), // 2
    raw('YOU', 2, [[30, 89]]), // 3 — word of the sentence
    raw('NEED', 2, [[45, 89]]), // 4 — enters later, but is part of the sentence
    raw('ANOTHER TOOL', 1, [[90, 150]]), // 5
    raw('.wrapper', -1, [[0, 299]]), // 6 — anonymous and always there
    raw('logo', 6, [[200, 299]], true), // 7 — named inside the anonymous one
    raw('#ghost', -1, []), // 8 — never visible
  ]

  it('keeps every named layer, and the OUTERMOST unnamed element that enters or leaves', () => {
    const picked = pickLayers(layers, 300)
    expect(picked.map((l) => l.name)).toEqual(['bg', 'stage', 'YOU DO NOT NEED', 'ANOTHER TOOL', 'logo'])
    expect(picked.find((l) => l.name === 'YOU DO NOT NEED')).toEqual({
      name: 'YOU DO NOT NEED',
      named: false,
      spans: [[30, 89]],
      // The position in the list is the element's address (the raw snapshot did not declare
      // `index`, so the order counts) and the type stays "other" without measurement.
      index: 2,
      kind: 'other',
    })
  })

  it('carries the ADDRESS and the TYPE of each layer — that is what the tab highlights and draws', () => {
    const typed: RawLayer[] = [
      raw('stage', -1, [[0, 299]], true),
      raw('titulo', 0, [[10, 90]], true, { kind: 'text' }),
      raw('foto', 0, [[20, 80]], true, { kind: 'image' }),
      raw('player', 0, [[30, 70]], true, { kind: 'video', index: 9 }),
    ]
    expect(pickLayers(typed, 300).map((l) => [l.name, l.index, l.kind])).toEqual([
      ['stage', 0, 'other'],
      ['titulo', 1, 'text'],
      ['foto', 2, 'image'],
      // The DECLARED index wins over the position in the list: it is the runtime that knows the
      // address, and a reordered snapshot cannot swap the element's highlight.
      ['player', 9, 'video'],
    ])
  })

  it('drops the words of a NAMED phrase that enters and leaves (they are parts of it)', () => {
    // The real case of the kinetic composition: data-layer="phrase-1" with one word
    // per span, each one entering on a frame.
    const phrase = [
      raw('stage', -1, [[0, 299]], true),
      raw('phrase-1', 0, [[1, 45]], true),
      raw('Oi,', 1, [[2, 45]]),
      raw('tudo', 1, [[29, 45]]),
      raw('phrase-2', 0, [[37, 93]], true),
    ]
    expect(pickLayers(phrase, 300).map((l) => l.name)).toEqual(['stage', 'phrase-1', 'phrase-2'])
  })

  it('keeps MEDIA even when it never enters or leaves — it is the content, not decoration', () => {
    // The real case: the piece is a background video from the first frame to the last. Without
    // this rule it vanished from the list (the "only those that enter or leave" rule discarded it),
    // precisely the layer the person wants to select and comment on.
    const media = [
      raw('Mimi.mp4', -1, [[0, 299]], false, { kind: 'video', tag: 'video' }),
      raw('trilha.mp3', -1, [[0, 299]], false, { kind: 'audio', tag: 'audio' }),
      raw('.decor', -1, [[0, 299]], false, { kind: 'other', tag: 'div' }),
    ]
    expect(pickLayers(media, 300).map((l) => l.name)).toEqual(['Mimi.mp4', 'trilha.mp3'])
  })

  it('does not list a <video> twice (the wrapper that CONTAINS it is not the media)', () => {
    // The runtime marks the container as "video" (it has a video inside), but the layer
    // is really the <video>: the tag separates the two.
    const wrapper = [
      raw('.hero', -1, [[0, 299]], false, { kind: 'video', tag: 'div' }),
      raw('Mimi.mp4', 0, [[0, 299]], false, { kind: 'video', tag: 'video' }),
    ]
    expect(pickLayers(wrapper, 300).map((l) => l.name)).toEqual(['Mimi.mp4'])
  })

  it('caps the number of tracks', () => {
    const many = Array.from({ length: 60 }, (_, i) => raw(`p${i}`, -1, [[i, i + 5]]))
    expect(pickLayers(many, 300, 40)).toHaveLength(40)
  })
})

describe('describeLayers', () => {
  it('writes one line per layer with enter/leave times and frames', () => {
    const text = describeLayers(
      [
        { name: 'title', named: true, spans: [[24, 185]] },
        { name: 'DE MAIS', named: false, spans: [[90, 150]] },
      ],
      30,
    )
    expect(text).toBe(['- title: 0:00.80–0:06.20 (f24–f185)', '- "DE MAIS": 0:03.00–0:05.03 (f90–f150)'].join('\n'))
  })

  it('says so when nothing moves', () => {
    expect(describeLayers([], 30)).toMatch(/No element enters or leaves/)
  })
})
