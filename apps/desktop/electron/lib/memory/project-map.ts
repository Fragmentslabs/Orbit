import type { Memory } from '@shared/memory'
import { isWithinSubproject } from './domain'

/**
 * Mapa da árvore de memórias de um projeto — o recorte que entra no system
 * prompt de todo chat novo de código.
 *
 * Antes entrava só o nó raiz, e o agente precisava adivinhar o que buscar; ou
 * então (no modelo anterior a este) as 15 memórias de maior peso, soltas e sem
 * a forma da árvore. O mapa é o meio-termo barato: a raiz, os nós de primeiro
 * nível com uma linha cada e, quando o chat está numa subpasta, o ramo dela.
 * O resto o agente abre sob demanda (memory_open / memory_graph), sabendo
 * pelo mapa que existe e onde está.
 */

export interface MapNode {
  id: string
  text: string
  hasDoc: boolean
  /** Quantos filhos o nó tem na árvore — diz ao agente que vale abrir. */
  children: number
}

export interface ProjectMap {
  root: MapNode
  /** Filhos diretos da raiz, do mais importante para o menos. */
  children: MapNode[]
  /** Ramo da subpasta em que o chat está, quando um nó de escopo a cobre. */
  branch?: { subproject: string; node: MapNode; children: MapNode[] }
  /** Nós do projeto fora do recorte — existem e podem ser buscados. */
  omitted: number
}

/** Raiz da árvore: o overview do escopo raiz; sem ele, a memória de maior peso. */
export function rootOf(members: Memory[]): Memory | undefined {
  return (
    members.find((m) => m.area === 'overview' && !m.subproject) ??
    [...members].sort((a, b) => b.weight - a.weight)[0]
  )
}

/**
 * Filhos de cada nó numa busca em largura a partir da raiz. As ligações são
 * bidirecionais (relatedIds dos dois lados), então a direção pai → filho vem
 * da ordem da busca, como no memory_tree.
 */
export function childrenByBfs(
  members: Memory[],
  rootId: string,
): { children: Map<string, string[]>; depth: Map<string, number> } {
  const byId = new Map(members.map((m) => [m.id, m]))
  const depth = new Map([[rootId, 0]])
  const children = new Map<string, string[]>()
  const queue = [rootId]
  while (queue.length) {
    const id = queue.shift()!
    for (const rel of byId.get(id)?.relatedIds ?? []) {
      if (!byId.has(rel) || depth.has(rel)) continue
      depth.set(rel, depth.get(id)! + 1)
      children.set(id, [...(children.get(id) ?? []), rel])
      queue.push(rel)
    }
  }
  return { children, depth }
}

export function buildProjectMap(members: Memory[], subproject?: string, limit = 12): ProjectMap | null {
  const root = rootOf(members)
  if (!root) return null
  const byId = new Map(members.map((m) => [m.id, m]))
  const { children, depth } = childrenByBfs(members, root.id)

  const node = (m: Memory): MapNode => ({
    id: m.id,
    text: m.text,
    hasDoc: !!m.hasDoc,
    children: children.get(m.id)?.length ?? 0,
  })
  const childrenOf = (id: string) =>
    (children.get(id) ?? [])
      .map((childId) => byId.get(childId)!)
      .sort((a, b) => b.weight - a.weight)
      .slice(0, limit)
      .map(node)

  const shown = new Set<string>([root.id])
  const firstLevel = childrenOf(root.id)
  firstLevel.forEach((n) => shown.add(n.id))

  let branch: ProjectMap['branch']
  if (subproject) {
    // O nó de escopo mais específico que contém a pasta do chat: em
    // "front/src", vence o nó "front" (e um "front/src" se existisse). Os
    // filhos do nó "front" herdam a mesma pasta, então no empate vence o mais
    // raso na árvore — senão um filho criado antes viraria o "ramo".
    const level = (m: Memory) => depth.get(m.id) ?? Number.MAX_SAFE_INTEGER
    const scope = members
      .filter((m) => m.subproject && m.id !== root.id && isWithinSubproject(subproject, m.subproject))
      .sort((a, b) => b.subproject!.length - a.subproject!.length || level(a) - level(b))[0]
    if (scope) {
      const branchChildren = childrenOf(scope.id)
      shown.add(scope.id)
      branchChildren.forEach((n) => shown.add(n.id))
      branch = { subproject: scope.subproject!, node: node(scope), children: branchChildren }
    }
  }

  return { root: node(root), children: firstLevel, branch, omitted: members.length - shown.size }
}
