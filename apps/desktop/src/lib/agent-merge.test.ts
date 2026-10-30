import { describe, expect, it } from 'vitest'

import { agentWriteFromTool, minimalChange, planMerge } from './agent-merge'

/**
 * Here it is decided what happens to what the person typed and has not saved yet
 * when the agent writes to the same file. Applying when it should not silently erases
 * work; refusing when merging was possible turns every agent edit
 * into a warning the person will learn to ignore.
 */

const apply = (plan: ReturnType<typeof planMerge>) =>
  plan.kind === 'apply' ? plan.changes : null

/** Applies the plan backwards: that way the offsets do not shift. */
function run(doc: string, plan: ReturnType<typeof planMerge>): string {
  const changes = apply(plan)
  if (!changes) throw new Error(`plan not applicable: ${plan.kind}`)
  let out = doc
  for (const c of [...changes].sort((a, b) => b.from - a.from)) {
    out = out.slice(0, c.from) + c.insert + out.slice(c.to)
  }
  return out
}

describe('minimalChange', () => {
  it('isolates the middle that changed', () => {
    const change = minimalChange('const a = 1\nconst b = 2\n', 'const a = 1\nconst b = 3\n')
    expect(change).not.toBeNull()
    // Only the "2" becomes "3": the rest of the file is not touched, and that is why the cursor
    // of whoever is reading further down does not move.
    expect(change!.insert).toBe('3')
    expect(change!.to - change!.from).toBe(1)
  })

  it('returns null when nothing changed', () => {
    expect(minimalChange('igual', 'igual')).toBeNull()
  })

  it('covers an insertion at the end without touching the beginning', () => {
    const change = minimalChange('a\n', 'a\nb\n')!
    expect(change.from).toBe(2)
    expect(change.insert).toBe('b\n')
  })
})

describe('planMerge — write', () => {
  it('applies the new content as a point change', () => {
    const doc = 'linha 1\nlinha 2\nlinha 3\n'
    const plan = planMerge(doc, { kind: 'write', content: 'linha 1\nDOIS\nlinha 3\n' })
    expect(run(doc, plan)).toBe('linha 1\nDOIS\nlinha 3\n')
  })

  it('does nothing when the buffer is already as the agent wants', () => {
    expect(planMerge('x', { kind: 'write', content: 'x' })).toEqual({ kind: 'noop' })
  })
})

describe('planMerge — edit', () => {
  const doc = 'function a() {}\nfunction b() {}\n'

  it('merges the replacement when the excerpt is unique', () => {
    const plan = planMerge(doc, { kind: 'edit', oldString: 'function b', newString: 'function c' })
    expect(run(doc, plan)).toBe('function a() {}\nfunction c() {}\n')
  })

  it("preserves the draft of the person elsewhere in the file", () => {
    // The point of the merge: she wrote on line 1, the agent changed line 2, and both
    // things survive. Reloading from disk would lose hers.
    const withDraft = 'function a() { /* meu rascunho */ }\nfunction b() {}\n'
    const plan = planMerge(withDraft, {
      kind: 'edit',
      oldString: 'function b',
      newString: 'function c',
    })
    expect(run(withDraft, plan)).toBe('function a() { /* meu rascunho */ }\nfunction c() {}\n')
  })

  it('reports a conflict when the excerpt vanished from the buffer', () => {
    // She rewrote exactly the region the agent was going to replace.
    const plan = planMerge('outra coisa\n', {
      kind: 'edit',
      oldString: 'function b',
      newString: 'function c',
    })
    expect(plan).toEqual({ kind: 'conflict', reason: 'not-found' })
  })

  it('reports a conflict when it became ambiguous', () => {
    // The agent counted on a unique stretch; if there are two now, the buffer diverged
    // from what it read and picking the first would be a guess.
    const duplicated = 'chame()\nchame()\n'
    const plan = planMerge(duplicated, { kind: 'edit', oldString: 'chame()', newString: 'ok()' })
    expect(plan).toEqual({ kind: 'conflict', reason: 'ambiguous' })
  })

  it('replaceAll replaces every occurrence', () => {
    const duplicated = 'chame()\nchame()\n'
    const plan = planMerge(duplicated, {
      kind: 'edit',
      oldString: 'chame()',
      newString: 'ok()',
      replaceAll: true,
    })
    expect(run(duplicated, plan)).toBe('ok()\nok()\n')
  })
})

describe('agentWriteFromTool', () => {
  it('reconhece write e edit', () => {
    expect(agentWriteFromTool('write', { filePath: 'a.ts', content: 'x' })).toEqual({
      filePath: 'a.ts',
      write: { kind: 'write', content: 'x' },
    })
    expect(
      agentWriteFromTool('edit', { filePath: 'a.ts', oldString: 'a', newString: 'b' }),
    ).toEqual({
      filePath: 'a.ts',
      write: { kind: 'edit', oldString: 'a', newString: 'b', replaceAll: false },
    })
  })

  it('ignora as demais tools e inputs incompletos', () => {
    // `bash` also writes files, but does not say which one nor what — it is the known
    // blind spot of this path, and guessing here would be worse.
    expect(agentWriteFromTool('bash', { command: 'sed -i s/a/b/ a.ts' })).toBeNull()
    expect(agentWriteFromTool('write', { filePath: 'a.ts' })).toBeNull()
    expect(agentWriteFromTool('edit', { filePath: 'a.ts', oldString: 'a' })).toBeNull()
  })
})
