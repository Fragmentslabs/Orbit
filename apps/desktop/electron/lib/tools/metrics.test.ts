import { describe, expect, it } from 'vitest'
import type { MessagePart } from '@shared/chat'
import { usageFromParts } from './metrics'

/** A ToolPart as the engine writes it in the assistant message. */
function tool(name: string, state: 'done' | 'error' | 'running' = 'done'): MessagePart {
  return { id: `${name}-${Math.random()}`, type: 'tool', tool: name, state }
}

describe('usage read from the turn', () => {
  it('counts tool calls by name and does not repeat the same tool', () => {
    const usage = usageFromParts([tool('pdf_merge'), tool('pdf_merge'), tool('git_status')])
    expect(usage.calls).toEqual(['git_status', 'pdf_merge'])
  })

  it('counts tools_load apart — it is the hop telemetry wants to measure', () => {
    const usage = usageFromParts([tool('tools_load'), tool('tools_load'), tool('pdf_merge')])
    expect(usage.loads).toBe(2)
    expect(usage.calls).toEqual(['pdf_merge', 'tools_load'])
  })

  it('counts only a call that ended in error', () => {
    const usage = usageFromParts([tool('a', 'error'), tool('b', 'done'), tool('c', 'running')])
    expect(usage.failed).toBe(1)
  })

  it('ignores parts that are not tools', () => {
    const usage = usageFromParts([{ id: 't', type: 'text', text: 'oi' } as MessagePart])
    expect(usage).toEqual({ loads: 0, calls: [], failed: 0 })
  })
})
