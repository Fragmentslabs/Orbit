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

describe('projeto que cobre uma pasta', () => {
  it('a própria raiz não tem subprojeto', () => {
    expect(pickProjectRoot(roots, app)).toEqual({ root: roots[0] })
  })

  it('um chat aberto em "front" enxerga a árvore da pasta mãe', () => {
    const picked = pickProjectRoot(roots, path.join(app, 'front', 'src'))
    expect(picked?.root).toBe(roots[0])
    expect(picked?.subproject).toBe('front/src')
  })

  it('vence o projeto mais próximo quando há um dentro do outro', () => {
    const picked = pickProjectRoot(roots, path.join(app, 'apps', 'mobile', 'src'))
    expect(picked?.root).toBe(roots[1])
    expect(picked?.subproject).toBe('src')
  })

  it('pasta com prefixo parecido não conta como dentro ("app-old" não está em "app")', () => {
    expect(pickProjectRoot(roots, path.resolve('/work/app-old'))).toBeNull()
  })

  it('subpasta só casa por segmento inteiro', () => {
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

/** Liga os dois lados, como o service.link faz. */
function link(members: Memory[], a: string, b: string) {
  members.find((m) => m.id === a)!.relatedIds.push(b)
  members.find((m) => m.id === b)!.relatedIds.push(a)
}

describe('mapa da árvore para o prompt', () => {
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
    // Regra de negócio ligada também às duas partes: não pode virar filha delas.
    link(members, 'rules', 'front')
    link(members, 'rules', 'back')
    return members
  }

  it('na raiz: a raiz e o primeiro nível, com quantos filhos cada um tem', () => {
    const map = buildProjectMap(tree())!
    expect(map.root.id).toBe('root')
    expect(map.children.map((n) => n.id).sort()).toEqual(['back', 'front', 'rules'])
    expect(map.children.find((n) => n.id === 'front')?.children).toBe(2)
    expect(map.branch).toBeUndefined()
    expect(map.omitted).toBe(3)
  })

  it('numa subpasta: também o ramo dela', () => {
    const map = buildProjectMap(tree(), 'front/src/pages')!
    expect(map.branch?.node.id).toBe('front')
    expect(map.branch?.children.map((n) => n.id).sort()).toEqual(['front-auth', 'front-ui'])
    expect(map.omitted).toBe(1)
  })

  it('o ramo é o nó da parte, mesmo que um filho dela (mesma pasta) tenha sido criado antes', () => {
    const members = tree()
    // Memória de sessão do front, criada antes do /init: vem primeiro na lista.
    const early = members.find((m) => m.id === 'front-auth')!
    const reordered = [early, ...members.filter((m) => m !== early)]
    expect(buildProjectMap(reordered, 'front')!.branch?.node.id).toBe('front')
  })

  it('subpasta sem nó próprio fica só com o mapa geral', () => {
    expect(buildProjectMap(tree(), 'docs')!.branch).toBeUndefined()
  })

  it('projeto sem memórias não tem mapa', () => {
    expect(buildProjectMap([])).toBeNull()
  })
})
