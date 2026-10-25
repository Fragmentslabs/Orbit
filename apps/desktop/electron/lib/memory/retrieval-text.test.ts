/**
 * O texto indexável de uma memória — a regra que vale para toda memória NOVA.
 *
 * O teto de `RETRIEVAL_TEXT_MAX_CHARS` existe para o enriquecimento não diluir
 * o vetor; ele nunca pode custar o próprio fato. Estes casos fixam isso: o
 * `text` é conteúdo e entra inteiro, sempre.
 */
import { describe, expect, it } from 'vitest'
import { buildRetrievalText } from '@shared/memory-retrieval'

const src = (over: { text?: string; tags?: string[]; title?: string; summary?: string } = {}) => ({
  text: '',
  tags: [],
  ...over,
})

describe('buildRetrievalText', () => {
  it('indexa o texto inteiro sem enriquecimento', () => {
    const text = 'a'.repeat(900)
    expect(buildRetrievalText(src({ text }))).toContain(text)
  })

  it('não perde o texto quando existe título', () => {
    const text = 'b'.repeat(900)
    const out = buildRetrievalText(src({ text, title: 'Um título curto e distinto' }))
    expect(out).toContain(text)
  })

  it('mantém o título junto do texto quando os dois cabem', () => {
    const text = 'c'.repeat(120)
    const out = buildRetrievalText(src({ text, title: 'Decisão sobre o relay' }))
    expect(out).toContain('Decisão sobre o relay')
    expect(out).toContain(text)
  })

  it('não duplica o título quando ele já abre o texto', () => {
    const out = buildRetrievalText(
      src({ text: 'Prefere respostas curtas. Sempre foi assim.', title: 'Prefere respostas curtas' }),
    )
    expect(out.match(/Prefere respostas curtas/g)).toHaveLength(1)
  })

  it('corta o resumo antes do texto', () => {
    const text = 'd'.repeat(200)
    const out = buildRetrievalText(src({ text, summary: 'e'.repeat(900) }))
    expect(out).toContain(text)
    expect(out).not.toContain('e'.repeat(900))
  })
})
