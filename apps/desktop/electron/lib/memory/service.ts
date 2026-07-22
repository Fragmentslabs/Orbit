import { EventEmitter } from 'node:events'
import path from 'node:path'
import type { Memory, MemoryEvent, MemoryKind, ProjectArea, ProjectCategory, RelationType } from '@shared/memory'
import { jaccard, searchMemories } from '@shared/memory'
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
  category?: ProjectCategory
  /** Área de conhecimento (memórias geradas pelo /init) */
  area?: ProjectArea
  /** Obrigatório quando kind === "project" — o projectId deriva daqui */
  directory?: string
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
  if (input.kind === 'project') {
    if (!input.directory) throw new Error('Memória de projeto exige a pasta de trabalho da sessão')
    projectId = projectIdOf(input.directory)
    projectName = path.basename(input.directory)
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
    category: input.kind === 'project' ? input.category : undefined,
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
  project: Memory[]
  projectName?: string
}

const CATEGORY_PRIORITY: Record<ProjectCategory, number> = {
  decision: 0,
  convention: 1,
  preference: 2,
  structure: 3,
  context: 4,
}

/** Memórias injetadas silenciosamente no system prompt (~600 tokens no pior caso). */
export async function loadPromptContext(
  mode: 'chat' | 'code',
  directory?: string,
): Promise<PromptContext> {
  const pool = await alive()
  const byWeight = (a: Memory, b: Memory) => b.weight - a.weight
  const general = pool.filter((m) => m.kind === 'general').sort(byWeight).slice(0, 10)

  if (mode === 'chat') {
    return {
      core: pool.filter((m) => m.kind === 'core').sort(byWeight).slice(0, 15),
      seasonal: pool
        .filter((m) => m.kind === 'seasonal')
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 8),
      general,
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
  return { core: [], seasonal: [], general, project, projectName: project[0]?.projectName }
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
