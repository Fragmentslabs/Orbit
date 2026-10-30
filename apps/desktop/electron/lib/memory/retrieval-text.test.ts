/**
 * The indexable text of a memory — the rule that holds for every NEW memory.
 *
 * The `RETRIEVAL_TEXT_MAX_CHARS` ceiling exists so enrichment does not dilute
 * the vector; it can never cost the fact itself. These cases pin that down: the
 * `text` is content and always goes in whole.
 */
import { describe, expect, it } from 'vitest'
import { buildRetrievalText } from '@shared/memory-retrieval'

const src = (over: { text?: string; tags?: string[]; title?: string; summary?: string } = {}) => ({
  text: '',
  tags: [],
  ...over,
})

describe('buildRetrievalText', () => {
  it('indexes the whole text without enrichment', () => {
    const text = 'a'.repeat(900)
    expect(buildRetrievalText(src({ text }))).toContain(text)
  })

  it('does not lose the text when there is a title', () => {
    const text = 'b'.repeat(900)
    const out = buildRetrievalText(src({ text, title: 'Um título curto e distinto' }))
    expect(out).toContain(text)
  })

  it('keeps the title next to the text when both fit', () => {
    const text = 'c'.repeat(120)
    const out = buildRetrievalText(src({ text, title: 'Decisão sobre o relay' }))
    expect(out).toContain('Decisão sobre o relay')
    expect(out).toContain(text)
  })

  it('does not duplicate the title when it already opens the text', () => {
    const out = buildRetrievalText(
      src({ text: 'Prefere respostas curtas. Sempre foi assim.', title: 'Prefere respostas curtas' }),
    )
    expect(out.match(/Prefere respostas curtas/g)).toHaveLength(1)
  })

  it('cuts the summary before the text', () => {
    const text = 'd'.repeat(200)
    const out = buildRetrievalText(src({ text, summary: 'e'.repeat(900) }))
    expect(out).toContain(text)
    expect(out).not.toContain('e'.repeat(900))
  })
})
