import { describe, expect, it } from 'vitest'
import type { TimedWord } from './edl'
import { silencesIn } from './timeline'

const w = (text: string, startMs: number, endMs: number): TimedWord => ({ text, startMs, endMs })

describe('silencesIn', () => {
  it('sem transcrição não declara silêncio nenhum', () => {
    // Música/ambiente não têm transcrição: `words` vazio não é uma pausa de
    // 9 s, é ausência de medida — o vídeo com trilha era reportado inteiro
    // como silêncio.
    expect(silencesIn([], 0, 9200)).toEqual([])
  })

  it('acha as lacunas entre duas falas, inclusive nas bordas da janela', () => {
    const words = [w('a', 1000, 1500), w('b', 3000, 3400)]
    expect(silencesIn(words, 0, 4000)).toEqual([
      { startMs: 0, endMs: 1000 },
      { startMs: 1500, endMs: 3000 },
      { startMs: 3400, endMs: 4000 },
    ])
  })

  it('ignora lacuna menor que o mínimo', () => {
    const words = [w('a', 1000, 1500), w('b', 1800, 2000)]
    expect(silencesIn(words, 1000, 2000, 400)).toEqual([])
  })

  it('janela dentro de uma fala não tem silêncio', () => {
    const words = [w('longa', 0, 5000)]
    expect(silencesIn(words, 1000, 2000, 400)).toEqual([])
  })
})
