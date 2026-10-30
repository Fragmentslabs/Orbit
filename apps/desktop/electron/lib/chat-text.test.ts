import { describe, expect, it } from 'vitest'
import type { ChatMessage, MessagePart, ReasoningPart, TextPart, ToolPart } from '@shared/chat'
import { lastProseText, lastTextRunStart } from '@shared/chat-text'

let seq = 0
const text = (t: string, source?: TextPart['source']): TextPart => ({
  id: `p${++seq}`,
  type: 'text',
  text: t,
  state: 'done',
  ...(source ? { source } : {}),
})
const reasoning = (t: string): ReasoningPart => ({
  id: `p${++seq}`,
  type: 'reasoning',
  text: t,
  state: 'done',
})
const tool = (): ToolPart => ({
  id: `p${++seq}`,
  type: 'tool',
  tool: 'bash',
  state: 'done',
  output: 'ok',
})

const messagePart = (...parts: MessagePart[]): ChatMessage => ({
  id: 'msg_1',
  role: 'assistant',
  parts,
  createdAt: 0,
})

describe('lastProseText', () => {
  it('returns the answer, not the narration before the tool', () => {
    const m = messagePart(
      text('I will implement. First I need to reread the pieces.'),
      tool(),
      text('Implemented. The title is now born on send.'),
    )
    expect(lastProseText(m)).toBe('Implemented. The title is now born on send.')
  })

  it('joins text separated only by reasoning (auto-continue)', () => {
    const m = messagePart(
      tool(),
      text('First half of the answer.'),
      reasoning('resuming from where it was cut'),
      text('Second half.'),
    )
    expect(lastProseText(m)).toBe('First half of the answer.\nSecond half.')
  })

  it('ignores the engine text after the answer', () => {
    const m = messagePart(
      tool(),
      text('The answer.'),
      text('anti-overclaim check', 'nudge'),
      text('closing the checklist', 'todo'),
      text('nothing to fix', 'internal'),
    )
    expect(lastProseText(m)).toBe('The answer.')
  })

  it('a turn that ends thinking keeps the last prose', () => {
    const m = messagePart(tool(), text('The answer.'), reasoning('checking'))
    expect(lastProseText(m)).toBe('The answer.')
  })

  it('does not treat an attachment or a vision caption as the answer', () => {
    const m = messagePart(
      tool(),
      text('content extracted from the PDF', 'attachment'),
      text('Analyzing the image…', 'vision'),
    )
    expect(lastProseText(m)).toBe('')
  })

  it('with no text at all returns empty', () => {
    expect(lastProseText(messagePart(tool()))).toBe('')
  })
})

describe('lastTextRunStart', () => {
  it('points at the start of the last block', () => {
    const parts = [text('narration'), tool(), text('answer')]
    expect(lastTextRunStart(parts.map((part) => ({ kind: 'part', part })))).toBe(2)
  })

  it('requireProse ignores a block that only has reasoning', () => {
    const parts = [text('answer'), tool(), reasoning('thinking')]
    const segments = parts.map((part) => ({ kind: 'part', part }))
    expect(lastTextRunStart(segments)).toBe(2)
    expect(lastTextRunStart(segments, true)).toBe(0)
  })
})
