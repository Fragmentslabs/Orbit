/**
 * Tipos e funções puras do sistema de memória "Brain", compartilhados entre
 * main e renderer. A busca é léxica (sem embeddings) — as mesmas funções de
 * tokenização/score rodam no service (main) e na busca local da MemoriesView.
 */

export type MemoryKind = "core" | "seasonal" | "project" | "general"

export type MemoryScope = "chat" | "code" | "any"

export type ProjectCategory =
  | "preference"
  | "convention"
  | "structure"
  | "context"
  | "decision"
  | "database"
  | "learning"
  | "standard"

export const PROJECT_CATEGORY_LABEL: Record<ProjectCategory, string> = {
  preference: "preferência",
  convention: "convenção",
  structure: "estrutura",
  decision: "decisão",
  context: "contexto",
  database: "banco de dados",
  learning: "aprendizado",
  standard: "padronização",
}

/**
 * Áreas de conhecimento de um projeto (geradas pelo /init). "overview" é o
 * node central do grafo de memórias; as demais áreas são satélites ligadas a
 * ele via relatedIds. Memórias avulsas podem ou não ter área.
 */
export type ProjectArea =
  | "overview"
  | "business"
  | "design"
  | "architecture"
  | "preferences"
  | "infrastructure"
  | "security"
  | "development"
  | "database"
  | "testing"
  | "performance"
  | "dependencies"
  | "standards"

/** `label` is shown in the UI (Portuguese) — `description` is model-facing only
 * (used to build the /init planning prompt), never rendered, so it's in English. */
export const PROJECT_AREAS: Record<ProjectArea, { label: string; description: string }> = {
  overview: { label: "Contexto do Projeto", description: "Purpose, stack, general structure, useful links" },
  business: { label: "Regras de Negócio", description: "Core logic, flows, entities, critical rules" },
  design: { label: "Design System", description: "UI components, visual patterns, accessibility" },
  architecture: { label: "Arquitetura", description: "Modules, service communication, data" },
  preferences: { label: "Preferências", description: "Code style, naming conventions, branching" },
  infrastructure: { label: "Infraestrutura", description: "Deploy, environment variables, CI/CD, containers" },
  security: { label: "Segurança", description: "Authentication, authorization, sensitive data" },
  development: { label: "Desenvolvimento", description: "Scripts, commands, local setup" },
  database: { label: "Banco de Dados", description: "Schemas, models, migrations, ORM, relationships" },
  testing: { label: "Testes", description: "Test setup, mocks, fixtures, coverage strategy" },
  performance: { label: "Performance", description: "Optimizations, caching, known bottlenecks" },
  dependencies: { label: "Dependências", description: "Critical libs, versioning, reasons for choices" },
  standards: { label: "Padronização", description: "Explicit conventions: commits, branching, naming, lint" },
}

/**
 * O scope é derivado do kind — não é armazenado, para não existirem
 * combinações inválidas (ex.: core com scope code).
 */
export function scopeOf(kind: MemoryKind): MemoryScope {
  if (kind === "project") return "code"
  if (kind === "general") return "any"
  return "chat"
}

export type RelationType = "parent" | "related"

export interface Memory {
  id: string
  kind: MemoryKind
  /** Resumo curto — é o que entra no system prompt e na busca */
  text: string
  tags: string[]
  /** Importância 0..1 (o agente decide, nunca o usuário) */
  weight: number
  hits: number
  lastHitAt?: number
  /** Backlinks bidirecionais (estilo Obsidian) */
  relatedIds: string[]
  /**
   * Tipo da relação por id de destino. Quando ausente, assume "related".
   * "parent" = hierarquia explícita (nó filho deste nó).
   * Uma memória pode ser parent de vários filhos e related a vários outros nós.
   */
  relationTypes?: Record<string, RelationType>
  /** Existe um documento markdown anexado em memory/docs/<id>.md */
  hasDoc?: boolean
  sessionId?: string
  messageId?: string
  createdAt: number
  /** null/undefined = nunca expira */
  expiresAt?: number | null
  /** id da memória que originou esta via promoção */
  promotedFrom?: string
  // Somente quando kind === "project":
  projectId?: string
  projectName?: string
  directory?: string
  /** Subprojeto dentro do projeto (ex.: "front", "back") — undefined = escopo raiz */
  subproject?: string
  /**
   * Obrigatória quando kind === "project". Também aceita kind === "general"
   * com valor "learning" — lição reutilizável entre projetos (ex.: workaround
   * de framework), não presa a um projectId.
   */
  category?: ProjectCategory
  /** Área de conhecimento (gerada pelo /init) — base do grafo de memórias */
  area?: ProjectArea
}

