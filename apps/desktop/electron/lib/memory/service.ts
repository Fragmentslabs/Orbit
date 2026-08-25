import { EventEmitter } from 'node:events'
import path from 'node:path'
import type { Memory, MemoryEvent, MemoryKind, ProjectArea, ProjectCategory, RelationType } from '@shared/memory'
import { isCodeContext, jaccard, searchMemories } from '@shared/memory'
import {
  defaultWeight,
  extendedExpiry,
  hashText,
  isExpired,
  projectIdOf,
  shouldPromote,
  ttlFor,
} from './domain'
import * as repo from './repository'

/**
 * Casos de uso da memória Brain. Ferramentas do agente, IPC da UI e a injeção
 * de prompt falam só com este módulo. Toda mutação emite MemoryEvent no
 * emitter — o main.ts retransmite ao renderer via canal "memory:event".
 */

export const memoryEvents = new EventEmitter()

function emit(action: MemoryEvent['action'], memory: Memory) {
  memoryEvents.emit('event', { action, memory } satisfies MemoryEvent)
}

function newId() {
  return `mem_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
}

function clampWeight(weight: number): number {
  return Math.min(1, Math.max(0, weight))
}

function normalizeTags(tags: string[] | undefined): string[] {
  const seen = new Set<string>()
  for (const tag of tags ?? []) {
    const t = tag.trim().toLowerCase()
    if (t) seen.add(t)
  }
  return [...seen].slice(0, 8)
}

async function alive(): Promise<Memory[]> {
  const now = Date.now()
  return (await repo.getIndex()).filter((m) => !isExpired(m, now))
}

export interface SaveMemoryInput {
  text: string
  kind: MemoryKind
  weight?: number
  tags?: string[]
  /** Markdown anexado (memory/docs/<id>.md) — para contexto extenso */
  document?: string
  /** Obrigatória quando kind === "project". Kind "general" só aceita "learning". */
  category?: ProjectCategory
  /** Área de conhecimento (memórias geradas pelo /init) */
  area?: ProjectArea
  /**
   * Pasta da sessão. Obrigatória quando kind === "project" (o projectId deriva
   * daqui) e usada nos demais kinds para registrar o projeto de ORIGEM — o que
   * ancora a memória perto da árvore certa no canvas.
   */
  directory?: string
  /** Subprojeto dentro do projeto (ex.: "front", "back") — só quando kind === "project" */
  subproject?: string
  sessionId?: string
  /** Ids de memórias relacionadas (cria links) */
  relatedIds?: string[]
  /** Tipo da relação por id de destino. "parent" = hierarquia, "related" = conexão livre */
  relatedTypes?: Record<string, RelationType>
}

export interface SaveMemoryResult {
  id: string
  merged: boolean
  /** Texto da memória resultante (a existente, quando fundida) */
  text: string
}

const JACCARD_THRESHOLD = 0.85

export async function save(input: SaveMemoryInput): Promise<SaveMemoryResult> {
  const now = Date.now()
  const tags = normalizeTags(input.tags)
  const weight = clampWeight(input.weight ?? defaultWeight(input.kind, input.category))

  let projectId: string | undefined
  let projectName: string | undefined
  let originProjectId: string | undefined
  let originProjectName: string | undefined
  if (input.kind === 'project') {
    if (!input.directory) throw new Error('Memória de projeto exige a pasta de trabalho da sessão')
    projectId = projectIdOf(input.directory)
    projectName = path.basename(input.directory)
  } else if (input.directory) {
    // Memória global nascida dentro de um projeto: continua valendo em todos,
    // mas guarda a origem para o canvas ancorá-la na árvore certa.
    originProjectId = projectIdOf(input.directory)
    originProjectName = path.basename(input.directory)
  }

  // Dedup (escudo secundário ao prompt): hash exato ou tags quase idênticas
  // dentro do mesmo kind/projeto fundem com a memória existente.
  const pool = (await alive()).filter(
    (m) => m.kind === input.kind && (input.kind !== 'project' || m.projectId === projectId),
  )
  const hash = hashText(input.text)
  const existing =
    pool.find((m) => hashText(m.text) === hash) ??
    (tags.length > 0
      ? pool.find((m) => m.tags.length > 0 && jaccard(m.tags, tags) >= JACCARD_THRESHOLD)
      : undefined)

  if (existing) {
    const merged: Memory = {
      ...existing,
      tags: normalizeTags([...existing.tags, ...tags]),
      weight: Math.max(existing.weight, weight),
      lastHitAt: now,
      expiresAt: extendedExpiry(existing),
      originProjectId: existing.originProjectId ?? originProjectId,
      originProjectName: existing.originProjectName ?? originProjectName,
    }
    if (input.document) {
      await repo.writeDoc(merged.id, input.document)
      merged.hasDoc = true
    }
    await repo.put(merged)
    emit('updated', merged)
    if (input.relatedIds) {
      for (const relId of input.relatedIds) {
        await link(merged.id, relId, input.relatedTypes?.[relId])
      }
    }
    return { id: merged.id, merged: true, text: merged.text }
  }

  const memory: Memory = {
    id: newId(),
    kind: input.kind,
    text: input.text.trim(),
    tags,
    weight,
    hits: 0,
    relatedIds: [],
    sessionId: input.sessionId,
    createdAt: now,
    expiresAt: ttlFor(input.kind, weight, input.category) != null
      ? now + ttlFor(input.kind, weight, input.category)!
      : null,
    projectId,
    projectName,
    directory: input.kind === 'project' ? input.directory : undefined,
    subproject: input.kind === 'project' ? input.subproject : undefined,
    originProjectId,
    originProjectName,
    // "project" sempre carrega category; "general" só quando for um aprendizado
    // reutilizável entre projetos (category === "learning").
    category:
      input.kind === 'project' ? input.category
      : input.kind === 'general' && input.category === 'learning' ? 'learning'
      : undefined,
    area: input.kind === 'project' ? input.area : undefined,
  }
  if (input.document) {
    await repo.writeDoc(memory.id, input.document)
    memory.hasDoc = true
  }
  await repo.put(memory)
  emit('created', memory)
  if (input.relatedIds) {
    for (const relId of input.relatedIds) {
      await link(memory.id, relId, input.relatedTypes?.[relId])
    }
  }
  return { id: memory.id, merged: false, text: memory.text }
}

export interface SearchMemoryInput {
  query: string
  kinds: MemoryKind[]
  /** Filtra memórias project por projeto */
  projectId?: string
  category?: ProjectCategory
  /**
   * Descarta conhecimento de código (kind project e category learning). O modo
   * chat passa true: "general" abrange tanto preferências de trabalho quanto
   * aprendizados técnicos, e só as primeiras valem numa conversa.
   */
  excludeCodeContext?: boolean
  limit?: number
}

/** Quantos vizinhos de grafo entram por cima do resultado léxico */
const GRAPH_EXPANSION_LIMIT = 4

export async function search(input: SearchMemoryInput): Promise<Memory[]> {
  const now = Date.now()
  const pool = (await alive()).filter((m) => {
    if (!input.kinds.includes(m.kind)) return false
    if (m.kind === 'project' && m.projectId !== input.projectId) return false
    if (input.category && m.category !== input.category) return false
    if (input.excludeCodeContext && isCodeContext(m)) return false
    return true
  })
  const results = searchMemories(pool, input.query, input.limit ?? 8)

  // Navegação do grafo: memórias ligadas (relatedIds) aos melhores resultados
  // entram no retorno — ex: a busca acha o node "Design System" e traz junto
  // as memórias de botões/tokens ligadas a ele, sem depender de tokens léxicos.
  const poolById = new Map(pool.map((m) => [m.id, m]))
  const included = new Set(results.map((m) => m.id))
  const expanded: Memory[] = []
  for (const memory of results) {
    if (expanded.length >= GRAPH_EXPANSION_LIMIT) break
    for (const relatedId of memory.relatedIds) {
      if (included.has(relatedId)) continue
      const neighbor = poolById.get(relatedId)
      if (!neighbor) continue
      included.add(relatedId)
      expanded.push(neighbor)
      if (expanded.length >= GRAPH_EXPANSION_LIMIT) break
    }
  }

  // Cada retorno conta como uso: incrementa hits e estende a expiração
  const updated: Memory[] = []
  for (const memory of [...results, ...expanded]) {
    const next: Memory = {
      ...memory,
      hits: memory.hits + 1,
      lastHitAt: now,
      expiresAt: extendedExpiry(memory),
    }
    await repo.put(next)
    emit('updated', next)
    updated.push(next)
  }
  return updated
}

export async function getFull(id: string): Promise<{ memory: Memory; document: string | null } | null> {
  const memory = await repo.get(id)
  if (!memory) return null
  const document = memory.hasDoc ? await repo.readDoc(id) : null
  return { memory, document }
}

/** Substitui o documento markdown anexado (usado pelo re-init com merge). */
export async function setDocument(id: string, document: string): Promise<Memory | null> {
  const memory = await repo.get(id)
  if (!memory) return null
  await repo.writeDoc(id, document)
  const next: Memory = { ...memory, hasDoc: true }
  await repo.put(next)
  emit('updated', next)
  return next
}

export async function link(sourceId: string, targetId: string, type?: RelationType): Promise<boolean> {
  if (sourceId === targetId) return false
  const [source, target] = await Promise.all([repo.get(sourceId), repo.get(targetId)])
  if (!source || !target) return false
  const sourceRelationTypes = { ...(source.relationTypes ?? {}) }
  const targetRelationTypes = { ...(target.relationTypes ?? {}) }
  if (type === "parent") {
    // source (filho) marca target como seu pai
    sourceRelationTypes[targetId] = "parent"
    // target (pai) marca source como seu filho — necessário para colapso de árvore
    targetRelationTypes[sourceId] = "parent"
  }
  const nextSource = { ...source, relatedIds: [...new Set([...source.relatedIds, targetId])], relationTypes: sourceRelationTypes }
  const nextTarget = { ...target, relatedIds: [...new Set([...target.relatedIds, sourceId])], relationTypes: targetRelationTypes }
  await repo.put(nextSource)
  await repo.put(nextTarget)
  emit('updated', nextSource)
  emit('updated', nextTarget)
  return true
}

export async function linkAsParent(parentId: string, childId: string): Promise<boolean> {
  return link(parentId, childId, "parent")
}

/** Edição vinda da UI (texto, tags, weight). */
export async function update(
  id: string,
  patch: Partial<Pick<Memory, 'text' | 'tags' | 'weight'>>,
): Promise<Memory | null> {
  const memory = await repo.get(id)
  if (!memory) return null
  const next: Memory = {
    ...memory,
    ...(patch.text != null ? { text: patch.text.trim() } : undefined),
    ...(patch.tags != null ? { tags: normalizeTags(patch.tags) } : undefined),
    ...(patch.weight != null ? { weight: clampWeight(patch.weight) } : undefined),
  }
  await repo.put(next)
  emit('updated', next)
  return next
}

export interface ReviseMemoryInput {
  /** Substitui o texto por inteiro (o agente reescreve incorporando o novo fato). */
  text?: string
  /** Substitui as tags. Para acrescentar, use `addTags`. */
  tags?: string[]
  /** Acrescenta tags preservando as existentes. */
  addTags?: string[]
  weight?: number
  /** Reclassificação — é como um general/learning mal classificado vira project. */
  kind?: MemoryKind
  category?: ProjectCategory
  area?: ProjectArea
  /** Substitui o markdown anexado. */
  document?: string
  /** Pasta da sessão — necessária ao promover uma memória para kind="project". */
  directory?: string
}

/**
 * Revisão de uma memória existente pelo agente. É a alternativa a criar uma
 * duplicata: quando um fato novo apenas refina algo já salvo, reescreve-se o
 * texto no lugar. Também é o caminho para corrigir classificação — promover um
 * "general" que na verdade era fato do projeto.
 */
export async function revise(id: string, input: ReviseMemoryInput): Promise<Memory | null> {
  const memory = await repo.get(id)
  if (!memory) return null

  const kind = input.kind ?? memory.kind
  let category = input.category ?? memory.category
  const weight = input.weight != null ? clampWeight(input.weight) : memory.weight

  // "learning" é exclusiva de kind="general". Ao promover um aprendizado mal
  // classificado para memória de projeto, a categoria tem que vir junto — senão
  // o nó ficaria com uma categoria que a UI e o prompt não sabem posicionar.
  if (kind === 'project' && category === 'learning') {
    if (!input.category || input.category === 'learning') {
      throw new Error('Promover para kind="project" exige uma category de projeto (learning é exclusiva de general)')
    }
    category = input.category
  }
  if (kind === 'general' && category && category !== 'learning') category = undefined

  const next: Memory = {
    ...memory,
    kind,
    weight,
    ...(input.text != null ? { text: input.text.trim() } : undefined),
    ...(input.area != null ? { area: input.area } : undefined),
    category,
  }

  if (input.tags != null) next.tags = normalizeTags(input.tags)
  else if (input.addTags != null) next.tags = normalizeTags([...memory.tags, ...input.addTags])

  // Virou memória de projeto: precisa de identidade de projeto para não sumir
  // do filtro do canvas. A pasta da sessão manda; a origem serve de reserva.
  if (kind === 'project' && !next.projectId) {
    const directory = input.directory ?? memory.directory
    if (!directory) {
      throw new Error('Promover para kind="project" exige a pasta de trabalho da sessão')
    }
    next.projectId = projectIdOf(directory)
    next.projectName = path.basename(directory)
    next.directory = directory
  }
  if (kind !== 'project') {
    // Deixou de ser memória de projeto, mas continua tendo nascido em um: a
    // origem preserva a âncora no canvas em vez de jogá-la no grupo global.
    next.originProjectId = memory.originProjectId ?? memory.projectId
    next.originProjectName = memory.originProjectName ?? memory.projectName
    next.projectId = undefined
    next.projectName = undefined
    next.directory = undefined
    next.subproject = undefined
    next.area = undefined
  }

  // A expiração é recalculada porque kind/category/weight podem ter mudado —
  // um context promovido a decision deixa de expirar, e o caminho inverso
  // precisa ganhar um prazo novo em vez de nascer vencido.
  const ttl = ttlFor(kind, weight, category)
  next.expiresAt = ttl == null ? null : (memory.expiresAt ?? Date.now() + ttl)

  if (input.document != null) {
    await repo.writeDoc(id, input.document)
    next.hasDoc = true
  }

  await repo.put(next)
  emit('updated', next)
  return next
}

export interface TreeNodeSummary {
  id: string
  text: string
  area?: ProjectArea
  category?: ProjectCategory
  subproject?: string
  depth: number
  childIds: string[]
}

/**
 * Esqueleto da árvore de um projeto: cada nó com id, rótulo e filhos. É o que o
 * agente lê antes de salvar para escolher a QUEM se conectar — sem isto ele não
 * tem como saber que existe um node "Design System" e acaba criando um nó solto.
 */
export async function tree(projectId: string): Promise<TreeNodeSummary[]> {
  const members = (await alive()).filter((m) => m.kind === 'project' && m.projectId === projectId)
  if (members.length === 0) return []
  const byId = new Map(members.map((m) => [m.id, m]))

  const root =
    members.find((m) => m.area === 'overview' && !m.subproject) ??
    [...members].sort((a, b) => b.weight - a.weight)[0]

  const depth = new Map<string, number>([[root.id, 0]])
  const childrenOf = new Map<string, string[]>()
  const queue = [root.id]
  while (queue.length) {
    const id = queue.shift()!
    for (const rel of byId.get(id)?.relatedIds ?? []) {
      if (!byId.has(rel) || depth.has(rel)) continue
      depth.set(rel, depth.get(id)! + 1)
      childrenOf.set(id, [...(childrenOf.get(id) ?? []), rel])
      queue.push(rel)
    }
  }

  return members
    .map((m) => ({
      id: m.id,
      text: m.text,
      area: m.area,
      category: m.category,
      subproject: m.subproject,
      depth: depth.get(m.id) ?? 99,
      childIds: childrenOf.get(m.id) ?? [],
    }))
    .sort((a, b) => a.depth - b.depth || (a.area ?? '').localeCompare(b.area ?? ''))
}

/**
 * Promove in-place: seasonal → core; project/context → decision.
 * `promotedFrom` registra a origem (kind/category anterior) para a UI.
 */
export async function promote(id: string): Promise<Memory | null> {
  const memory = await repo.get(id)
  if (!memory) return null
  let next: Memory | null = null
  if (memory.kind === 'seasonal') {
    next = { ...memory, kind: 'core', expiresAt: null, promotedFrom: 'seasonal' }
  } else if (memory.kind === 'project' && memory.category === 'context') {
    next = { ...memory, category: 'decision', expiresAt: null, promotedFrom: 'project/context' }
  }
  if (!next) return null
  await repo.put(next)
  emit('promoted', next)
  return next
}

export async function remove(id: string): Promise<void> {
  const memory = await repo.get(id)
  if (!memory) return
  const touched = await repo.remove(id)
  emit('removed', memory)
  for (const m of touched) emit('updated', m)
}

export async function list(): Promise<Memory[]> {
  return repo.getIndex()
}

export interface PromptContext {
  core: Memory[]
  seasonal: Memory[]
  general: Memory[]
  /** kind="general" + category="learning" — lições reutilizáveis entre projetos */
  learning: Memory[]
  project: Memory[]
  projectName?: string
}

const CATEGORY_PRIORITY: Record<ProjectCategory, number> = {
  decision: 0,
  convention: 1,
  preference: 2,
  standard: 2,
  database: 3,
  structure: 3,
  context: 4,
  learning: 4,
}

/** Memórias injetadas silenciosamente no system prompt (~600 tokens no pior caso). */
export async function loadPromptContext(
  mode: 'chat' | 'code',
  directory?: string,
): Promise<PromptContext> {
  const pool = await alive()
  const byWeight = (a: Memory, b: Memory) => b.weight - a.weight
  const generalAll = pool.filter((m) => m.kind === 'general')
  const learningPool = generalAll.filter((m) => m.category === 'learning')
  const general = generalAll.filter((m) => m.category !== 'learning').sort(byWeight)

  if (mode === 'chat') {
    return {
      core: pool.filter((m) => m.kind === 'core').sort(byWeight).slice(0, 15),
      seasonal: pool
        .filter((m) => m.kind === 'seasonal')
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 8),
      general: general.slice(0, 10),
      // Aprendizados são contexto de código ("Prisma no Alpine exige openssl")
      // e não ajudam em nada numa conversa — injetá-los aqui só gastava tokens
      // e misturava os dois contextos.
      learning: [],
      project: [],
    }
  }

  const projectId = directory ? projectIdOf(directory) : undefined
  // O node central do grafo (área overview) entra sempre primeiro — é o mapa
  // que orienta o agente a buscar as áreas satélite conforme a tarefa
  const areaRank = (m: Memory) => (m.area === 'overview' ? -1 : 0)
  const project = projectId
    ? pool
        .filter((m) => m.kind === 'project' && m.projectId === projectId)
        .sort(
          (a, b) =>
            areaRank(a) - areaRank(b) ||
            CATEGORY_PRIORITY[a.category ?? 'context'] - CATEGORY_PRIORITY[b.category ?? 'context'] ||
            b.weight - a.weight,
        )
        .slice(0, 15)
    : []

  // Aprendizados de OUTROS projetos com stack/tema em comum (tags cruzadas com
  // as tags já coletadas neste projeto) sobem primeiro; os demais completam
  // por peso — assim um "gotcha" de Expo aprendido num projeto A já entra no
  // contexto ao abrir um projeto B que também usa Expo.
  const projectTags = new Set(project.flatMap((m) => m.tags))
  const learning = learningPool
    .map((m) => ({ m, overlap: m.tags.some((t) => projectTags.has(t)) ? 1 : 0 }))
    .sort((a, b) => b.overlap - a.overlap || b.m.weight - a.m.weight)
    .slice(0, 5)
    .map(({ m }) => m)

  return { core: [], seasonal: [], general: general.slice(0, 8), learning, project, projectName: project[0]?.projectName }
}

/** Executado pelo scheduler: expira (com cascata do doc) e promove automaticamente. */
export async function cleanup(): Promise<void> {
  const now = Date.now()
  const index = await repo.getIndex()
  for (const memory of index) {
    if (isExpired(memory, now)) {
      await remove(memory.id)
      continue
    }
    const promotion = shouldPromote(memory, now)
    if (promotion) {
      const next: Memory = {
        ...memory,
        kind: promotion.kind,
        category: promotion.category ?? memory.category,
        expiresAt: null,
        promotedFrom: memory.kind === 'seasonal' ? 'seasonal' : 'project/context',
      }
      await repo.put(next)
      emit('promoted', next)
    }
  }
}
