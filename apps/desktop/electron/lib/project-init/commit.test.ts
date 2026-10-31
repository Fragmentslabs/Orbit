import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Memory } from '@shared/memory'

/**
 * The writing of the /init draft against the real memory service.
 *
 * What these tests hold is what makes /init worth something afterwards:
 * the tree comes out with the shape the coordinator designed (without the automatic merge
 * swallowing sibling nodes with similar tags), and a chat opened in a subfolder finds
 * that tree and receives its branch in the map.
 */

const userData = path.join(os.tmpdir(), `orbit-init-commit-test-${process.pid}`)

vi.mock('electron', () => ({
  app: { getPath: () => userData },
  BrowserWindow: { getAllWindows: () => [] },
}))

const app = path.join(userData, 'workspace', 'app')

let memory: typeof import('../memory/service')
let commit: typeof import('./commit')
let draftLib: typeof import('./draft')

beforeAll(async () => {
  await fsp.mkdir(app, { recursive: true })
  memory = await import('../memory/service')
  commit = await import('./commit')
  draftLib = await import('./draft')
})

afterAll(async () => {
  await fsp.rm(userData, { recursive: true, force: true })
})

const summary = (what: string) => `Resumo de ${what}, specific enough to stand on its own.`

async function projectMembers(): Promise<Memory[]> {
  const scope = await memory.resolveProjectScope(app)
  return (await memory.list()).filter((m) => m.kind === 'project' && m.projectId === scope.projectId)
}

const byTitle = (members: Memory[], title: string) => members.find((m) => m.text.startsWith(`${title}:`))!

describe('save the tree of a parent folder with front and backend', () => {
  it('saves the drawn shape, without merging nodes of similar tags', async () => {
    const { createDraft, upsertNode } = draftLib
    const none = { ids: new Set<string>() }
    const draft = createDraft()
    const tags = ['typescript', 'app', 'web']
    upsertNode(draft, none, { key: 'root', title: 'App', summary: summary('o projeto'), category: 'structure', parent: null, related: [], tags })
    upsertNode(draft, none, { key: 'front', title: 'Frontend', summary: summary('o front'), category: 'structure', parent: 'root', related: [], tags, scope: 'front', document: '# Front\n\nDetalhes.' })
    upsertNode(draft, none, { key: 'back', title: 'Backend', summary: summary('o back'), category: 'structure', parent: 'root', related: [], tags, scope: 'backend' })
    upsertNode(draft, none, { key: 'auth', title: 'Login', summary: summary('o login'), category: 'decision', parent: 'front', related: [], tags })
    upsertNode(draft, none, { key: 'billing', title: 'Billing', summary: summary('the billing'), category: 'decision', parent: 'root', related: ['front', 'back'], tags })
    draft.learnings.push({ text: 'Vite: variáveis sem prefixo VITE_ não chegam ao cliente.', tags: ['vite'] })

    const result = await commit.commitDraft(draft, { rootDirectory: app, existing: none })
    expect(result).toMatchObject({ saved: true, created: 5, updated: 0, learnings: 1 })

    const members = await projectMembers()
    expect(members).toHaveLength(5)
    const root = byTitle(members, 'App')
    const front = byTitle(members, 'Frontend')
    const back = byTitle(members, 'Backend')
    expect(root.area).toBe('overview')
    expect(front.subproject).toBe('front')
    expect(back.subproject).toBe('backend')
    // The child inherits the folder of the part node above it.
    expect(byTitle(members, 'Login').subproject).toBe('front')
    // The cross-cutting rule stays at the root and linked to both parts.
    const billing = byTitle(members, 'Billing')
    expect(billing.subproject).toBeUndefined()
    expect(billing.relatedIds).toEqual(expect.arrayContaining([root.id, front.id, back.id]))
    expect(front.hasDoc).toBe(true)
  })

  it('a chat in a subfolder finds the parent tree and gets its branch in the map', async () => {
    const inside = path.join(app, 'front', 'src')
    const scope = await memory.resolveProjectScope(inside)
    expect(scope).toMatchObject({ covered: true, subproject: 'front/src' })
    expect(path.resolve(scope.directory)).toBe(path.resolve(app))

    const ctx = await memory.loadPromptContext('code', inside)
    expect(ctx.map?.root.text.startsWith('App:')).toBe(true)
    expect(ctx.map?.children.map((n) => n.text.split(':')[0]).sort()).toEqual(['Backend', 'Billing', 'Frontend'])
    expect(ctx.map?.branch?.node.text.startsWith('Frontend:')).toBe(true)
    expect(ctx.map?.branch?.children.map((n) => n.text.split(':')[0])).toEqual(['Login'])
  })

  it('a folder outside any tree keeps being its own project', async () => {
    const elsewhere = path.join(userData, 'workspace', 'outro')
    const scope = await memory.resolveProjectScope(elsewhere)
    expect(scope.covered).toBe(false)
    expect((await memory.loadPromptContext('code', elsewhere)).map).toBeUndefined()
  })

  it('re-init: updates in place, retires the obsolete one and reattaches the neighbor that would be orphaned', async () => {
    const before = await projectMembers()
    const root = byTitle(before, 'App')
    const back = byTitle(before, 'Backend')
    // Working session memory hanging only on Backend.
    const worker = await memory.save({
      kind: 'project',
      directory: app,
      category: 'convention',
      text: 'Queue: idempotent jobs by request key.',
      relatedIds: [back.id],
      relatedTypes: { [back.id]: 'parent' },
    })

    const existing = { ids: new Set([...before.map((m) => m.id), worker.id]), rootId: root.id }
    const { createDraft, upsertNode, retireExisting } = draftLib
    const draft = createDraft()
    expect(upsertNode(draft, existing, { key: 'root', title: 'App', summary: summary('o projeto, revisado'), category: 'structure', parent: null, related: [], tags: [] })).toBeNull()
    expect(retireExisting(draft, existing, back.id, 'replaced by two more specific nodes')).toBeNull()

    const result = await commit.commitDraft(draft, { rootDirectory: app, existing })
    expect(result).toMatchObject({ created: 0, updated: 1, retired: 1 })

    const after = await projectMembers()
    expect(after.find((m) => m.id === root.id)?.text).toContain('revisado')
    expect(after.find((m) => m.id === back.id)).toBeUndefined()
    // Without Backend, the working memory did not vanish from the tree: it went to the root.
    expect(after.find((m) => m.id === worker.id)?.relatedIds).toContain(root.id)
  })

  it('re-init over the old /init: a moved area node leaves the root, loses the area label and inherits the folder', async () => {
    const before = await projectMembers()
    const root = byTitle(before, 'App')
    const front = byTitle(before, 'Frontend')
    // Area node of the old pipeline, hanging straight from the root.
    const legacy = await memory.save({
      kind: 'project',
      directory: app,
      category: 'structure',
      area: 'architecture',
      text: 'Arquitetura: camadas e IPC.',
      relatedIds: [root.id],
      relatedTypes: { [root.id]: 'parent' },
      dedup: false,
    })

    const existing = { ids: new Set([...before.map((m) => m.id), legacy.id]), rootId: root.id }
    const { createDraft, upsertNode } = draftLib
    const draft = createDraft()
    expect(
      upsertNode(draft, existing, {
        key: 'front-arch',
        title: 'Front state',
        summary: summary('the front state'),
        category: 'structure',
        parent: front.id,
        related: [],
        tags: [],
        updates: legacy.id,
      }),
    ).toBeNull()
    await commit.commitDraft(draft, { rootDirectory: app, existing })

    const moved = (await projectMembers()).find((m) => m.id === legacy.id)!
    expect(moved.relatedIds).toContain(front.id)
    expect(moved.relatedIds).not.toContain(root.id)
    expect(moved.area).toBeUndefined()
    expect(moved.subproject).toBe('front')
    expect(moved.text.startsWith('Front state:')).toBe(true)
  })
})

