import type { ProjectCategory } from '@shared/memory'

/**
 * Rascunho da árvore de memórias que o coordenador do /init monta antes de
 * gravar qualquer coisa.
 *
 * Nada vai para a memória enquanto a análise roda. O coordenador cria, edita,
 * remove e reorganiza nós aqui, revisa o conjunto e só então o /init grava
 * tudo de uma vez. É o que impede o resultado de ser uma pilha de achados
 * soltos: cada nó passou pela revisão de quem viu o projeto inteiro, e um
 * cancelamento no meio não deixa meia árvore para trás.
 *
 * Módulo puro (sem I/O): as regras de forma da árvore são testáveis sozinhas.
 */

export type DraftCategory = Exclude<ProjectCategory, 'learning'>

export interface DraftNode {
  /** Identificador escolhido pelo coordenador, único no rascunho ("front", "regras-pagamento"). */
  key: string
  title: string
  /** 1–3 frases que se sustentam sozinhas — é o que entra no prompt dos chats futuros. */
  summary: string
  /** O detalhe (caminhos, comandos, regras, fluxos), aberto sob demanda com memory_open. */
  document?: string
  category: DraftCategory
  /** Key de outro nó do rascunho, id de memória existente, ou null na raiz. */
  parent: string | null
  /** Ligações transversais: keys do rascunho ou ids existentes. */
  related: string[]
  /** Pasta (relativa à raiz) que este nó representa — marca o nó de um subprojeto. */
  scope?: string
  tags: string[]
  weight?: number
  /** Id de memória existente que este nó reescreve, em vez de criar outra. */
  updates?: string
}

export interface DraftLearning {
  text: string
  tags: string[]
}

export interface Draft {
  nodes: Map<string, DraftNode>
  learnings: DraftLearning[]
  /** Memórias existentes que o coordenador decidiu aposentar, com o motivo. */
  retired: Map<string, string>
}

/** O que já existe na memória do projeto quando o /init roda de novo. */
export interface ExistingTree {
  ids: Set<string>
  rootId?: string
}

export const SUMMARY_MAX = 320
const SUMMARY_MIN = 20
const KEY_PATTERN = /^[a-z0-9][a-z0-9._/-]{0,59}$/i

export function createDraft(): Draft {
  return { nodes: new Map(), learnings: [], retired: new Map() }
}

function refExists(draft: Draft, existing: ExistingTree, ref: string): boolean {
  return draft.nodes.has(ref) || existing.ids.has(ref)
}

/** Ancestrais de um nó dentro do rascunho (para barrar ciclos). */
function ancestorsOf(draft: Draft, key: string): string[] {
  const chain: string[] = []
  let current = draft.nodes.get(key)?.parent ?? null
  while (current && draft.nodes.has(current) && !chain.includes(current)) {
    chain.push(current)
    current = draft.nodes.get(current)!.parent
  }
  return chain
}

/**
 * Cria ou substitui um nó. Devolve o erro como texto (vai de volta ao
 * coordenador, que corrige a chamada) ou null.
 *
 * Os pais vêm antes dos filhos: o pai precisa já existir no rascunho ou na
 * memória. É o que obriga a árvore a nascer de cima para baixo, com a raiz
 * pensada antes dos detalhes.
 */
