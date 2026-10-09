import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Memory } from '@shared/memory'

/**
 * A gravação do rascunho do /init contra o serviço de memória de verdade.
 *
 * O que estes testes prendem é o que faz o /init valer alguma coisa depois:
 * a árvore sai com a forma que o coordenador desenhou (sem a fusão automática
 * engolir nós irmãos de tags parecidas), e um chat aberto numa subpasta acha
 * essa árvore e recebe o ramo dela no mapa.
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

const summary = (what: string) => `Resumo de ${what}, específico o bastante para se sustentar.`

async function projectMembers(): Promise<Memory[]> {
  const scope = await memory.resolveProjectScope(app)
  return (await memory.list()).filter((m) => m.kind === 'project' && m.projectId === scope.projectId)
}

const byTitle = (members: Memory[], title: string) => members.find((m) => m.text.startsWith(`${title}:`))!

describe('gravar a árvore de uma pasta mãe com front e backend', () => {
  it('grava a forma desenhada, sem fundir nós de tags parecidas', async () => {
    const { createDraft, upsertNode } = draftLib
    const none = { ids: new Set<string>() }
    const draft = createDraft()
    const tags = ['typescript', 'app', 'web']
    upsertNode(draft, none, { key: 'root', title: 'App', summary: summary('o projeto'), category: 'structure', parent: null, related: [], tags })
    upsertNode(draft, none, { key: 'front', title: 'Frontend', summary: summary('o front'), category: 'structure', parent: 'root', related: [], tags, scope: 'front', document: '# Front\n\nDetalhes.' })
    upsertNode(draft, none, { key: 'back', title: 'Backend', summary: summary('o back'), category: 'structure', parent: 'root', related: [], tags, scope: 'backend' })
    upsertNode(draft, none, { key: 'auth', title: 'Login', summary: summary('o login'), category: 'decision', parent: 'front', related: [], tags })
    upsertNode(draft, none, { key: 'billing', title: 'Cobrança', summary: summary('a cobrança'), category: 'decision', parent: 'root', related: ['front', 'back'], tags })
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
    // O filho herda a pasta do nó de parte acima dele.
    expect(byTitle(members, 'Login').subproject).toBe('front')
    // A regra transversal fica na raiz e ligada às duas partes.
    const billing = byTitle(members, 'Cobrança')
    expect(billing.subproject).toBeUndefined()
    expect(billing.relatedIds).toEqual(expect.arrayContaining([root.id, front.id, back.id]))
    expect(front.hasDoc).toBe(true)
  })

  it('um chat numa subpasta acha a árvore da mãe e recebe o ramo dela no mapa', async () => {
    const inside = path.join(app, 'front', 'src')
    const scope = await memory.resolveProjectScope(inside)
    expect(scope).toMatchObject({ covered: true, subproject: 'front/src' })
    expect(path.resolve(scope.directory)).toBe(path.resolve(app))

    const ctx = await memory.loadPromptContext('code', inside)
    expect(ctx.map?.root.text.startsWith('App:')).toBe(true)
    expect(ctx.map?.children.map((n) => n.text.split(':')[0]).sort()).toEqual(['Backend', 'Cobrança', 'Frontend'])
    expect(ctx.map?.branch?.node.text.startsWith('Frontend:')).toBe(true)
    expect(ctx.map?.branch?.children.map((n) => n.text.split(':')[0])).toEqual(['Login'])
  })

  it('pasta fora de qualquer árvore continua sendo o próprio projeto', async () => {
    const elsewhere = path.join(userData, 'workspace', 'outro')
    const scope = await memory.resolveProjectScope(elsewhere)
    expect(scope.covered).toBe(false)
    expect((await memory.loadPromptContext('code', elsewhere)).map).toBeUndefined()
  })

  it('re-init: atualiza no lugar, aposenta o obsoleto e reata o vizinho que ficaria órfão', async () => {
    const before = await projectMembers()
    const root = byTitle(before, 'App')
    const back = byTitle(before, 'Backend')
    // Memória de sessão de trabalho pendurada só no Backend.
    const worker = await memory.save({
      kind: 'project',
      directory: app,
      category: 'convention',
      text: 'Fila: jobs idempotentes por chave de pedido.',
      relatedIds: [back.id],
      relatedTypes: { [back.id]: 'parent' },
    })

    const existing = { ids: new Set([...before.map((m) => m.id), worker.id]), rootId: root.id }
    const { createDraft, upsertNode, retireExisting } = draftLib
    const draft = createDraft()
    expect(upsertNode(draft, existing, { key: 'root', title: 'App', summary: summary('o projeto, revisado'), category: 'structure', parent: null, related: [], tags: [] })).toBeNull()
    expect(retireExisting(draft, existing, back.id, 'substituído por dois nós mais específicos')).toBeNull()

    const result = await commit.commitDraft(draft, { rootDirectory: app, existing })
    expect(result).toMatchObject({ created: 0, updated: 1, retired: 1 })

    const after = await projectMembers()
    expect(after.find((m) => m.id === root.id)?.text).toContain('revisado')
    expect(after.find((m) => m.id === back.id)).toBeUndefined()
    // Sem o Backend, a memória de trabalho não sumiu da árvore: foi para a raiz.
    expect(after.find((m) => m.id === worker.id)?.relatedIds).toContain(root.id)
  })

  it('re-init sobre o /init antigo: nó de área movido sai da raiz, perde o rótulo de área e herda a pasta', async () => {
    const before = await projectMembers()
    const root = byTitle(before, 'App')
    const front = byTitle(before, 'Frontend')
    // Nó de área do pipeline antigo, pendurado direto na raiz.
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
        title: 'Estado do front',
        summary: summary('o estado do front'),
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
    expect(moved.text.startsWith('Estado do front:')).toBe(true)
  })
})

describe('uso das memórias', () => {
  it('a busca conta uso só no que casou, não nos vizinhos trazidos de contexto', async () => {
    const scope = await memory.resolveProjectScope(app)
    const before = new Map((await projectMembers()).map((m) => [m.id, m.hits]))
    const results = await memory.search({ query: 'cobrança', kinds: ['project'], projectId: scope.projectId })
    const billing = results.find((m) => m.text.startsWith('Cobrança:'))!
    expect(billing.hits).toBe(before.get(billing.id)! + 1)
    const neighbors = results.filter((m) => m.id !== billing.id)
    expect(neighbors.length).toBeGreaterThan(0)
    const after = new Map((await projectMembers()).map((m) => [m.id, m.hits]))
    for (const n of neighbors) expect(after.get(n.id)).toBe(before.get(n.id))
  })

  it('abrir uma memória pelo id conta como uso', async () => {
    const front = byTitle(await projectMembers(), 'Frontend')
    const opened = await memory.open(front.id)
    expect(opened?.memory.hits).toBe(front.hits + 1)
    expect(opened?.document).toContain('# Front')
  })
})
