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
    summary: `Resumo específico do nó ${partial.key}, com conteúdo suficiente.`,
    category: 'structure',
    parent: 'root',
    related: [],
    tags: [],
    ...partial,
  }
}

/** Pasta mãe com front e backend, e uma regra de negócio que atravessa os dois. */
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

describe('rascunho da árvore do /init', () => {
  it('monta front, back e regra transversal sem problemas', () => {
    const draft = frontBack()
    expect(validateDraft(draft, none)).toEqual([])
    expect(draft.nodes.get('front')?.scope).toBe('front')
  })

  it('não há mínimo de nós: um projeto pode ter só a raiz', () => {
    const draft = createDraft()
    upsertNode(draft, none, node({ key: 'root', parent: null }))
    expect(validateDraft(draft, none)).toEqual([])
  })

  it('pai precisa existir antes do filho', () => {
    const draft = createDraft()
    upsertNode(draft, none, node({ key: 'root', parent: null }))
    expect(upsertNode(draft, none, node({ key: 'x', parent: 'nao-existe' }))).toMatch(/não existe/)
  })

  it('só uma raiz', () => {
    const draft = frontBack()
    expect(upsertNode(draft, none, node({ key: 'outra', parent: null }))).toMatch(/já existe a raiz/)
  })

  it('barra ciclos ao mover um nó para baixo de um descendente', () => {
    const draft = frontBack()
    expect(upsertNode(draft, none, node({ key: 'front', parent: 'front-auth' }))).toMatch(/ciclo/)
  })

  it('resumo longo é recusado: o detalhe vai para o documento', () => {
    const draft = createDraft()
    const error = upsertNode(draft, none, node({ key: 'root', parent: null, summary: 'x'.repeat(400) }))
    expect(error).toMatch(/document/)
  })

  it('não remove nó com filhos', () => {
    const draft = frontBack()
    expect(removeNode(draft, 'front')).toMatch(/tem filhos/)
    expect(removeNode(draft, 'front-auth')).toBeNull()
    expect(removeNode(draft, 'front')).toBeNull()
    // A ligação transversal para o nó removido some junto.
    expect(draft.nodes.get('billing')?.related).toEqual(['back'])
  })

  it('pais são gravados antes dos filhos', () => {
    const order = commitOrder(frontBack()).map((n) => n.key)
    expect(order.indexOf('root')).toBeLessThan(order.indexOf('front'))
    expect(order.indexOf('front')).toBeLessThan(order.indexOf('front-auth'))
  })

  it('o subprojeto vem do nó de pasta mais próximo acima', () => {
    const draft = frontBack()
    expect(subprojectOf(draft, 'front-auth')).toBe('front')
    expect(subprojectOf(draft, 'billing')).toBeUndefined()
  })

  it('duas partes não podem representar a mesma pasta', () => {
    const draft = frontBack()
    upsertNode(draft, none, node({ key: 'front2', scope: 'Front' }))
    expect(validateDraft(draft, none).join()).toMatch(/mesma pasta/)
  })

  it('o texto gravado abre com o título (é o rótulo no grafo)', () => {
    expect(memoryText(node({ key: 'k', title: 'Frontend', summary: 'App React.' }))).toBe('Frontend: App React.')
  })
})

describe('rascunho sobre uma árvore que já existe (re-init)', () => {
  const existing: ExistingTree = { ids: new Set(['mem_root', 'mem_front', 'mem_old']), rootId: 'mem_root' }

  it('a raiz do rascunho reescreve a raiz existente em vez de criar outra', () => {
    const draft = createDraft()
    expect(upsertNode(draft, existing, node({ key: 'root', parent: null }))).toBeNull()
    expect(draft.nodes.get('root')?.updates).toBe('mem_root')
  })

  it('nó novo pode pendurar num nó existente, sem raiz no rascunho', () => {
    const draft = createDraft()
    expect(upsertNode(draft, existing, node({ key: 'front-state', parent: 'mem_front' }))).toBeNull()
    expect(validateDraft(draft, existing)).toEqual([])
  })

  it('uma memória existente só é reescrita por um nó', () => {
    const draft = createDraft()
    upsertNode(draft, existing, node({ key: 'a', parent: 'mem_root', updates: 'mem_front' }))
    expect(upsertNode(draft, existing, node({ key: 'b', parent: 'mem_root', updates: 'mem_front' }))).toMatch(/já é atualizada/)
  })

  it('aposentar: nunca a raiz, nem o que está sendo atualizado ou tem filhos no rascunho', () => {
    const draft = createDraft()
    upsertNode(draft, existing, node({ key: 'a', parent: 'mem_front' }))
    expect(retireExisting(draft, existing, 'mem_root', 'obsoleta, refeita')).toMatch(/raiz/)
    expect(retireExisting(draft, existing, 'mem_front', 'obsoleta, refeita')).toMatch(/pendurado/)
    expect(retireExisting(draft, existing, 'mem_old', 'genérica demais')).toBeNull()
    expect(upsertNode(draft, existing, node({ key: 'b', parent: 'mem_root', updates: 'mem_old' }))).toMatch(/aposentada/)
  })
})
