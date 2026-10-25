import { EventEmitter } from 'node:events'
import path from 'node:path'
import type { Memory, MemoryEvent, MemoryKind, ProjectArea, ProjectCategory, RelationType } from '@shared/memory'
import { isCodeContext, jaccard } from '@shared/memory'
import { PRODUCTION_RETRIEVAL, retrieveCandidates } from '@shared/memory-select'
import { Bm25Index, lexicalDocOf } from '@shared/memory-retrieval'
import {
  defaultWeight,
  extendedExpiry,
  hashText,
  isExpired,
  pickProjectRoot,
  projectIdOf,
  shouldPromote,
  ttlFor,
  type ProjectRoot,
} from './domain'
import { buildProjectMap, rootOf, type ProjectMap } from './project-map'
import * as repo from './repository'
import { embedTexts, modelInstalled, syncIndex, vectorsById } from './embedding'
import { suggestMemories, type MemorySuggestion } from './retrieval'
import { pastaNoRepositorioPrincipal } from '../worktrees/principal'

/**
 * Casos de uso da memória Brain. Ferramentas do agente, IPC da UI e a injeção
 * de prompt falam só com este módulo. Toda mutação emite MemoryEvent no
 * emitter — o main.ts retransmite ao renderer via canal "memory:event".
 */

export const memoryEvents = new EventEmitter()

function emit(action: MemoryEvent['action'], memory: Memory) {
  memoryEvents.emit('event', { action, memory } satisfies MemoryEvent)
  // Qualquer mutação pode invalidar o vetor daquela memória: o índice de
  // embeddings é sincronizado em segundo plano, com debounce, e nunca no
  // caminho da resposta.
  scheduleIndexSync()
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
  /**
   * Enriquecimento para a busca (opcional, preenchido por quem grava).
   * `text` continua sendo a fonte da verdade: estes campos só ajudam a
   * recuperação e nunca podem conter fato que o texto não tenha.
   */
  title?: string
  summary?: string
  entities?: string[]
  keywords?: string[]
  concepts?: string[]
  /** Ids de memórias relacionadas (cria links) */
  relatedIds?: string[]
  /** Tipo da relação por id de destino. "parent" = hierarquia, "related" = conexão livre */
  relatedTypes?: Record<string, RelationType>
  /**
   * Default true: texto idêntico ou tags quase iguais fundem com a memória
   * existente. O /init desliga: ele já decidiu, nó a nó, o que atualiza e o
   * que cria — e dois nós irmãos com tags parecidas ("frontend", "react")
   * seriam fundidos num só, sumindo com um ramo inteiro da árvore.
   */
  dedup?: boolean
}

export interface SaveMemoryResult {
  id: string
  merged: boolean
  /** Texto da memória resultante (a existente, quando fundida) */
  text: string
}

const JACCARD_THRESHOLD = 0.85

type EnrichmentInput = Pick<SaveMemoryInput, "title" | "summary" | "entities" | "keywords" | "concepts">

/**
 * Campos derivados que acompanham a memória. Campo não enviado continua como
 * está: na fusão — e no revise — o enriquecimento antigo não é apagado.
 */