export function upsertNode(draft: Draft, existing: ExistingTree, node: DraftNode): string | null {
  if (!KEY_PATTERN.test(node.key)) return `key inválida "${node.key}": use letras, números, "-", "_", "/" ou "." (até 60).`
  if (!node.title.trim()) return 'title vazio.'
  const summary = node.summary.trim()
  if (summary.length < SUMMARY_MIN) return `summary curto demais em "${node.key}": escreva algo que se sustente sozinho.`
  if (summary.length > SUMMARY_MAX) {
    return `summary de "${node.key}" tem ${summary.length} caracteres (máx. ${SUMMARY_MAX}). Deixe o resumo curto e mova o detalhe para document.`
  }

  if (node.parent === null) {
    const otherRoot = [...draft.nodes.values()].find((n) => n.parent === null && n.key !== node.key)
    if (otherRoot) return `já existe a raiz "${otherRoot.key}". Só há uma raiz: pendure este nó nela ou em outro nó.`
    if (existing.rootId && node.updates && node.updates !== existing.rootId) {
      return `a raiz do projeto já existe (#${existing.rootId}): a raiz do rascunho só pode atualizar ela.`
    }
    // Re-init: a raiz do rascunho É a raiz existente, reescrita. Criar outra
    // deixaria o projeto com duas raízes e o mapa apontando para a velha.
    if (existing.rootId) node = { ...node, updates: existing.rootId }
  } else {
    if (node.parent === node.key) return 'um nó não pode ser pai de si mesmo.'
    if (!refExists(draft, existing, node.parent)) {
      return `pai "${node.parent}" não existe. Crie o pai antes (de cima para baixo) ou use o id de uma memória existente.`
    }
    if (draft.nodes.has(node.parent) && ancestorsOf(draft, node.parent).includes(node.key)) {
      return `"${node.parent}" está abaixo de "${node.key}": isso criaria um ciclo.`
    }
  }

  const unknown = node.related.filter((r) => r !== node.key && !refExists(draft, existing, r))
  if (unknown.length) return `related desconhecido(s): ${unknown.join(', ')}.`

  if (node.updates) {
    if (!existing.ids.has(node.updates)) return `updates "${node.updates}" não é uma memória existente deste projeto.`
    const taken = [...draft.nodes.values()].find((n) => n.updates === node.updates && n.key !== node.key)
    if (taken) return `a memória #${node.updates} já é atualizada pelo nó "${taken.key}".`
    if (draft.retired.has(node.updates)) return `#${node.updates} foi aposentada neste rascunho; desfaça antes de atualizá-la.`
  }

  draft.nodes.set(node.key, {
    ...node,
    title: node.title.trim(),
    summary,
    scope: node.scope?.replace(/\\/g, '/').replace(/^\.\/|\/+$/g, '') || undefined,
    related: [...new Set(node.related.filter((r) => r !== node.key))],
    tags: [...new Set(node.tags.map((t) => t.trim().toLowerCase()).filter(Boolean))],
  })
  return null
}

/** Remove um nó. Recusa se ele tem filhos: o coordenador decide para onde eles vão. */
export function removeNode(draft: Draft, key: string): string | null {
  if (!draft.nodes.has(key)) return `"${key}" não está no rascunho.`
  const children = [...draft.nodes.values()].filter((n) => n.parent === key).map((n) => n.key)
  if (children.length) return `"${key}" tem filhos (${children.join(', ')}): mova-os ou remova-os antes.`
  draft.nodes.delete(key)
  for (const n of draft.nodes.values()) n.related = n.related.filter((r) => r !== key)
  return null
}

export function retireExisting(draft: Draft, existing: ExistingTree, id: string, reason: string): string | null {
  if (!existing.ids.has(id)) return `#${id} não é uma memória existente deste projeto.`
  if (id === existing.rootId) return 'a raiz do projeto não pode ser aposentada; atualize-a.'
  const updater = [...draft.nodes.values()].find((n) => n.updates === id)
  if (updater) return `#${id} é atualizada pelo nó "${updater.key}"; não dá para aposentá-la também.`
  const child = [...draft.nodes.values()].find((n) => n.parent === id)
  if (child) return `o nó "${child.key}" está pendurado em #${id}: mude o pai dele antes.`
  draft.retired.set(id, reason.trim())
  return null
}

/**
 * Problemas que impedem gravar. Vazio = o rascunho está pronto.
 * Sem árvore existente, a raiz é obrigatória; com árvore, o rascunho pode só
 * acrescentar ou atualizar nós debaixo dela.
 */
