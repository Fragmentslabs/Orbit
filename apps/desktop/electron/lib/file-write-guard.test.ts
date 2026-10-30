import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { checkWritePath } from './file-write-guard'

/**
 * This is the only door through which the renderer writes to disk. A hole here does not
 * show up as a bug on screen — it shows up as a file overwritten outside the project,
 * or as a corrupted repository.
 */

const root = path.resolve('/repo')

describe('checkWritePath', () => {
  it('accepts a file inside the root', () => {
    const verdict = checkWritePath(path.join(root, 'src', 'app.ts'), [root])
    expect(verdict.ok).toBe(true)
  })

  it('accepts when the target is in one of several roots', () => {
    const other = path.resolve('/other')
    expect(checkWritePath(path.join(other, 'a.ts'), [root, other]).ok).toBe(true)
  })

  it('refuses outside the root', () => {
    const verdict = checkWritePath(path.resolve('/etc', 'hosts'), [root])
    expect(verdict).toEqual({ ok: false, reason: 'outside-workspace' })
  })

  it('refuses to escape via ..', () => {
    const verdict = checkWritePath(path.join(root, '..', 'neighbor', 'a.ts'), [root])
    expect(verdict).toEqual({ ok: false, reason: 'outside-workspace' })
  })

  it('does not accept a sibling folder with a similar prefix', () => {
    // `/repo-legacy` starts with `/repo` as TEXT, but it is not inside it.
    const verdict = checkWritePath(path.resolve('/repo-legacy', 'a.ts'), [root])
    expect(verdict).toEqual({ ok: false, reason: 'outside-workspace' })
  })

  it('refuses the git directory, even inside the root', () => {
    // A save here corrupts the repository, and nothing the panel opens to read
    // needs to be rewritten inside .git.
    const verdict = checkWritePath(path.join(root, '.git', 'config'), [root])
    expect(verdict).toEqual({ ok: false, reason: 'git-internal' })
  })

  it('refuses .git at any depth', () => {
    const verdict = checkWritePath(path.join(root, 'sub', '.git', 'HEAD'), [root])
    expect(verdict).toEqual({ ok: false, reason: 'git-internal' })
  })

  it('refuses when there is no root at all', () => {
    // A workspace with no open folder cannot become permission to write
    // anywhere.
    expect(checkWritePath(path.resolve('/anywhere', 'a.ts'), []).ok).toBe(false)
  })
})
