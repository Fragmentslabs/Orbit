import type { MediaEntry } from "@shared/media"

/**
 * Agrupamento da galeria: uma foto e suas versões são UM item.
 *
 * O agrupamento é pela RAIZ da descendência, não pela ponta da cadeia. A
 * diferença aparece quando duas imagens saem da mesma base e nenhuma sucede a
 * outra — o agente entregando duas opções para escolher, ou um turno que
 * voltou ao original em vez de editar o último resultado. Pela ponta, isso
 * vira dois itens de uma edição só; pela raiz, continua sendo a mesma foto,
 * com uma versão a mais.
 *
 * Rascunho não chega aqui: o que serviu só de tentativa é descartado no fim da
 * resposta (ver electron/lib/image-drafts.ts). O que sobra são versões.
 */

export interface MediaGrouping {
  /** Uma entrada por grupo — a mais recente dele —, na ordem de `visible`. */
  covers: MediaEntry[]
  /** id da capa → versões do grupo, da mais antiga para a atual. Só grupos
   *  com mais de uma imagem aparecem aqui. */
  versions: Map<string, MediaEntry[]>
}

/** Sobe até a origem. `all` (e não só o que está visível) porque um elo
 *  escondido por um filtro não pode partir o grupo em dois. */
export function rootIdOf(entry: MediaEntry, byId: Map<string, MediaEntry>): string {
  const seen = new Set<string>()
  let current = entry
  while (current.parentId && !seen.has(current.id)) {
    seen.add(current.id)
    const parent = byId.get(current.parentId)
    if (!parent) break
    current = parent
  }
  return current.id
}

export function groupMediaByRoot(all: MediaEntry[], visible: MediaEntry[]): MediaGrouping {
  const byId = new Map(all.map((e) => [e.id, e]))
  const groups = new Map<string, MediaEntry[]>()
  for (const entry of visible) {
    const root = rootIdOf(entry, byId)
    const members = groups.get(root) ?? []
    members.push(entry)
    groups.set(root, members)
  }

  const coverByRoot = new Map<string, string>()
  const versions = new Map<string, MediaEntry[]>()
  for (const [root, members] of groups) {
    const ordered = [...members].sort((a, b) => a.createdAt - b.createdAt)
    const cover = ordered[ordered.length - 1]
    coverByRoot.set(root, cover.id)
    if (ordered.length > 1) versions.set(cover.id, ordered)
  }

  // Mantém a ordem de `visible` (a galeria entrega mais recente primeiro).
  const covers = visible.filter((entry) => coverByRoot.get(rootIdOf(entry, byId)) === entry.id)
  return { covers, versions }
}

/**
 * Ids a apagar quando se apaga um ITEM da grade: o grupo inteiro, porque o
 * item É o grupo — deixar as versões para trás encheria o disco de imagens que
 * não aparecem em lugar nenhum. A foto que o usuário anexou fica: ela é a
 * origem, não uma versão produzida aqui.
 */
export function expandToGroups(ids: string[], all: MediaEntry[]): string[] {
  const byId = new Map(all.map((e) => [e.id, e]))
  const roots = new Set<string>()
  for (const id of ids) {
    const entry = byId.get(id)
    if (entry) roots.add(rootIdOf(entry, byId))
  }
  const target = new Set(ids)
  for (const entry of all) {
    if (!roots.has(rootIdOf(entry, byId))) continue
    if (entry.source === "user") continue
    target.add(entry.id)
  }
  return [...target]
}
