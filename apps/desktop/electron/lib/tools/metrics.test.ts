import { describe, expect, it } from 'vitest'
import { usageFromHistory } from './metrics'

/** A message in the AI SDK format: `content` is the list of parts. */
function message(parts: unknown[]): unknown {
  return { role: 'assistant', content: parts }
}

describe('usage read from the history', () => {
  it('counts tool-call by name and does not repeat the same tool', () => {
    const uso = usageFromHistory([
      message([
        { type: 'tool-call', toolName: 'pdf_merge' },
        { type: 'tool-call', toolName: 'pdf_merge' },
        { type: 'tool-call', toolName: 'git_status' },
      ]),
    ])
    expect(uso.calls).toEqual(['git_status', 'pdf_merge'])
  })

  it('counts tools_load apart — it is the hop telemetry wants to measure', () => {
    const uso = usageFromHistory([
      message([
        { type: 'tool-call', toolName: 'tools_load' },
        { type: 'tool-call', toolName: 'tools_load' },
        { type: 'tool-call', toolName: 'pdf_merge' },
      ]),
    ])
    expect(uso.loads).toBe(2)
    expect(uso.calls).toEqual(['pdf_merge', 'tools_load'])
  })

  it('counts only a result marked as error', () => {
    const uso = usageFromHistory([
      message([
        { type: 'tool-result', isError: true },
        { type: 'tool-result', isError: false },
        { type: 'tool-result' },
      ]),
    ])
    expect(uso.failed).toBe(1)
  })

  it('ignores a message without content in a list and a part that is not a tool', () => {
    const uso = usageFromHistory([
      { role: 'user', content: 'loose text' },
      null,
      message([{ type: 'text', text: 'oi' }, { type: 'tool-call' }]),
    ])
    expect(uso).toEqual({ loads: 0, calls: [], failed: 0 })
  })
})
