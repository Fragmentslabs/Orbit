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
  // Composição de 300 quadros: fundo e palco nomeados e sempre em cena, duas
  // frases sem nome dentro do palco (com palavras dentro), e um contêiner anônimo
  // que nunca sai.
  const layers = [
    raw('bg', -1, [[0, 299]], true), // 0
    raw('stage', -1, [[0, 299]], true), // 1
    raw('VOCÊ NÃO PRECISA', 1, [[30, 89]]), // 2
    raw('VOCÊ', 2, [[30, 89]]), // 3 — palavra da frase
    raw('PRECISA', 2, [[45, 89]]), // 4 — entra depois, mas é parte da frase
    raw('DE MAIS UMA FERRAMENTA', 1, [[90, 150]]), // 5
    raw('.wrapper', -1, [[0, 299]]), // 6 — anônimo e sempre lá
    raw('logo', 6, [[200, 299]], true), // 7 — nomeado dentro do anônimo
    raw('#ghost', -1, []), // 8 — nunca visível
  ]

  it('keeps every named layer, and the OUTERMOST unnamed element that enters or leaves', () => {
    const picked = pickLayers(layers, 300)
    expect(picked.map((l) => l.name)).toEqual(['bg', 'stage', 'VOCÊ NÃO PRECISA', 'DE MAIS UMA FERRAMENTA', 'logo'])
    expect(picked.find((l) => l.name === 'VOCÊ NÃO PRECISA')).toEqual({
      name: 'VOCÊ NÃO PRECISA',
      named: false,
      spans: [[30, 89]],
      // A posição na lista é o endereço do elemento (o retrato cru não declarou
      // `index`, então vale a ordem) e o tipo fica em "other" sem medição.
      index: 2,
      kind: 'other',
    })
  })

  it('leva o ENDEREÇO e o TIPO de cada camada — é o que a aba realça e desenha', () => {
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
      // O índice DECLARADO vence a posição na lista: é o runtime que sabe o
      // endereço, e um retrato reordenado não pode trocar o realce de elemento.
      ['player', 9, 'video'],
    ])
  })

  it('drops the words of a NAMED phrase that enters and leaves (they are parts of it)', () => {
    // O caso real da composição kinetic: data-layer="phrase-1" com uma palavra
    // por span, cada uma entrando num quadro.
    const phrase = [
      raw('stage', -1, [[0, 299]], true),
      raw('phrase-1', 0, [[1, 45]], true),
      raw('Oi,', 1, [[2, 45]]),
      raw('tudo', 1, [[29, 45]]),
      raw('phrase-2', 0, [[37, 93]], true),
    ]
    expect(pickLayers(phrase, 300).map((l) => l.name)).toEqual(['stage', 'phrase-1', 'phrase-2'])
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