export function validateDraft(draft: Draft, existing: ExistingTree): string[] {
  const issues: string[] = []
  const nodes = [...draft.nodes.values()]
  const roots = nodes.filter((n) => n.parent === null)
  if (!existing.rootId && roots.length === 0 && nodes.length > 0) {
    issues.push('falta a raiz: um nó com parent null descrevendo o projeto.')
  }
  if (roots.length > 1) issues.push(`há ${roots.length} raízes; deve haver uma.`)
  for (const n of nodes) {
    if (n.parent !== null && !refExists(draft, existing, n.parent)) {
      issues.push(`"${n.key}" aponta para o pai "${n.parent}", que não existe.`)
    }
    if (n.parent !== null && n.parent === n.updates) issues.push(`"${n.key}" é pai de si mesmo via updates.`)
    for (const r of n.related) if (!refExists(draft, existing, r)) issues.push(`"${n.key}" liga a "${r}", que não existe.`)
  }
  const scopes = new Map<string, string>()
  for (const n of nodes) {
    if (!n.scope) continue
    const key = n.scope.toLowerCase()
    if (scopes.has(key)) issues.push(`"${n.key}" e "${scopes.get(key)}" representam a mesma pasta "${n.scope}".`)
    scopes.set(key, n.key)
  }
  return issues
}

/** Ordem de gravação: pais antes dos filhos, para cada filho já ter o id do pai. */
export function commitOrder(draft: Draft): DraftNode[] {
  const ordered: DraftNode[] = []
  const placed = new Set<string>()
  const pending = [...draft.nodes.values()]
  while (pending.length) {
    const before = pending.length
    for (let i = 0; i < pending.length; i++) {
      const n = pending[i]
      if (n.parent === null || !draft.nodes.has(n.parent) || placed.has(n.parent)) {
        ordered.push(n)
        placed.add(n.key)
        pending.splice(i--, 1)
      }
    }
    // Ciclo que escapou da validação: grava o resto como está em vez de travar.
    if (pending.length === before) {
      ordered.push(...pending)
      break
    }
  }
  return ordered
}

/** Pasta do subprojeto de um nó: o scope dele ou do ancestral mais próximo que tenha um. */
export function subprojectOf(draft: Draft, key: string): string | undefined {
  let current: DraftNode | undefined = draft.nodes.get(key)
  const seen = new Set<string>()
  while (current && !seen.has(current.key)) {
    if (current.scope) return current.scope
    seen.add(current.key)
    current = current.parent ? draft.nodes.get(current.parent) : undefined
  }
  return undefined
}

/** Texto curto gravado na memória: o título abre a linha, que é também o rótulo no grafo. */
export function memoryText(node: DraftNode): string {
  return `${node.title}: ${node.summary}`
}

/** O rascunho como o coordenador o vê: a árvore indentada, com o que cada nó carrega. */
export function renderDraft(draft: Draft, existing: ExistingTree): string {
  const nodes = [...draft.nodes.values()]
  if (nodes.length === 0 && draft.learnings.length === 0 && draft.retired.size === 0) return '(rascunho vazio)'
  const lines: string[] = []
  const visit = (parent: string | null, depth: number) => {
    for (const n of nodes.filter((x) => x.parent === parent)) {
      const marks = [
        n.category,
        n.scope ? `pasta ${n.scope}` : '',
        n.document ? `doc ${n.document.length} chars` : 'sem doc',
        n.updates ? `atualiza #${n.updates}` : '',
        n.related.length ? `liga ${n.related.join(', ')}` : '',
      ].filter(Boolean)
      lines.push(`${'  '.repeat(depth)}- [${n.key}] ${n.title} (${marks.join('; ')}): ${n.summary}`)
      visit(n.key, depth + 1)
    }
  }
  visit(null, 0)
  // Nós pendurados em memórias que já existiam (re-init): agrupados pelo pai.
  const underExisting = [...new Set(nodes.map((n) => n.parent).filter((p): p is string => !!p && existing.ids.has(p) && !draft.nodes.has(p)))]
  for (const id of underExisting) {
    lines.push(`- (existente #${id})`)
    visit(id, 1)
  }
  if (draft.learnings.length) {
    lines.push('Aprendizados (fora da árvore, valem para outros projetos):')
    for (const l of draft.learnings) lines.push(`  - ${l.text}`)
  }
  if (draft.retired.size) {
    lines.push('Memórias existentes a aposentar:')
    for (const [id, reason] of draft.retired) lines.push(`  - #${id}: ${reason}`)
  }
  return lines.join('\n')
}