function enrichmentOf(input: EnrichmentInput): Partial<Memory> {
  const list = (items?: string[]) => {
    const clean = (items ?? []).map((s) => s.trim()).filter(Boolean).slice(0, 12)
    return clean.length ? clean : undefined
  }
  // As chaves ausentes ficam AUSENTES, não `undefined`: espalhar `undefined`
  // sobre uma memória existente apagaria o enriquecimento que já estava lá.
  const out: Partial<Memory> = {}
  const title = input.title?.trim()
  if (title) out.title = title
  const summary = input.summary?.trim()
  if (summary) out.summary = summary
  const entities = list(input.entities)
  if (entities) out.entities = entities
  const keywords = list(input.keywords)
  if (keywords) out.keywords = keywords
  const concepts = list(input.concepts)
  if (concepts) out.concepts = concepts
  return out
}

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
    input.dedup === false
      ? undefined
      : (pool.find((m) => hashText(m.text) === hash) ??
        (tags.length > 0
          ? pool.find((m) => m.tags.length > 0 && jaccard(m.tags, tags) >= JACCARD_THRESHOLD)
          : undefined))

  if (existing) {
    const merged: Memory = {
      ...existing,
      tags: normalizeTags([...existing.tags, ...tags]),
      weight: Math.max(existing.weight, weight),
      lastHitAt: now,
      expiresAt: extendedExpiry(existing),
      originProjectId: existing.originProjectId ?? originProjectId,
      originProjectName: existing.originProjectName ?? originProjectName,
      ...enrichmentOf(input),
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
    ...enrichmentOf(input),
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

/**
 * Documentos anexados das memórias do conjunto: o que está dentro do `.md`
 * também precisa ser encontrável, não só o texto da memória. Lê apenas quem
 * declara `hasDoc` e nunca derruba a busca por causa de um documento ilegível.
 */
async function docsFor(pool: Memory[]): Promise<Map<string, string>> {
  const withDoc = pool.filter((m) => m.hasDoc)
  if (withDoc.length === 0) return new Map()
  const out = new Map<string, string>()
  await Promise.all(
    withDoc.map(async (memory) => {
      try {
        const doc = await repo.readDoc(memory.id)
        if (doc?.trim()) out.set(memory.id, doc)
      } catch {
        /* documento ilegível não invalida a memória */
      }
    }),
  )
  return out
}

/**
 * Vetores do índice semântico, ou vazio quando o modelo não está instalado.
 * Buscar nunca dispara download: quem procura não pode esperar 130 MB.
 */
async function indexVectors(): Promise<Map<string, Float32Array>> {
  if (!modelInstalled()) return new Map()
  try {
    return await vectorsById()
  } catch {
    return new Map()
  }
}

/** Embedding da consulta — undefined quando o modelo falta, e a busca segue lexical. */
async function queryVector(query: string): Promise<Float32Array | undefined> {
  try {
    const [vec] = await embedTexts([query])
    return vec
  } catch {
    return undefined
  }
}

export async function search(input: SearchMemoryInput): Promise<Memory[]> {
  const now = Date.now()
  const pool = (await alive()).filter((m) => {
    if (!input.kinds.includes(m.kind)) return false
    if (m.kind === 'project' && m.projectId !== input.projectId) return false
    if (input.category && m.category !== input.category) return false
    if (input.excludeCodeContext && isCodeContext(m)) return false
    return true
  })
  // Uma só lista lexical — BM25 sobre o texto indexável, com o `.md` anexado —
  // fundida com o vetor da consulta, na calibração do bench. Sem modelo, o
  // lexical fica sozinho e a busca continua funcionando.
  const docs = await docsFor(pool)
  const lexical = new Bm25Index(pool.map((memory) => lexicalDocOf(memory, docs.get(memory.id))))
  const vectors = await indexVectors()
  const queryVec = vectors.size > 0 ? await queryVector(input.query) : undefined
  const candidates = retrieveCandidates(
    { queryVec, lexicalQuery: input.query, vectors, lexical },
    PRODUCTION_RETRIEVAL,
  )

  const poolById = new Map(pool.map((m) => [m.id, m]))
  const limit = input.limit ?? 8
  const results: Memory[] = []
  for (const candidate of candidates) {
    const memory = poolById.get(candidate.id)
    if (!memory) continue
    results.push(memory)
    if (results.length >= limit) break
  }

  // Navegação do grafo: memórias ligadas (relatedIds) aos melhores resultados
  // entram no retorno — ex: a busca acha o node "Design System" e traz junto
  // as memórias de botões/tokens ligadas a ele, sem depender de tokens léxicos.
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

  // Só o que casou com a busca conta como uso. Os vizinhos de grafo vêm de
  // carona, como contexto: contá-los inflava hits de memórias que ninguém
  // procurou — e hits decidem promoção (context → decision) e qual memória
  // sobrevive quando a consolidação funde duplicatas.
  const touched = results.map((memory) => hit(memory, now))
  await repo.putMany(touched)
  for (const next of touched) emit('updated', next)
  return [...touched, ...expanded]
}

function hit(memory: Memory, now: number): Memory {
  return { ...memory, hits: memory.hits + 1, lastHitAt: now, expiresAt: extendedExpiry(memory) }
}

/**
 * Leitura de uma memória pelo agente (memory_open) — conta como uso. Com o mapa
 * do projeto no prompt, abrir o nó pelo id virou o jeito normal de consultar a
 * memória; sem contar, os nós mais lidos pareceriam "nunca usados".
 */
export async function open(id: string): Promise<{ memory: Memory; document: string | null } | null> {
  const memory = await repo.get(id)
  if (!memory) return null
  const next = hit(memory, Date.now())
  await repo.put(next)
  emit('updated', next)
  const document = next.hasDoc ? await repo.readDoc(id) : null
  return { memory: next, document }
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

/** Desfaz a ligação entre duas memórias, dos dois lados. */
export async function unlink(aId: string, bId: string): Promise<boolean> {
  const [a, b] = await Promise.all([repo.get(aId), repo.get(bId)])
  if (!a || !b) return false
  const drop = (m: Memory, other: string): Memory => {
    const relationTypes = { ...(m.relationTypes ?? {}) }
    delete relationTypes[other]
    return { ...m, relatedIds: m.relatedIds.filter((r) => r !== other), relationTypes }
  }
  const nextA = drop(a, bId)
  const nextB = drop(b, aId)
  await repo.put(nextA)
  await repo.put(nextB)
  emit('updated', nextA)
  emit('updated', nextB)
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
  /** null remove a área (o nó deixa de ser rotulado por ela no grafo). */
  area?: ProjectArea | null
  /** Substitui o markdown anexado. */
  document?: string
  /** Pasta da sessão — necessária ao promover uma memória para kind="project". */
  directory?: string
  /** Subpasta do projeto que a memória descreve (só kind="project"). */
  subproject?: string
  /**
   * Enriquecimento para a busca. Reescrever o texto de uma memória antiga é a
   * chance de preencher isto — sem esses campos ela continua sendo indexada
   * só pelo que der para derivar do texto.
   */
  title?: string
  summary?: string
  entities?: string[]
  keywords?: string[]
  concepts?: string[]
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
    ...(input.subproject != null && kind === 'project' ? { subproject: input.subproject } : undefined),
    category,
    ...enrichmentOf(input),
  }
  if (input.area === null) delete next.area

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

  const root = rootOf(members)!

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
 * Promove in-place: seasonal → general; project/context → decision.
 * `promotedFrom` registra a origem (kind/category anterior) para a UI.
 *
 * `general` e não `core`: core só é injetado no prompt do chat (ver
 * loadPromptContext), e o padrão que se repete vale sobretudo no código —
 * promovê-lo para core o faria desaparecer justamente ali.
 */
export async function promote(id: string): Promise<Memory | null> {
  const memory = await repo.get(id)
  if (!memory) return null
  let next: Memory | null = null
  if (memory.kind === 'seasonal') {
    next = { ...memory, kind: 'general', expiresAt: null, promotedFrom: 'seasonal' }
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

export interface ProjectScope {
  projectId: string
  /** Pasta raiz do projeto — onde as memórias dele são gravadas. */
  directory: string
  projectName: string
  /** Caminho relativo da pasta pedida dentro da raiz ("front", "front/src"). */
  subproject?: string
  /** Já existe árvore de memórias cobrindo a pasta (nela ou numa pasta acima). */
  covered: boolean
}

/**
 * Projeto de memória de uma pasta de trabalho. Tudo que lê ou grava memória de
 * projeto passa por aqui, e não pelo projectIdOf direto: é o que faz um chat
 * aberto em "app/front" enxergar (e alimentar) a árvore que o /init criou em
 * "app/". Sem árvore acima, o projeto é a própria pasta, como sempre foi.
 */
export async function resolveProjectScope(pasta: string): Promise<ProjectScope> {
  // Worktree é o mesmo projeto em outro caminho: a memória é a do principal.
  const directory = await pastaNoRepositorioPrincipal(pasta)
  const roots = new Map<string, ProjectRoot>()
  for (const m of await alive()) {
    if (m.kind !== 'project' || m.area !== 'overview' || m.subproject || !m.directory || !m.projectId) continue
    if (!roots.has(m.projectId)) roots.set(m.projectId, { projectId: m.projectId, directory: m.directory })
  }
  const picked = pickProjectRoot([...roots.values()], directory)
  if (!picked) {
    return { projectId: projectIdOf(directory), directory, projectName: path.basename(directory), covered: false }
  }
  return {
    projectId: picked.root.projectId,
    directory: picked.root.directory,
    projectName: path.basename(picked.root.directory),
    subproject: picked.subproject,
    covered: true,
  }
}

export interface PromptContext {
  core: Memory[]
  seasonal: Memory[]
  /**
   * Sazonais que já se repetiram o bastante para virar padrão. O agente pergunta
   * na conversa antes de promover — é o "sim" do usuário que faz a regra.
   */
  promotable: Memory[]
  general: Memory[]
  /** kind="general" + category="learning" — lições reutilizáveis entre projetos */
  learning: Memory[]
  project: Memory[]
  projectName?: string
  /** Recorte da árvore do projeto para o prompt (modo código). */
  map?: ProjectMap
  /** Subpasta do projeto em que o chat está, quando não é a raiz. */
  subproject?: string
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

/**
 * Quantos usos fazem uma sazonal parecer padrão. Fica ABAIXO do limiar da
 * promoção automática (5 — ver shouldPromote): a ideia é o agente perguntar
 * ANTES de o sistema decidir sozinho, porque a regra só deve nascer com o aval
 * de quem vai conviver com ela. A promoção automática continua como rede de
 * segurança para quando ninguém perguntou (brain desligado, sessão fechada).
 */
const PROMOTION_ASK_HITS = 3

function repeatingSeasonals(pool: Memory[], now: number): Memory[] {
  return pool
    .filter((m) => m.kind === 'seasonal' && !isExpired(m, now) && m.hits >= PROMOTION_ASK_HITS)
    .sort((a, b) => b.hits - a.hits)
    .slice(0, 3)
}

/**
 * Orçamento do bloco do system prompt, em caracteres.
 *
 * O limite é de TAMANHO, não de quantidade de memórias: contar itens não
 * protege contra uma memória longa, e era assim que um texto de milhares de
 * caracteres entrava inteiro no prompt — em toda mensagem, para sempre.
 */
const CONTEXT_BUDGET_CHARS = 3600

/** Teto por linha: uma memória longa não pode engolir o bloco. */
const CONTEXT_LINE_MAX_CHARS = 220

/**
 * Corta o bloco para caber no orçamento, na ordem de prioridade do prompt:
 * o permanente primeiro, o ocasional depois. Quando o orçamento acaba, o que
 * vem depois fica de fora — e isso é o comportamento certo, não um empate.
 */
function trimContext(ctx: PromptContext): PromptContext {
  let used = 0
  const take = (list: Memory[]): Memory[] => {
    const out: Memory[] = []
    for (const memory of list) {
      const text =
        memory.text.length > CONTEXT_LINE_MAX_CHARS
          ? `${memory.text.slice(0, CONTEXT_LINE_MAX_CHARS - 1).trimEnd()}…`
          : memory.text
      const cost = text.length + 8 // marcador e separador da linha
      if (used + cost > CONTEXT_BUDGET_CHARS) break
      used += cost
      out.push(text === memory.text ? memory : { ...memory, text })
    }
    return out
  }
  return {
    ...ctx,
    core: take(ctx.core),
    project: take(ctx.project),
    general: take(ctx.general),
    learning: take(ctx.learning),
    seasonal: take(ctx.seasonal),
    promotable: take(ctx.promotable),
  }
}

/**
 * Memórias injetadas silenciosamente no system prompt, já cortadas para caber
 * no orçamento de `CONTEXT_BUDGET_CHARS` (ver trimContext).
 */
export async function loadPromptContext(
  mode: 'chat' | 'code',
  directory?: string,
): Promise<PromptContext> {
  const pool = await alive()
  const byWeight = (a: Memory, b: Memory) => b.weight - a.weight
  const generalAll = pool.filter((m) => m.kind === 'general')
  const learningPool = generalAll.filter((m) => m.category === 'learning')
  const general = generalAll.filter((m) => m.category !== 'learning').sort(byWeight)
  const promotable = repeatingSeasonals(pool, Date.now())
  // A candidata não se repete no bloco de contexto: a mesma linha duas vezes
  // (uma como "use como contexto", outra como "pergunte") só confunde.
  const promotableIds = new Set(promotable.map((m) => m.id))

  if (mode === 'chat') {
    return trimContext({
      core: pool.filter((m) => m.kind === 'core').sort(byWeight).slice(0, 15),
      seasonal: pool
        .filter((m) => m.kind === 'seasonal' && !promotableIds.has(m.id))
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 8),
      promotable,
      general: general.slice(0, 10),
      // Aprendizados são contexto de código ("Prisma no Alpine exige openssl")
      // e não ajudam em nada numa conversa — injetá-los aqui só gastava tokens
      // e misturava os dois contextos.
      learning: [],
      project: [],
    })
  }

  const scope = directory ? await resolveProjectScope(directory) : undefined
  const projectId = scope?.projectId
  const members = projectId ? pool.filter((m) => m.kind === 'project' && m.projectId === projectId) : []
  // O node central do grafo (área overview) entra sempre primeiro — é o mapa
  // que orienta o agente a buscar as áreas satélite conforme a tarefa
  const areaRank = (m: Memory) => (m.area === 'overview' ? -1 : 0)
  const project = projectId
    ? [...members]
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

  return trimContext({
    core: [],
    seasonal: [],
    promotable,
    general: general.slice(0, 8),
    learning,
    project,
    projectName: scope?.covered ? scope.projectName : project[0]?.projectName,
    map: buildProjectMap(members, scope?.subproject) ?? undefined,
    subproject: scope?.subproject,
  })
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

// ---------------------------------------------------------------------------
// Recuperação por contexto (embeddings + lexical)
// ---------------------------------------------------------------------------

let syncTimer: NodeJS.Timeout | null = null
let syncRunning: Promise<unknown> | null = null

/**
 * Reindexação em segundo plano. Debounce curto para uma sequência de saves do
 * /init não disparar uma passada por memória, e nunca em série com a resposta.
 */
export function scheduleIndexSync(delayMs = 2_000): void {
  if (syncTimer) clearTimeout(syncTimer)
  syncTimer = setTimeout(() => {
    syncTimer = null
    void syncMemoryIndex()
  }, delayMs)
  syncTimer.unref?.()
}

/** Sincroniza o índice de embeddings com o acervo (idempotente). */
export async function syncMemoryIndex(): Promise<{ indexed: number; pending: number; ok: boolean }> {
  if (syncRunning) {
    await syncRunning.catch(() => {})
  }
  const run = (async () => {
    const pool = await alive()
    const result = await syncIndex(pool)
    return { indexed: result.indexed, pending: 0, ok: !result.failed }
  })()
  syncRunning = run.catch(() => {})
  try {
    return await run
  } catch (err) {
    console.error('[memory] sincronização do índice falhou:', err)
    return { indexed: 0, pending: 0, ok: false }
  } finally {
    syncRunning = null
  }
}

/**
 * Acervo elegível para a recuperação por contexto, por modo.
 *
 * `core` fica FORA de propósito: memória permanente já entra no bloco fixo do
 * prompt, e recuperá-la de novo só gastaria token e duplicaria a mesma linha.
 */
export async function retrievalPool(mode: 'chat' | 'code', directory?: string): Promise<Memory[]> {
  const pool = await alive()
  if (mode === 'chat') {
    return pool.filter((m) => (m.kind === 'seasonal' || m.kind === 'general') && !isCodeContext(m))
  }
  const scope = directory ? await resolveProjectScope(directory) : undefined
  const projectId = scope?.projectId
  return pool.filter((m) => m.kind === 'general' || (m.kind === 'project' && m.projectId === projectId))
}

/**
 * Sugestões de memória no turno — ligadas por padrão, só id + metadados.
 *
 * A validação de 24/10 reprovou a injeção de TEXTO: precisão de 84% na fixture
 * de ajuste (meta: 98% com IC95 inferior >= 90%), 10/10 no conjunto bloqueado
 * com IC95 [72%; 100%], e o nível de ponteiro deu 0/8 úteis — a similaridade
 * não separa "vai ajudar" de "é sobre o mesmo assunto".
 *
 * A sugestão não repete esse erro porque não afirma nada: manda o id e o
 * enquadramento (`general/preferences`) e deixa o conteúdo a um memory_open de
 * distância. Um palpite errado custa uma linha ignorada, não uma resposta
 * contaminada. E o que já está no bloco fixo do prompt é excluído aqui — os
 * dois caminhos não contam a mesma história duas vezes.
 *
 * Desligável com ORBIT_MEMORY_SUGGEST=0.
 */
export const MEMORY_SUGGESTIONS_ENABLED = process.env.ORBIT_MEMORY_SUGGEST !== '0'

/** Sugestões do turno. Nunca lança (ver suggestMemories). */
export async function retrieveForTurn(input: {
  text: string
  mode: 'chat' | 'code'
  directory?: string
  recent?: Array<{ role: 'user' | 'assistant'; text: string }>
  /** Ids já presentes no bloco do system prompt desta sessão. */
  exclude?: readonly string[]
}): Promise<MemorySuggestion[]> {
  if (!MEMORY_SUGGESTIONS_ENABLED) return []
  try {
    const pool = await retrievalPool(input.mode, input.directory)
    return await suggestMemories({
      message: input.text,
      recent: input.recent,
      pool,
      docs: await docsFor(pool),
      exclude: input.exclude,
    })
  } catch (err) {
    console.error('[memory] sugestões do turno falharam:', err)
    return []
  }
}
