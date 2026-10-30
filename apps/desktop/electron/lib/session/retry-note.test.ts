import { describe, expect, it } from 'vitest'
import type { ChatMessage, TextPart, ToolPart } from '@shared/chat'
import { retryContextNote } from './retry-note'

function failed(over: Partial<ChatMessage> = {}): ChatMessage {
  return { id: 'a1', role: 'assistant', parts: [], createdAt: 0, ...over }
}

let next = 0
function tool(state: ToolPart['state'], error?: string): ToolPart {
  return { id: `t${next++}`, type: 'tool', tool: 'write', state, ...(error ? { error } : {}) }
}
function text(content: string): TextPart {
  return { id: `x${next++}`, type: 'text', text: content, state: 'done' }
}

describe('retryContextNote', () => {
  it('with nothing executed: it says the work starts from the same point', () => {
    const note = retryContextNote(failed({ error: 'rate limited' }))
    expect(note).toContain('RETRY')
    expect(note).toContain('rate limited')
    expect(note).toContain('nothing had run')
  })

  it('with tool calls and written files: it lists the paths and tells you to check', () => {
    const note = retryContextNote(
      failed({
        error: 'tool blew up',
        parts: [tool('done'), tool('error', 'boom')],
        snapshot: { authored: ['src/a.ts', 'src/b.ts'] },
      }),
    )
    expect(note).toContain('after 2 tool calls (1 of them ended in error)')
    expect(note).toContain('src/a.ts, src/b.ts')
    expect(note).toContain('may be half-done')
  })

  it('never cites more than 12 paths — the rest becomes a count', () => {
    const authored = Array.from({ length: 15 }, (_, i) => `f${i}.ts`)
    const note = retryContextNote(failed({ parts: [tool('done')], snapshot: { authored } }))
    expect(note).toContain('f11.ts')
    expect(note).not.toContain('f12.ts')
    expect(note).toContain('(+3 more)')
  })

  it('interrupted by the person (no error): it says it was interrupted', () => {
    const note = retryContextNote(failed({ parts: [tool('error', 'Interrupted.')] }))
    expect(note).toContain('was interrupted')
    expect(note).toContain('check the real state')
  })

  it('carries the end of what was already written, so the model does not contradict itself', () => {
    const note = retryContextNote(
      failed({
        error: 'boom',
        parts: [text('Vou refatorar o store.\n\nComecei pelo sendMessage'), tool('done')],
      }),
    )
    expect(note).toContain('its last text stopped at')
    expect(note).toContain('Comecei pelo sendMessage')
    expect(note.split('\n')).toHaveLength(1)
  })

  it('a path with a bracket does not break the marker', () => {
    const note = retryContextNote(failed({ parts: [tool('done')], snapshot: { authored: ['src/[id].tsx'] } }))
    expect(note).toContain('src/id.tsx')
    expect(note.slice(0, -1)).not.toContain(']')
  })

  it('the error text does not break the marker: one line, no inner "]"', () => {
    const note = retryContextNote(
      failed({ error: 'Invalid value for \'tools\':\n[invalid_value] maximum is 128 ] oops' }),
    )
    expect(note.split('\n')).toHaveLength(1)
    expect(note.startsWith('[SYSTEM: ')).toBe(true)
    expect(note.endsWith(']')).toBe(true)
    // A single "]" — the one at the end. Any other would make the line not match
    // ENGINE_MARKER_LINE and the marker would leak into the visible answer.
    expect(note.slice(0, -1)).not.toContain(']')
    expect(note).toContain('maximum is 128')
  })
})