describe('search fields of the draft', () => {
  it('reach the memory: title, summary, keywords, concepts and entities', async () => {
    const { createDraft, upsertNode } = draftLib
    const none = { ids: new Set<string>() }
    const draft = createDraft()
    const dir = path.join(userData, 'workspace', 'enriched')
    await fsp.mkdir(dir, { recursive: true })
    upsertNode(draft, none, {
      key: 'root', title: 'Enriquecido', summary: summary('o projeto'), category: 'structure', parent: null, related: [], tags: ['x'],
      keywords: [' login ', 'login', ''], concepts: ['como o usuário entra'], entities: ['Stripe'],
    })
    draft.learnings.push({ text: 'Vite: variáveis sem prefixo VITE_ não chegam ao cliente.', tags: ['vite'], title: 'Prefixo VITE_', keywords: ['env'] })
    await commit.commitDraft(draft, { rootDirectory: dir, existing: none })

    const all = await memory.list()
    const root = all.find((m) => m.text.startsWith('Enriquecido:'))!
    const full = (await memory.getFull(root.id))!.memory
    expect(full).toMatchObject({ title: 'Enriquecido', keywords: ['login'], concepts: ['como o usuário entra'], entities: ['Stripe'] })
    expect(full.summary).toBe(summary('o projeto'))
    const learning = (await memory.list()).find((m) => m.text.startsWith('Vite:'))!
    expect((await memory.getFull(learning.id))!.memory).toMatchObject({ title: 'Prefixo VITE_', keywords: ['env'] })
  })
})

describe('memory usage', () => {
  it('the search counts usage only on what matched, not on the neighbors brought by context', async () => {
    const scope = await memory.resolveProjectScope(app)
    const before = new Map((await projectMembers()).map((m) => [m.id, m.hits]))
    const results = await memory.search({ query: 'billing', kinds: ['project'], projectId: scope.projectId })
    const billing = results.find((m) => m.text.startsWith('Billing:'))!
    expect(billing.hits).toBe(before.get(billing.id)! + 1)
    const neighbors = results.filter((m) => m.id !== billing.id)
    expect(neighbors.length).toBeGreaterThan(0)
    const after = new Map((await projectMembers()).map((m) => [m.id, m.hits]))
    for (const n of neighbors) expect(after.get(n.id)).toBe(before.get(n.id))
  })

  it('opening a memory by id counts as usage', async () => {
    const front = byTitle(await projectMembers(), 'Frontend')
    const opened = await memory.open(front.id)
    expect(opened?.memory.hits).toBe(front.hits + 1)
    expect(opened?.document).toContain('# Front')
  })
})
