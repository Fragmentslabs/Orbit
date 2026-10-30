import { describe, expect, it } from 'vitest'

import type { CatalogModel, ChatMessage, TokenUsage } from '@shared/chat'
import {
  buildCompactionTranscript,
  buildContinuationTranscript,
  countSummaries,
  findLastSummaryIndex,
  shouldCompact,
  splitForCompaction,
} from './compaction'

/**
 * Decisions that only fail in a long conversation, where the defect is expensive and hard to
 * reproduce: compacting too early throws context away needlessly;
 * compacting too late blows the model's limit and the turn dies.
 *
 * `compactHistory` does not enter here — it calls the model. What is covered is
 * the arithmetic that decides WHEN and WHAT to compact.
 */

const msg = (role: 'user' | 'assistant', over: Partial<ChatMessage> = {}): ChatMessage =>
  ({ id: Math.random().toString(36), role, parts: [], createdAt: 0, ...over }) as ChatMessage

/** Alternates user/assistant: [u, a, u, a, ...] */
const conversation = (pairs: number): ChatMessage[] =>
  Array.from({ length: pairs * 2 }, (_, i) => msg(i % 2 === 0 ? 'user' : 'assistant'))

const model = (context: number, output = 8_000): CatalogModel =>
  ({ id: 'm', name: 'M', limit: { context, output } }) as CatalogModel

const usage = (input: number, output = 0, lastStep?: { input: number; output: number }): TokenUsage =>
  ({ input, output, ...(lastStep ? { lastStep } : {}) }) as TokenUsage

describe('shouldCompact', () => {
  it('does not compact without usage or without a known model limit', () => {
    expect(shouldCompact(undefined, model(100_000))).toBe(false)
    expect(shouldCompact(usage(90_000), undefined)).toBe(false)
    expect(shouldCompact(usage(90_000), { id: 'm', name: 'M' } as CatalogModel)).toBe(false)
  })

  it('does not compact with loose context', () => {
    expect(shouldCompact(usage(10_000), model(200_000))).toBe(false)
  })

  it('compacts when touching the limit minus the output reserve', () => {
    // 100k of context, 8k of output + 4k of padding = it fires at 88k.
    expect(shouldCompact(usage(87_000), model(100_000))).toBe(false)
    expect(shouldCompact(usage(88_000), model(100_000))).toBe(true)
  })

  it('prefers lastStep over the turn total', () => {
    // input/output add up ALL the turn's steps (inflated by tool round
    // trips); lastStep is the real context of the last call. Using the total
    // would make the conversation compact long before it is needed.
    const inflated = usage(500_000, 20_000, { input: 10_000, output: 500 })
    expect(shouldCompact(inflated, model(200_000))).toBe(false)
  })

  it('falls back to the total when the message is old and has no lastStep', () => {
    expect(shouldCompact(usage(190_000), model(200_000))).toBe(true)
  })

  it('respects the absolute ceiling on giant-context models', () => {
    // Without the 300k ceiling, a 1M model would only compact near 1M — the
    // conversation would routinely operate with hundreds of thousands of tokens.
    expect(shouldCompact(usage(290_000), model(1_000_000, 8_000))).toBe(true)
  })

  it('limits the output reserve by the ceiling, not by what the model announces', () => {
    // The announced output of 64k is bigger than the 16k cap: the reserve used is 16k
    // + 4k, so it fires at 80k and not at 32k.
    expect(shouldCompact(usage(70_000), model(100_000, 64_000))).toBe(false)
    expect(shouldCompact(usage(80_000), model(100_000, 64_000))).toBe(true)
  })
})

describe('early shouldCompact (Preferences → Automatic compaction)', () => {
  it('compacts when passing the requested fraction, before the limit', () => {
    expect(shouldCompact(usage(80_000), model(200_000), 0, 0.5)).toBe(false)
    expect(shouldCompact(usage(100_000), model(200_000), 0, 0.5)).toBe(true)
    expect(shouldCompact(usage(150_000), model(200_000), 0, 0.75)).toBe(true)
  })

  it('the usual limit still applies', () => {
    expect(shouldCompact(usage(95_000), model(100_000), 0, 0.99)).toBe(true)
  })
})

describe('findLastSummaryIndex', () => {
  it('returns -1 without any summary', () => {
    expect(findLastSummaryIndex(conversation(3))).toBe(-1)
  })

  it('finds the LAST summary, not the first one', () => {
    const history = [msg('user'), msg('assistant', { summary: true }), msg('user'), msg('assistant', { summary: true })]
    expect(findLastSummaryIndex(history)).toBe(3)
  })
})

