import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }))
vi.mock('ai', () => ({ streamText: vi.fn() }))
vi.mock('../catalog', () => ({ getProvider: vi.fn() }))
vi.mock('../providers', () => ({ resolveModel: vi.fn() }))
vi.mock('../reasoning', () => ({ interleavedReasoningField: vi.fn(), normalizeMessages: vi.fn() }))

import { suggestionFrom } from './generator'

describe('suggestionFrom', () => {
  it('turns the model answer into a hook input', () => {
    const input = suggestionFrom({
      event: 'post_tool_call',
      match: 'edit|write',
      command: '  npx prettier --write "$ORBIT_FILE"  ',
      description: ' Formata ao editar ',
      timeoutSeconds: 20,
    })
    expect(input).toEqual({
      event: 'post_tool_call',
      match: 'edit|write',
      command: 'npx prettier --write "$ORBIT_FILE"',
      description: 'Formata ao editar',
      timeoutMs: 20_000,
    })
  })

  it('falls back to every tool and to a post hook, and caps the timeout', () => {
    const input = suggestionFrom({ event: 'whatever', command: 'echo hi', timeoutSeconds: 9999 })
    expect(input?.event).toBe('post_tool_call')
    expect(input?.match).toBe('*')
    expect(input?.timeoutMs).toBe(60_000)
  })

  it('refuses an answer that is not a usable hook', () => {
    expect(suggestionFrom(null)).toBeNull()
    expect(suggestionFrom({ event: 'pre_tool_call', match: 'bash' })).toBeNull()
    expect(suggestionFrom({ event: 'pre_tool_call', match: '(', command: 'exit 2' })).toBeNull()
  })
})
