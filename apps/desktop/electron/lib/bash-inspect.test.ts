import { describe, expect, it } from 'vitest'

import { parseFileView, parseInspection, symbolSearchPattern } from './bash-inspect'

/**
 * Erring toward "it is inspection" would make the context cut discard the record of a
 * command that changed the disk; erring toward "it is not" only keeps the previous
 * behavior. That is why the doubtful cases always fall into null.
 */

const dir = '/repo'

describe('parseInspection', () => {
  it('accepts reading and search, including in a pipe and after cd', () => {
    expect(parseInspection('grep -rn "foo" src | head -20', dir)).toEqual({
      cwd: '/repo',
      command: 'grep -rn "foo" src | head -20',
    })
    expect(parseInspection('cd apps/desktop && sed -n 1,80p main.ts', dir)?.cwd).toBe('/repo/apps/desktop')
    expect(parseInspection('rg foo 2>/dev/null', dir)?.command).toBe('rg foo')
  })

  it('refuses what may write or cannot be known', () => {
    for (const command of [
      'cat a.ts > b.ts',
      'sed -i s/a/b/ file.ts',
      'find . -name "*.tmp" -delete',
      'find . -exec rm {} ;',
      'grep foo a.ts; rm a.ts',
      'cat $(ls)',
      'npm test',
      'git status',
      'ls && npm run build',
    ]) {
      expect(parseInspection(command, dir), command).toBeNull()
    }
  })

  it('does not confuse a > inside the pattern with a redirection', () => {
    expect(parseInspection('grep -n "a > b" src/x.ts', dir)).not.toBeNull()
  })
})

describe('parseFileView', () => {
  const view = (command: string) => {
    const inspection = parseInspection(command, dir)
    return inspection && parseFileView(inspection)
  }

  it('recognizes the stretch each command shows', () => {
    expect(view('cat src/a.ts')).toEqual({ path: '/repo/src/a.ts', from: 1, to: Infinity })
    expect(view("sed -n '20,80p' src/a.ts")).toEqual({ path: '/repo/src/a.ts', from: 20, to: 80 })
    expect(view('head -n 50 src/a.ts')).toEqual({ path: '/repo/src/a.ts', from: 1, to: 50 })
    expect(view('cd src && head -30 a.ts')).toEqual({ path: '/repo/src/a.ts', from: 1, to: 30 })
  })

  it('stays out when the range or the file are not right', () => {
    expect(view('tail -n 20 src/a.ts')).toBeNull()
    expect(view('cat a.ts b.ts')).toBeNull()
    expect(view('cat src/*.ts')).toBeNull()
    expect(view('cat a.ts | grep foo')).toBeNull()
  })
})

describe('symbolSearchPattern', () => {
  const pattern = (command: string) => {
    const inspection = parseInspection(command, dir)
    return inspection && symbolSearchPattern(inspection)
  }

  it('recognizes the search by a name', () => {
    expect(pattern('grep -rn "trimTurnContext" apps')).toBe('trimTurnContext')
    expect(pattern('rg -n memory.search')).toBe('memory.search')
  })

  it('ignores free-text search', () => {
    expect(pattern('grep -rn "no such file" .')).toBeNull()
    expect(pattern('grep -rn "^export function" src')).toBeNull()
  })
})
