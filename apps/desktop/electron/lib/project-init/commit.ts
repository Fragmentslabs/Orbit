import { projectIdOf } from '../memory/domain'
import * as memoryService from '../memory/service'
import { commitOrder, memoryText, subprojectOf, type Draft, type ExistingTree } from './draft'

export interface CommitContext {
  /** Pasta raiz do projeto — define o projectId de tudo que é gravado. */
  rootDirectory: string
  existing: ExistingTree
}

export interface CommitResult {
  /** Algo foi gravado. */
  saved: boolean
  created: number
  updated: number
  retired: number
  learnings: number
  /** Títulos dos nós gravados, na ordem da árvore. */
  titles: string[]
}

/**
 * Grava o rascunho do /init: nós de cima para baixo (cada filho já encontra o
 * id do pai), depois as ligações transversais, os aprendizados e as
 * aposentadorias.
 */
export async function commitDraft(draft: Draft, ctx: CommitContext): Promise<CommitResult> {
  const ids = new Map<string, string>()
  const resolve = (ref: string) => (draft.nodes.has(ref) ? ids.get(ref) : ref)
  const titles: string[] = []
  let created = 0
  let updated = 0

  // Profundidade de cada nó existente ANTES de gravar: é o que diz, entre os
  // vizinhos de um nó, qual era o pai (as ligações são bidirecionais e as
  // duas pontas marcam "parent", então o tipo sozinho não dá a direção).
  const depthBefore = new Map(
    (await memoryService.tree(projectIdOf(ctx.rootDirectory))).map((n) => [n.id, n.depth]),
  )

  for (const node of commitOrder(draft)) {
    const isRoot = node.parent === null
    const parentId = node.parent ? resolve(node.parent) : undefined
    // Pendurado num nó que já existia (re-init): herda a pasta dele, que o
    // rascunho não conhece.
    const inheritedSubproject =
      node.parent && !draft.nodes.has(node.parent)
        ? (await memoryService.getFull(node.parent))?.memory.subproject
        : undefined
    const subproject = isRoot ? undefined : (subprojectOf(draft, node.key) ?? inheritedSubproject)
    const weight = node.weight ?? (isRoot ? 0.9 : node.scope ? 0.85 : 0.7)
    const tags = [...new Set([...node.tags, ...(node.scope ? [node.scope.toLowerCase()] : [])])]
    let id: string | undefined

    if (node.updates && ctx.existing.ids.has(node.updates)) {
      const revised = await memoryService.revise(node.updates, {
        text: memoryText(node),
        tags,
        weight,
        category: node.category,
        // Nó de área do /init antigo ("Arquitetura") reaproveitado com outro
        // título: sem limpar a área, o grafo continuaria rotulando pela área.
        area: isRoot ? 'overview' : null,
        subproject,
        document: node.document,
      })
      if (revised) {
        id = revised.id
        updated++
        // Mudou de pai: a ligação com o pai antigo sai. Sem isto, um nó movido
        // de debaixo da raiz para debaixo do "Frontend" continuaria ligado à
        // raiz e apareceria no primeiro nível do mapa, como antes.
        const depth = depthBefore.get(revised.id)
        if (parentId && depth != null) {
          for (const neighbor of revised.relatedIds) {
            const neighborDepth = depthBefore.get(neighbor)
            if (
              neighbor !== parentId &&
              neighborDepth != null &&
              neighborDepth < depth &&
              revised.relationTypes?.[neighbor] === 'parent'
            ) {
              await memoryService.unlink(revised.id, neighbor)
            }
          }
        }
      }
    }
    if (!id) {
      const saved = await memoryService.save({
        kind: 'project',
        directory: ctx.rootDirectory,
        subproject,
        text: memoryText(node),
        tags,
        weight,
        category: node.category,
        area: isRoot ? 'overview' : undefined,
        document: node.document,
        dedup: false,
      })
      id = saved.id
      created++
    }
    if (parentId && parentId !== id) await memoryService.link(id, parentId, 'parent')
    ids.set(node.key, id)
    titles.push(node.title)
  }

  for (const node of draft.nodes.values()) {
    const source = ids.get(node.key)
    for (const ref of node.related) {
      const target = resolve(ref)
      if (source && target) await memoryService.link(source, target, 'related')
    }
  }

  for (const learning of draft.learnings) {
    await memoryService.save({
      kind: 'general',
      category: 'learning',
      text: learning.text,
      tags: learning.tags,
      weight: 0.55,
      // Vale em qualquer projeto, mas registrar onde nasceu ancora o nó perto
      // da árvore de origem no canvas.
      directory: ctx.rootDirectory,
    })
  }

  // Aposentar um nó pode deixar vizinhos sem nenhuma ligação com a árvore:
  // eles são reatados à raiz em vez de virarem órfãos invisíveis.
  const draftRoot = [...draft.nodes.values()].find((n) => n.parent === null)
  const rootId = draftRoot ? ids.get(draftRoot.key) : ctx.existing.rootId
  const neighbors = new Set<string>()
  let retired = 0
  for (const id of draft.retired.keys()) {
    const full = await memoryService.getFull(id)
    if (!full) continue
    full.memory.relatedIds.forEach((r) => neighbors.add(r))
    await memoryService.remove(id)
    retired++
  }
  if (rootId) {
    for (const id of neighbors) {
      if (draft.retired.has(id) || id === rootId) continue
      const full = await memoryService.getFull(id)
      if (full && full.memory.kind === 'project' && full.memory.relatedIds.length === 0) {
        await memoryService.link(id, rootId, 'parent')
      }
    }
  }

  return {
    saved: created + updated + retired + draft.learnings.length > 0,
    created,
    updated,
    retired,
    learnings: draft.learnings.length,
    titles,
  }
}