export interface MemoryEvent {
  action: "created" | "updated" | "removed" | "promoted"
  memory: Memory
}

// ---------------------------------------------------------------------------
// /init — análise inicial do projeto
// ---------------------------------------------------------------------------

export interface InitStatus {
  directory: string
  /** Já existem memórias de projeto (área overview) para esta pasta */
  initialized: boolean
  /** Um init está rodando agora para esta pasta */
  running: boolean
}

export type InitStage = "scanning" | "exploring" | "generating" | "saving" | "done" | "error"

export interface InitEvent {
  directory: string
  stage: InitStage
  /** Progresso dos subagents na fase exploring: workers concluídos/total */
  progress?: { done: number; total: number; area?: ProjectArea }
  /** Preenchido em done: áreas geradas */
  areas?: ProjectArea[]
  error?: string
}

// ---------------------------------------------------------------------------
// Busca léxica (funções puras)
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
  // pt (sem acentos — os textos são normalizados antes)
  "de", "da", "do", "das", "dos", "a", "o", "as", "os", "um", "uma", "uns", "umas",
  "e", "ou", "que", "em", "no", "na", "nos", "nas", "para", "por", "com", "sem",
  "se", "ao", "aos", "e", "sao", "foi", "ser", "tem", "mais", "menos", "muito",
  "como", "mas", "meu", "minha", "seu", "sua", "ele", "ela", "eu", "voce",
  "isso", "isto", "esse", "essa", "este", "esta", "ja", "nao", "sim", "quando",
  "onde", "qual", "quais", "tambem", "sobre", "entre", "ate", "depois", "antes",
  // en
  "the", "an", "and", "or", "of", "to", "in", "on", "at", "for", "with",
  "without", "is", "are", "was", "were", "be", "been", "has", "have", "had",
  "do", "does", "did", "not", "no", "yes", "it", "this", "that", "these",
  "those", "you", "he", "she", "we", "they", "my", "your", "his", "her",
  "their", "our", "as", "by", "from", "but", "if", "so", "than", "then",
  "when", "where", "which", "what", "who", "how", "about", "into", "over",
  "after", "before", "between", "more", "most", "less", "very", "can", "will",
  "just", "also",
])

/** lowercase, sem acentos, espaços colapsados — base do hash de dedup e da busca */
export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

export function tokenize(text: string): string[] {
  return normalizeText(text)
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t))
}

/** Similaridade de Jaccard entre dois conjuntos de tags (normalizadas) */
export function jaccard(a: string[], b: string[]): number {
  const setA = new Set(a.map(normalizeText))
  const setB = new Set(b.map(normalizeText))
  if (setA.size === 0 && setB.size === 0) return 0
  let intersection = 0
  for (const t of setA) if (setB.has(t)) intersection++
  const union = setA.size + setB.size - intersection
  return union === 0 ? 0 : intersection / union
}

/**
 * Score léxico: tag exata ×3, token no texto ×1, + 0.5×weight + boost de hits.
 * Retorna 0 quando nenhum token da consulta bate (memória irrelevante).
 */
export function scoreMemory(memory: Pick<Memory, "text" | "tags" | "weight" | "hits">, queryTokens: string[]): number {
  if (queryTokens.length === 0) return 0
  const text = normalizeText(memory.text)
  const tags = new Set(memory.tags.map(normalizeText))
  let matches = 0
  for (const token of queryTokens) {
    if (tags.has(token)) matches += 3
    else if (text.includes(token)) matches += 1
  }
  if (matches === 0) return 0
  return matches + 0.5 * memory.weight + Math.min(memory.hits / 10, 0.3)
}

/** Ordena um conjunto de memórias por relevância à consulta e recorta o limite. */
export function searchMemories<T extends Memory>(pool: T[], query: string, limit = 8): T[] {
  const tokens = tokenize(query)
  return pool
    .map((memory) => ({ memory, score: scoreMemory(memory, tokens) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => entry.memory)
}
