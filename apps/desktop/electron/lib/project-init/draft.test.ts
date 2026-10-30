import { describe, expect, it } from 'vitest'
import {
  commitOrder,
  createDraft,
  memoryText,
  removeNode,
  retireExisting,
  subprojectOf,
  upsertNode,
  validateDraft,
  type DraftNode,
  type ExistingTree,
} from './draft'

const none: ExistingTree = { ids: new Set() }

function node(partial: Partial<DraftNode> & { key: string }): DraftNode {
  return {
    title: partial.key,
    summary: `Specific summary of the node ${partial.key}, with enough content.`,
    category: 'structure',
    parent: 'root',
    related: [],
    tags: [],
    ...partial,
  }
}

/** Parent folder with front and backend, and one business rule that crosses both. */
function frontBack() {
  const draft = createDraft()
  expect(upsertNode(draft, none, node({ key: 'root', parent: null }))).toBeNull()
  expect(upsertNode(draft, none, node({ key: 'front', scope: 'front/' }))).toBeNull()
  expect(upsertNode(draft, none, node({ key: 'back', scope: 'backend' }))).toBeNull()
  expect(upsertNode(draft, none, node({ key: 'front-auth', parent: 'front' }))).toBeNull()
  expect(
    upsertNode(draft, none, node({ key: 'billing', category: 'decision', related: ['front', 'back'] })),
  ).toBeNull()
  return draft
}

describe('/init tree draft', () => {
  it('builds front, back and a cross-cutting rule with no problem', () => {
    const draft = frontBack()
    expect(validateDraft(draft, none)).toEqual([])
    expect(draft.nodes.get('front')?.scope).toBe('front')
  })

  it('there is no minimum of nodes: a project may have only the root', () => {
    const draft = createDraft()
    upsertNode(draft, none, node({ key: 'root', parent: null }))
    expect(validateDraft(draft, none)).toEqual([])
  })

  it('the parent must exist before the child', () => {
    const draft = createDraft()
    upsertNode(draft, none, node({ key: 'root', parent: null }))
    expect(upsertNode(draft, none, node({ key: 'x', parent: 'nao-existe' }))).toMatch(/does not exist/)
  })

  it('only one root', () => {
    const draft = frontBack()
    expect(upsertNode(draft, none, node({ key: 'another', parent: null }))).toMatch(/only one root/)
  })

  it('blocks cycles when moving a node under a descendant', () => {
    const draft = frontBack()
    expect(upsertNode(draft, none, node({ key: 'front', parent: 'front-auth' }))).toMatch(/cycle/)
  })

  it('a long summary is refused: the detail goes to the document', () => {
    const draft = createDraft()
    const error = upsertNode(draft, none, node({ key: 'root', parent: null, summary: 'x'.repeat(400) }))
    expect(error).toMatch(/document/)
  })

  it('does not remove a node with children', () => {
    const draft = frontBack()
    expect(removeNode(draft, 'front')).toMatch(/has children/)
    expect(removeNode(draft, 'front-auth')).toBeNull()
    expect(removeNode(draft, 'front')).toBeNull()
    // The cross link to the removed node goes away with it.
    expect(draft.nodes.get('billing')?.related).toEqual(['back'])
  })

  it('parents are written before the children', () => {
    const order = commitOrder(frontBack()).map((n) => n.key)
    expect(order.indexOf('root')).toBeLessThan(order.indexOf('front'))
    expect(order.indexOf('front')).toBeLessThan(order.indexOf('front-auth'))
  })

  it('the subproject comes from the nearest folder node above', () => {
    const draft = frontBack()
    expect(subprojectOf(draft, 'front-auth')).toBe('front')
    expect(subprojectOf(draft, 'billing')).toBeUndefined()
  })

  it('two parts cannot represent the same folder', () => {
    const draft = frontBack()
    upsertNode(draft, none, node({ key: 'front2', scope: 'Front' }))
    expect(validateDraft(draft, none).join()).toMatch(/same folder/)
  })

  it('the saved text opens with the title (it is the label in the graph)', () => {
    expect(memoryText(node({ key: 'k', title: 'Frontend', summary: 'App React.' }))).toBe('Frontend: App React.')
  })
})

describe('draft over a tree that already exists (re-init)', () => {
  const existing: ExistingTree = { ids: new Set(['mem_root', 'mem_front', 'mem_old']), rootId: 'mem_root' }

  it('the draft root rewrites the existing root instead of creating another', () => {
    const draft = createDraft()
    expect(upsertNode(draft, existing, node({ key: 'root', parent: null }))).toBeNull()
    expect(draft.nodes.get('root')?.updates).toBe('mem_root')
  })

  it('a new node may hang on an existing node, with no root in the draft', () => {
    const draft = createDraft()
    expect(upsertNode(draft, existing, node({ key: 'front-state', parent: 'mem_front' }))).toBeNull()
    expect(validateDraft(draft, existing)).toEqual([])
  })

  it('an existing memory is only rewritten by one node', () => {
    const draft = createDraft()
    upsertNode(draft, existing, node({ key: 'a', parent: 'mem_root', updates: 'mem_front' }))
    expect(upsertNode(draft, existing, node({ key: 'b', parent: 'mem_root', updates: 'mem_front' }))).toMatch(/already updated/)
  })

  it('retire: never the root, nor what is being updated or has children in the draft', () => {
    const draft = createDraft()
    upsertNode(draft, existing, node({ key: 'a', parent: 'mem_front' }))
    expect(retireExisting(draft, existing, 'mem_root', 'obsolete, redone')).toMatch(/root/)
    expect(retireExisting(draft, existing, 'mem_front', 'obsoleta, refeita')).toMatch(/hangs on/)
    expect(retireExisting(draft, existing, 'mem_old', 'too generic')).toBeNull()
    expect(upsertNode(draft, existing, node({ key: 'b', parent: 'mem_root', updates: 'mem_old' }))).toMatch(/was retired/)
  })
})
