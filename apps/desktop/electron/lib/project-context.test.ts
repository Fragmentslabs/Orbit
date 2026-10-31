import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { discoverContextFiles, formatContextFiles, projectContextBlock } from './project-context'

let root: string

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'orbit-ctx-'))
  mkdirSync(path.join(root, '.git'))
  mkdirSync(path.join(root, 'pkg', 'app'), { recursive: true })
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('project context files', () => {
  it('walks up to the repository root, outermost first', async () => {
    writeFileSync(path.join(root, 'AGENTS.md'), 'root rules')
    writeFileSync(path.join(root, 'pkg', 'CLAUDE.md'), 'pkg rules')
    const files = await discoverContextFiles([path.join(root, 'pkg', 'app')])
    expect(files.map((f) => f.content)).toEqual(['root rules', 'pkg rules'])
  })

  it('prefers AGENTS.md over CLAUDE.md in the same folder', async () => {
    writeFileSync(path.join(root, 'AGENTS.md'), 'agents')
    writeFileSync(path.join(root, 'CLAUDE.md'), 'claude')
    const files = await discoverContextFiles([root])
    expect(files.map((f) => f.content)).toEqual(['agents'])
  })

  it('does not climb above the repository root', async () => {
    const outer = path.dirname(root)
    expect((await discoverContextFiles([root])).every((f) => f.path.startsWith(root))).toBe(true)
    expect(outer).not.toBe(root)
  })

  it('returns nothing, and an empty block, when there are no files', async () => {
    expect(await projectContextBlock(root)).toBe('')
  })

  it('truncates a huge file and caps the total', () => {
    const big = 'x'.repeat(20_000)
    const out = formatContextFiles([
      { path: '/a/AGENTS.md', content: big },
      { path: '/b/AGENTS.md', content: big },
      { path: '/c/AGENTS.md', content: big },
    ])
    expect(out.length).toBeLessThan(17_500)
    expect(out).toContain('truncated')
  })
})
