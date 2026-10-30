import { describe, expect, it } from 'vitest'

import type { ChatMessage } from '@shared/chat'
import { engineAnnotations, stripEngineMarkers } from './todo-context'

/**
 * Two responsibilities with a silent failure:
 *
 * 1. `engineAnnotations` glues to the history the turn's MEASURED verdict (the
 *    filesystem snapshot) next to the agent's narrative. If it stops
 *    emitting, "I implemented X" travels through the history on its own again and the
 *    following turns treat the claim as fact.
 * 2. `stripEngineMarkers` prevents those same markers from leaking into the
 *    text the user reads — the model copies the format when the history is
 *    long.
 */

const message = (over: Partial<ChatMessage> = {}): ChatMessage =>
  ({ id: 'm1', role: 'assistant', parts: [], createdAt: 0, ...over }) as ChatMessage

const todoPart = (items: { content: string; status: string }[]) =>
  ({ type: 'tool', tool: 'todowrite', state: 'done', input: { items } }) as never

describe('engineAnnotations', () => {
  it('with no TODO and no snapshot, notes nothing', () => {
    expect(engineAnnotations(message())).toBe('')
  })

  it('re-emits the TODO state, which the ToolParts do not carry to the model', () => {
    const out = engineAnnotations(
      message({
        parts: [
          todoPart([
            { content: 'Read the code', status: 'completed' },
            { content: 'Write the test', status: 'in_progress' },
            { content: 'Run the suite', status: 'pending' },
          ]),
        ],
      }),
    )
    expect(out).toContain('[TODO for this response]')
    expect(out).toContain('- [x] Read the code')
    expect(out).toContain('- [~] Write the test')
    expect(out).toContain('- [ ] Run the suite')
  })

  it('uses the last todowrite call of the turn', () => {
    const out = engineAnnotations(
      message({
        parts: [
          todoPart([{ content: 'Old', status: 'pending' }]),
          todoPart([{ content: 'Current', status: 'completed' }]),
        ],
      }),
    )
    expect(out).toContain('Current')
    expect(out).not.toContain('Old')
  })

  it('records that nothing was written when the snapshot says unchanged', () => {
    const out = engineAnnotations(message({ snapshot: { verified: 'unchanged' } as never }))
    expect(out).toContain('NO file was modified in this turn')
  })

  it('contradicts the checklist when it says "completed" and nothing changed on disk', () => {
    // The narrative + measurement pair is the whole point of the module: without this note the
    // ticked checklist becomes the history's most convincing proof.
    const out = engineAnnotations(
      message({
        parts: [todoPart([{ content: 'Implementar', status: 'completed' }])],
        snapshot: { verified: 'unchanged' } as never,
      }),
    )
    expect(out).toContain('Marking an item done is a claim, not evidence')
  })

  it('lists the measured files when there was a write', () => {
    const out = engineAnnotations(
      message({ snapshot: { verified: 'changed', files: ['src/a.ts', 'src/b.ts'] } as never }),
    )
    expect(out).toContain('2 file(s) modified')
    expect(out).toContain('src/a.ts, src/b.ts')
  })

  it('summarizes the long file list instead of spending context', () => {
    const files = Array.from({ length: 15 }, (_, i) => `src/f${i}.ts`)
    const out = engineAnnotations(message({ snapshot: { verified: 'changed', files } as never }))
    expect(out).toContain('15 file(s) modified')
    expect(out).toContain('(+3 more)')
  })

  it('warns about a turn truncated by the step limit', () => {
    const out = engineAnnotations(message({ truncated: true } as never))
    expect(out).toContain('interrupted by hitting the step/tool limit')
  })

  it('re-emits the reminder of an open TODO', () => {
    const out = engineAnnotations(message({ todoReminder: true } as never))
    expect(out).toContain('still marked as "in_progress"')
  })
})

describe('stripEngineMarkers', () => {
  it('does not touch text without a marker', () => {
    expect(stripEngineMarkers('Normal answer.')).toBe('Normal answer.')
  })

  it('removes the footer the model copies from the context', () => {
    const out = stripEngineMarkers('Done, I fixed the selector.\n\n[Verified record: 1 file(s) modified in this turn — a.ts]')
    expect(out).toBe('Done, I fixed the selector.')
  })

  it('removes the [SYSTEM: ...] notice on its own line', () => {
    expect(stripEngineMarkers('Text.\n[SYSTEM: the TODO items above were marked completed]\nMore text.')).toBe(
      'Text.\nMore text.',
    )
  })

  it('preserves a mention in prose — the line is not only the marker', () => {
    const prose = 'The line [Verified record: ...] serves to contradict the narrative.'
    expect(stripEngineMarkers(prose)).toBe(prose)
  })

  it('preserves the marker inside a code block', () => {
    // This repository discusses its own markers in the code and in the docs.
    const text = 'Example:\n```\n[Verified record: NO file was modified in this turn]\n```\nEnd.'
    expect(stripEngineMarkers(text)).toContain('[Verified record:')
  })
})

/**
 * Artifacts: the `artifactId` only exists in the tool's RESULT, which does not go back to the
 * model in future turns (toModelMessages resends only text and reasoning).
 * Without this note, a change request in the following turn makes the model create
 * a SECOND artifact instead of updating the first — a duplicate in the conversation and
 * in the gallery.
 */
describe('engineAnnotations — artifacts', () => {
  const artifactPart = (artifactId: string, title: string, revision = 1) =>
    ({ id: `p-${artifactId}`, type: 'artifact', src: `orbit-artifact://${artifactId}`, artifactId, title, revision }) as never

  it('re-emits the artifact id so the next turn can update it', () => {
    const out = engineAnnotations(message({ parts: [artifactPart('art_a.html', 'Q4 Sales')] }))
    expect(out).toContain('art_a.html')
    expect(out).toContain('Q4 Sales')
    expect(out).toContain('update_artifact')
  })

  it('deduplicates by id when the agent creates and already fixes in the same turn', () => {
    const out = engineAnnotations(
      message({
        parts: [artifactPart('art_a.html', 'Q4 Sales', 1), artifactPart('art_a.html', 'Q4 Sales', 2)],
      }),
    )
    expect(out.match(/art_a\.html/g)).toHaveLength(1)
  })

  it('lists each artifact when the turn produced more than one', () => {
    const out = engineAnnotations(
      message({ parts: [artifactPart('art_a.html', 'Sales'), artifactPart('art_b.html', 'Costs')] }),
    )
    expect(out).toContain('art_a.html')
    expect(out).toContain('art_b.html')
  })

  it('the note is removable by stripEngineMarkers (the model copies the format)', () => {
    const out = engineAnnotations(message({ parts: [artifactPart('art_a.html', 'Q4 Sales')] }))
    expect(stripEngineMarkers(`Answer to the user.\n${out}`)).toBe('Answer to the user.')
  })

  it('a title with brackets does not break the whole-line marker', () => {
    const out = engineAnnotations(message({ parts: [artifactPart('art_a.html', 'Summary [beta]')] }))
    expect(stripEngineMarkers(`Text.\n${out}`)).toBe('Text.')
  })

  it('with no artifact in the turn, notes nothing', () => {
    expect(engineAnnotations(message())).toBe('')
  })
})