describe('splitForCompaction', () => {
  it('does not compact a short conversation — no pair is left before the tail', () => {
    expect(splitForCompaction(conversation(2))).toBeNull()
  })

  it('preserves the last two user turns intact', () => {
    const history = conversation(5) // 10 messages, users at 0,2,4,6,8
    const split = splitForCompaction(history)
    expect(split).not.toBeNull()
    // Cuts at the second-to-last user (index 6): 6 and 8 stay out of the summary.
    expect(split!.cutIndex).toBe(6)
    expect(split!.old).toHaveLength(6)
  })

  it('merges the previous summary into the new one instead of stacking summaries', () => {
    const history = [
      msg('user'),
      msg('assistant'),
      msg('assistant', { summary: true }),
      ...conversation(4),
    ]
    const split = splitForCompaction(history)
    // It starts AT the summary (index 2), not after it: the old summary enters the
    // new one. Starting after would make the conversation accumulate one summary per compaction.
    expect(split!.old[0].summary).toBe(true)
  })

  it('does not recompact what is already summarized when little is left after it', () => {
    const history = [msg('user'), msg('assistant', { summary: true }), msg('user'), msg('assistant')]
    expect(splitForCompaction(history)).toBeNull()
  })

  it('an empty history does not compact', () => {
    expect(splitForCompaction([])).toBeNull()
  })
})

describe('buildCompactionTranscript', () => {
  const said = (role: 'user' | 'assistant', text: string, over: Partial<ChatMessage> = {}) =>
    msg(role, { parts: [{ id: 'p', type: 'text', text, state: 'done' }], ...over } as Partial<ChatMessage>)

  it('keeps the previous summary whole even when the new stretch goes past the ceiling', () => {
    // Before, the text was cut only at the end: with 100k+ of new messages, the
    // previous summary — which stays at the start — vanished and the conversation forgot everything
    // that came before the last compaction.
    const old = [
      said('assistant', 'OLD-DECISION: use SQLite', { summary: true }),
      ...Array.from({ length: 30 }, (_, i) => said(i % 2 ? 'assistant' : 'user', `turn ${i} ` + 'x'.repeat(5_000))),
    ]
    const transcript = buildCompactionTranscript(old)
    expect(transcript).toContain('OLD-DECISION: use SQLite')
    expect(transcript.startsWith('Assistant: OLD-DECISION')).toBe(true)
    // The end of the new stretch stays too; the ceiling still applies.
    expect(transcript).toContain('turn 29')
    expect(transcript.length).toBeLessThanOrEqual(100_000)
  })

  it('without a previous summary, the end of the stretch stays within the ceiling', () => {
    const old = Array.from({ length: 30 }, (_, i) => said(i % 2 ? 'assistant' : 'user', `turn ${i} ` + 'x'.repeat(5_000)))
    const transcript = buildCompactionTranscript(old)
    expect(transcript).toContain('turn 29')
    expect(transcript).not.toContain('turn 0 ')
    expect(transcript.length).toBe(100_000)
  })

  it('a small stretch goes through whole', () => {
    const old = [said('assistant', 'summary', { summary: true }), said('user', 'hi'), said('assistant', 'hello')]
    expect(buildCompactionTranscript(old)).toBe('Assistant: summary\n\nUser: hi\n\nAssistant: hello')
  })
})

/**
 * The counter is what decides when the conversation starts offering a new chat:
 * `compactHistory` INSERTS the summary and never removes the old ones, so each
 * compaction leaves exactly one summary message in the history.
 */
describe('countSummaries', () => {
  it('counts one per compaction, including those already ignored by the cut', () => {
    const history = [
      msg('assistant', { summary: true }),
      msg('user'),
      msg('assistant'),
      msg('assistant', { summary: true }),
      msg('user'),
    ]
    expect(countSummaries(history)).toBe(2)
  })

  it('without compaction it is zero', () => {
    expect(countSummaries(conversation(3))).toBe(0)
  })
})

/**
 * The brief starts at the last summary: it is the one carrying the old decisions, and
 * cutting it at the ceiling (as the compaction text did before) would deliver to the
 * new chat a conversation without a beginning.
 */
describe('buildContinuationTranscript', () => {
  it('keeps the last summary whole and only cuts the new tail', () => {
    const history = [
      msg('assistant', { summary: true, parts: [{ id: '1', type: 'text', text: 'OLD-SUMMARY: use SQLite', state: 'done' }] }),
      ...Array.from({ length: 30 }, (_, i) => msg(i % 2 ? 'assistant' : 'user', { parts: [{ id: `p${i}`, type: 'text', text: `turn ${i} ` + 'x'.repeat(5_000), state: 'done' }] })),
    ]
    const transcript = buildContinuationTranscript(history)
    expect(transcript.startsWith('Assistant: OLD-SUMMARY')).toBe(true)
    expect(transcript).toContain('turn 29')
    expect(transcript.length).toBeLessThanOrEqual(100_000)
  })

  it('without a summary, uses the whole conversation (limited by the ceiling)', () => {
    const history = [msg('user', { parts: [{ id: 'u', type: 'text', text: 'hi', state: 'done' }] })]
    expect(buildContinuationTranscript(history)).toBe('User: hi')
  })
})
