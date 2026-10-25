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
 * Memória que pertence ao contexto de CÓDIGO e nunca deve aparecer no chat.
 *
 * `kind="project"` é óbvio. O caso sutil é `category="learning"`: ele é
 * gravado com `kind="general"` para poder cruzar de um projeto para outro,
 * mas continua sendo conhecimento técnico produzido no modo código — só o
 * modo código consegue criá-lo (o memory_save do chat nem expõe `category`).
 * Sem esta checagem, os aprendizados vazavam para o canvas do chat, para a
 * busca do chat e para o system prompt do chat.
 */
export function isCodeContext(memory: Pick<Memory, "kind" | "category">): boolean {
  return memory.kind === "project" || memory.category === "learning"
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
  /**
   * Projeto em que a memória foi criada, para kinds que NÃO são "project"
   * (general/core/seasonal). Não isola a memória — ela continua valendo em
   * todos os projetos —, mas ancora o nó perto da árvore de origem no canvas e
   * permite ao filtro esconder aprendizados nascidos em outros projetos.
   */
  originProjectId?: string
  originProjectName?: string
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
  /**
   * Campos de enriquecimento para a busca (todos opcionais; o `text` continua
   * sendo a fonte da verdade). Quem grava a memória — o LLM, via memory_save —
   * pode preenchê-los sem custo extra; quando ausentes, o índice os deriva do
   * texto (ver memory-retrieval.ts). Nunca contêm fatos que o texto não tenha.
   */
  title?: string
  summary?: string
  /** Pessoas, projetos, produtos, lugares e identificadores citados */
  entities?: string[]
  keywords?: string[]
  /** Paráfrases e intenções que devem levar a esta memória (qualquer idioma) */
  concepts?: string[]
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
 * Peso de um token encontrado só no documento anexado. Calibrado no acervo real
 * (307 memórias, 58 com documento) contra 46 consultas que só o `.md` responde e
 * 306 consultas de texto, que servem de controle de regressão:
 *
 *   peso   R@1 (doc)   R@5 (doc)   R@1 (texto)
 *   0.6       56.5%       89.1%        96.7%
 *   0.8       65.2%       97.8%        96.4%
 *   0.9       80.4%       97.8%        96.4%
 *   1.0       87.0%       97.8%        95.8%   ← o texto começa a ceder
 *
 * 0.9 é o joelho: o R@5 satura em 0.8 e dali em diante o que se compra é ordem
 * (R@1), não alcance. Ficar em 1.0 rende mais 6,6 pp no documento, mas custa
 * 1,3 pp nas consultas de texto — e essas são o formato mais próximo de uma
 * pergunta real, enquanto as de documento foram construídas para favorecê-lo.
 */
export const DOC_TOKEN_WEIGHT = 0.9

/**
 * Score léxico: tag exata ×3, token no texto ×1, token no documento anexado ×0.6,
 * + 0.5×weight + boost de hits. O `else if` garante que um token presente nos
 * dois conte uma vez só (vale o texto, que é o sinal mais forte).
 * Retorna 0 quando nenhum token da consulta bate (memória irrelevante).
 */
export function scoreMemory(
  memory: Pick<Memory, "text" | "tags" | "weight" | "hits">,
  queryTokens: string[],
  doc?: string | null,
  docWeight = DOC_TOKEN_WEIGHT,
): number {
  if (queryTokens.length === 0) return 0
  const text = normalizeText(memory.text)
  const body = doc ? normalizeText(doc) : ""
  const tags = new Set(memory.tags.map(normalizeText))
  let matches = 0
  for (const token of queryTokens) {
    if (tags.has(token)) matches += 3
    else if (text.includes(token)) matches += 1
    else if (body.includes(token)) matches += docWeight
  }
  if (matches === 0) return 0
  return matches + 0.5 * memory.weight + Math.min(memory.hits / 10, 0.3)
}

/**
 * Ordena um conjunto de memórias por relevância à consulta e recorta o limite.
 * `docs` leva o documento anexado por id — sem ele o comportamento é o de
 * antes, byte por byte.
 */
export interface SearchOptions {
  /** Documento anexado por id de memória */
  docs?: Map<string, string>
  /** Peso de um token encontrado só no documento (default: DOC_TOKEN_WEIGHT) */
  docWeight?: number
}

export function searchMemories<T extends Memory>(
  pool: T[],
  query: string,
  limit = 8,
  options: SearchOptions = {},
): T[] {
  const tokens = tokenize(query)
  const docWeight = options.docWeight ?? DOC_TOKEN_WEIGHT
  return pool
    .map((memory) => ({ memory, score: scoreMemory(memory, tokens, options.docs?.get(memory.id), docWeight) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => entry.memory)
}
