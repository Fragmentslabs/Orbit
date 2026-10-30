import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Memory } from '@shared/memory'
import { isWithinSubproject, pickProjectRoot, projectIdOf } from './domain'
import { buildProjectMap } from './project-map'

const app = path.resolve('/work/app')
const roots = [
  { projectId: projectIdOf(app), directory: app },
  { projectId: projectIdOf(path.join(app, 'apps', 'mobile')), directory: path.join(app, 'apps', 'mobile') },
]

describe('project that covers a folder', () => {
  it('the root itself has no subproject', () => {
    expect(pickProjectRoot(roots, app)).toEqual({ root: roots[0] })
  })

  it('a chat opened in "front" sees the tree of the parent folder', () => {
    const picked = pickProjectRoot(roots, path.join(app, 'front', 'src'))
    expect(picked?.root).toBe(roots[0])
    expect(picked?.subproject).toBe('front/src')
  })

  it('the closest project wins when one is inside the other', () => {
    const picked = pickProjectRoot(roots, path.join(app, 'apps', 'mobile', 'src'))
    expect(picked?.root).toBe(roots[1])
    expect(picked?.subproject).toBe('src')
  })

  it('a folder with a similar prefix does not count as inside ("app-old" is not in "app")', () => {
    expect(pickProjectRoot(roots, path.resolve('/work/app-old'))).toBeNull()
  })

  it('a subfolder only matches by whole segment', () => {
    expect(isWithinSubproject('front/src', 'front')).toBe(true)
    expect(isWithinSubproject('Front', 'front')).toBe(true)
    expect(isWithinSubproject('frontend', 'front')).toBe(false)
  })
})

let seq = 0
function mem(partial: Partial<Memory> & { id: string }): Memory {
  return {
    kind: 'project',
    text: partial.id,
    tags: [],
    weight: 0.7,
    hits: 0,
    relatedIds: [],
    createdAt: ++seq,
    ...partial,
  }
}

/** Links both sides, the way service.link does. */
function link(members: Memory[], a: string, b: string) {
  members.find((m) => m.id === a)!.relatedIds.push(b)
  members.find((m) => m.id === b)!.relatedIds.push(a)
}

describe('tree map for the prompt', () => {
  function tree() {
    const members = [
      mem({ id: 'root', area: 'overview', weight: 0.9, hasDoc: true }),
      mem({ id: 'front', subproject: 'front', weight: 0.85 }),
      mem({ id: 'back', subproject: 'backend', weight: 0.85 }),
      mem({ id: 'rules', weight: 0.8, hasDoc: true }),
      mem({ id: 'front-auth', subproject: 'front' }),
      mem({ id: 'front-ui', subproject: 'front' }),
      mem({ id: 'back-db', subproject: 'backend' }),
    ]
    link(members, 'root', 'front')
    link(members, 'root', 'back')
    link(members, 'root', 'rules')
    link(members, 'front', 'front-auth')
    link(members, 'front', 'front-ui')
    link(members, 'back', 'back-db')
    // A business rule also linked to both parts: it cannot become a child of theirs.
    link(members, 'rules', 'front')
    link(members, 'rules', 'back')
    return members
  }

  it('at the root: the root and the first level, with how many children each one has', () => {
    const map = buildProjectMap(tree())!
    expect(map.root.id).toBe('root')
    expect(map.children.map((n) => n.id).sort()).toEqual(['back', 'front', 'rules'])
    expect(map.children.find((n) => n.id === 'front')?.children).toBe(2)
    expect(map.branch).toBeUndefined()
    expect(map.omitted).toBe(3)
  })

  it('in a subfolder: its branch too', () => {
    const map = buildProjectMap(tree(), 'front/src/pages')!
    expect(map.branch?.node.id).toBe('front')
    expect(map.branch?.children.map((n) => n.id).sort()).toEqual(['front-auth', 'front-ui'])
    expect(map.omitted).toBe(1)
  })

  it('the branch is the node of the part, even if a child of it (same folder) was created before', () => {
    const members = tree()
    // Front session memory, created before /init: it comes first in the list.
    const early = members.find((m) => m.id === 'front-auth')!
    const reordered = [early, ...members.filter((m) => m !== early)]
    expect(buildProjectMap(reordered, 'front')!.branch?.node.id).toBe('front')
  })

  it('a subfolder with no node of its own keeps only the general map', () => {
    expect(buildProjectMap(tree(), 'docs')!.branch).toBeUndefined()
  })

  it('a project with no memories has no map', () => {
    expect(buildProjectMap([])).toBeNull()
  })
})
