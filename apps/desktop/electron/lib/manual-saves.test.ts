import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'

import {
  manualSavesUnder,
  recordManualSave,
  resetManualSaves,
  stripFilesFromPatch,
} from './manual-saves'

/**
 * What is at stake here is the honesty of the verified record. Subtracting too
 * little makes the engine credit the agent with a file the person saved by hand;
 * subtracting too much hides a real write by the agent, which is worse — it is
 * exactly the false claim the verification exists to catch.
 */

const root = path.resolve('/repo')

beforeEach(resetManualSaves)

describe('manualSavesUnder', () => {
  it('returns the relative path with the git separator', () => {
    recordManualSave(path.join(root, 'src', 'app.ts'))
    expect(manualSavesUnder(root)).toEqual(new Set(['src/app.ts']))
  })

  it('ignores what was saved outside the turn directory', () => {
    // Two folders open in the workspace, a single turn: the save in the other folder cannot
    // vanish from this one's verdict.
    recordManualSave(path.join(root, 'inside.ts'))
    recordManualSave(path.resolve('/other', 'outside.ts'))
    expect(manualSavesUnder(root)).toEqual(new Set(['inside.ts']))
  })

  it('does not confuse a sibling folder with a similar prefix', () => {
    recordManualSave(path.resolve('/repo-legacy', 'a.ts'))
    expect(manualSavesUnder(root).size).toBe(0)
  })

  it('counts only the saves since the start of the turn — and does not delete those of another turn', () => {
    recordManualSave(path.join(root, 'before.ts'), 1_000)
    recordManualSave(path.join(root, 'during.ts'), 2_000)
    // A turn that started at 1500 sees only the save at 2000; one that started earlier sees both.
    expect(manualSavesUnder(root, 1_500)).toEqual(new Set(['during.ts']))
    expect(manualSavesUnder(root, 500)).toEqual(new Set(['before.ts', 'during.ts']))
  })
})

describe('stripFilesFromPatch', () => {
  const patch = [
    'diff --git a/src/agent.ts b/src/agent.ts',
    'index 111..222 100644',
    '--- a/src/agent.ts',
    '+++ b/src/agent.ts',
    '@@ -1 +1 @@',
    '-old',
    '+new',
    'diff --git a/src/user.ts b/src/user.ts',
    'index 333..444 100644',
    '--- a/src/user.ts',
    '+++ b/src/user.ts',
    '@@ -1 +1 @@',
    '-my old',
    '+my new',
    '',
  ].join('\n')

  it('removes only the section of the excluded file', () => {
    const result = stripFilesFromPatch(patch, new Set(['src/user.ts']))
    expect(result).toContain('a/src/agent.ts')
    expect(result).not.toContain('a/src/user.ts')
    expect(result).not.toContain('my new')
    expect(result).toContain('+new')
  })

  it('returns the patch intact when there is nothing to exclude', () => {
    expect(stripFilesFromPatch(patch, new Set())).toBe(patch)
  })

  it('empties when all the files belonged to the user', () => {
    const excluded = new Set(['src/agent.ts', 'src/user.ts'])
    expect(stripFilesFromPatch(patch, excluded)).toBe('')
  })

  it('does not cut on a content line that looks like a header', () => {
    // A line from the BODY of the diff always comes prefixed (' ', '+', '-'), so
    // a "diff --git" inside the code cannot be read as a boundary.
    const trap = [
      'diff --git a/doc.md b/doc.md',
      '--- a/doc.md',
      '+++ b/doc.md',
      '@@ -1 +1,2 @@',
      ' text',
      '+diff --git a/fake b/fake',
      '',
    ].join('\n')
    expect(stripFilesFromPatch(trap, new Set(['other.ts']))).toBe(trap)
  })
})
